import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  resolveMainnetCAs,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type MainnetAccountReader,
} from "../../src/lib/mainnet-ca-validator.js";

/**
 * KEEPER-9 / #356: `mainnet_ca` comes from Supabase and is used unvalidated as
 * the price-lookup key for a market (fraud-detector.ts: `priceMint =
 * state.mainnetCA ?? mint`). A poisoned row redirects that lookup to an
 * attacker-chosen token.
 *
 * Validation has to run against MAINNET, which is the part the original fix got
 * wrong: it used getConnection(), the keeper's own network. `mainnetCA` exists
 * only for devnet mirror-mint markets, so on the only deployment that uses the
 * field the lookup ran against devnet, found nothing, and dropped every
 * override -- disabling the feature it was meant to protect.
 */

const REAL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "So11111111111111111111111111111111111111112";

const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

/** A bare mint: exactly 82 bytes under either token program. */
function mint(owner: string) {
  return { owner: new PublicKey(owner), data: new Uint8Array(MINT_LEN) };
}

/** A Token-2022 mint carrying extensions: >165 bytes with AccountType::Mint (1) at 165. */
function extendedMint(owner: string) {
  const data = new Uint8Array(200);
  data[TOKEN_ACCOUNT_LEN] = 1;
  return { owner: new PublicKey(owner), data };
}

/** A token ACCOUNT — same program owner as a mint, so ownership alone won't do. */
function tokenAccount(owner: string) {
  return { owner: new PublicKey(owner), data: new Uint8Array(TOKEN_ACCOUNT_LEN) };
}

function reader(
  impl: (keys: PublicKey[]) => Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>,
): MainnetAccountReader {
  return { getMultipleAccountsInfo: vi.fn(impl) };
}

describe("resolveMainnetCAs", () => {
  describe("without a mainnet reader (MAINNET_RPC_URL unset)", () => {
    it("keeps base58-valid overrides and makes no RPC call at all", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: null },
      );
      expect(out.get("slabA")).toEqual({ mainnetCA: REAL_MINT });
    });

    it("still rejects a malformed mainnet_ca", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: "not-base58-!!!" }],
        { reader: null },
      );
      expect(out.get("slabA")).toEqual({});
    });
  });

  describe("with a mainnet reader", () => {
    it("accepts a legacy SPL Token mint", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [mint(SPL_TOKEN_PROGRAM_ID)]) },
      );
      expect(out.get("slabA")).toEqual({ mainnetCA: REAL_MINT });
    });

    it("accepts a Token-2022 mint", async () => {
      // Rejecting Token-2022 would silently disable price lookups for any market
      // collateralised by one.
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [mint(TOKEN_2022_PROGRAM_ID)]) },
      );
      expect(out.get("slabA")).toEqual({ mainnetCA: REAL_MINT });
    });

    it("accepts a Token-2022 mint carrying extensions", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [extendedMint(TOKEN_2022_PROGRAM_ID)]) },
      );
      expect(out.get("slabA")).toEqual({ mainnetCA: REAL_MINT });
    });

    it("rejects an address owned by some other program", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [mint("11111111111111111111111111111111")]) },
      );
      expect(out.get("slabA")).toEqual({});
    });

    it("rejects a token ACCOUNT masquerading as a mint", async () => {
      // Token accounts are owned by the same program as mints, so checking
      // program ownership alone would let a poisoned row pointing at any token
      // account through. The layout has to be a mint.
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [tokenAccount(SPL_TOKEN_PROGRAM_ID)]) },
      );
      expect(out.get("slabA")).toEqual({});
    });

    it("rejects an address that does not exist on mainnet", async () => {
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        { reader: reader(async () => [null]) },
      );
      expect(out.get("slabA")).toEqual({});
    });

    it("isolates a bad row instead of discarding every other row", async () => {
      // The original fix replaced per-field validation ("M3: validate each field
      // independently -- don't discard the entire row when only one field is
      // invalid") with a single try that dropped all overrides on any error.
      const out = await resolveMainnetCAs(
        [
          { slab_address: "bad", mainnet_ca: "###not-base58###" },
          { slab_address: "good", mainnet_ca: REAL_MINT },
        ],
        { reader: reader(async () => [mint(SPL_TOKEN_PROGRAM_ID)]) },
      );
      expect(out.get("bad")).toEqual({});
      expect(out.get("good")).toEqual({ mainnetCA: REAL_MINT });
    });

    it("chunks requests to the 100-pubkey getMultipleAccountsInfo limit", async () => {
      const seen: number[] = [];
      const r = reader(async (keys) => {
        seen.push(keys.length);
        return keys.map(() => mint(SPL_TOKEN_PROGRAM_ID));
      });
      const rows = Array.from({ length: 250 }, (_, i) => ({
        slab_address: `slab${i}`,
        mainnet_ca: i % 2 === 0 ? REAL_MINT : OTHER_MINT,
      }));

      await resolveMainnetCAs(rows, { reader: r });

      expect(seen).toEqual([100, 100, 50]);
    });

    it("falls back to base58-only rather than dropping overrides when the RPC fails", async () => {
      // An RPC blip must not gate cranks. Dropping the override sends the price
      // lookup to the devnet mirror mint, which has no liquidity -- the market
      // ages into staleness and stops cranking, which is worse than the threat
      // being defended against.
      const out = await resolveMainnetCAs(
        [{ slab_address: "slabA", mainnet_ca: REAL_MINT }],
        {
          reader: reader(async () => {
            throw new Error("429 Too Many Requests");
          }),
        },
      );
      expect(out.get("slabA")).toEqual({ mainnetCA: REAL_MINT });
    });
  });

  it("maps a row with no mainnet_ca to an empty entry", async () => {
    const out = await resolveMainnetCAs(
      [{ slab_address: "slabA", mainnet_ca: null }],
      { reader: null },
    );
    expect(out.get("slabA")).toEqual({});
  });
});
