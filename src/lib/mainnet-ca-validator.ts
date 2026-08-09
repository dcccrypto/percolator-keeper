import { PublicKey } from "@solana/web3.js";
import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:mainnet-ca");

/** Legacy SPL Token program. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022. Markets collateralised by a Token-2022 mint are legitimate. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Base58, 32–44 chars. Cheap pre-filter before touching the network. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A bare mint is exactly 82 bytes under either token program. */
const MINT_LEN = 82;
/**
 * Token-2022 extended accounts carry an AccountType discriminator at offset 165
 * (the length of a legacy token account); 1 = Mint, 2 = Account. A plain length
 * check cannot separate an extended mint from an extended token account, and
 * both are owned by the same program.
 */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;

/** getMultipleAccountsInfo accepts at most 100 pubkeys per call. */
const MAX_KEYS_PER_CALL = 100;

export interface MainnetCaRow {
  slab_address: string;
  mainnet_ca?: string | null;
}

/**
 * The slice of Connection this needs. Narrow on purpose: the validator must be
 * usable with a MAINNET connection even when the keeper itself runs on devnet,
 * so it takes a reader rather than reaching for getConnection().
 */
export interface MainnetAccountReader {
  getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>;
}

function isMint(info: { owner: PublicKey; data: Uint8Array }): boolean {
  const owner = info.owner.toBase58();
  if (owner !== SPL_TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) return false;
  if (info.data.length === MINT_LEN) return true;
  // Extended Token-2022 mint.
  return (
    owner === TOKEN_2022_PROGRAM_ID &&
    info.data.length > ACCOUNT_TYPE_OFFSET &&
    info.data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT
  );
}

/**
 * Resolve the `mainnet_ca` override for each Supabase market row.
 *
 * KEEPER-9 / #356: `mainnet_ca` is used as the price-lookup key in
 * fraud-detector.ts (`priceMint = state.mainnetCA ?? mint`), so a poisoned row
 * redirects that lookup at an attacker-chosen token.
 *
 * Two properties are load-bearing:
 *
 * 1. Validation runs against MAINNET, supplied by the caller. `mainnet_ca`
 *    exists only for devnet mirror-mint markets, so validating against the
 *    keeper's own connection would look a mainnet mint up on devnet, find
 *    nothing, and reject every override — disabling the feature.
 *
 * 2. Failures are isolated per row, and an RPC failure degrades to the
 *    base58-only check rather than dropping every override. Dropping them sends
 *    the price lookup to a devnet mirror mint with no liquidity, so the market
 *    ages into staleness and stops cranking — a worse outcome than the threat.
 */
export async function resolveMainnetCAs(
  rows: MainnetCaRow[],
  opts: { reader: MainnetAccountReader | null },
): Promise<Map<string, { mainnetCA?: string }>> {
  const out = new Map<string, { mainnetCA?: string }>();
  const candidates: Array<{ slabAddress: string; ca: string; key: PublicKey }> = [];

  for (const row of rows) {
    const ca = row.mainnet_ca ?? undefined;
    if (!ca) {
      out.set(row.slab_address, {});
      continue;
    }
    if (!BASE58_RE.test(ca)) {
      logger.warn("Invalid mainnet_ca from Supabase (bad base58), ignoring field", {
        slabAddress: row.slab_address,
        mainnetCA: ca,
      });
      out.set(row.slab_address, {});
      continue;
    }
    // Per-row: a string can satisfy the regex and still not decode to 32 bytes.
    // One such row must not cost every other row its override.
    let key: PublicKey;
    try {
      key = new PublicKey(ca);
    } catch {
      logger.warn("Invalid mainnet_ca from Supabase (not a valid pubkey), ignoring field", {
        slabAddress: row.slab_address,
        mainnetCA: ca,
      });
      out.set(row.slab_address, {});
      continue;
    }
    candidates.push({ slabAddress: row.slab_address, ca, key });
  }

  if (candidates.length === 0) return out;

  if (!opts.reader) {
    // No mainnet endpoint configured — base58 validation only. Logged once per
    // discovery cycle rather than per row.
    logger.warn(
      "MAINNET_RPC_URL is not set — mainnet_ca values are format-checked but not " +
        "verified on-chain. Set it to validate that each override is a real SPL " +
        "Token / Token-2022 mint (see .env.example).",
      { unverified: candidates.length },
    );
    for (const c of candidates) out.set(c.slabAddress, { mainnetCA: c.ca });
    return out;
  }

  for (let i = 0; i < candidates.length; i += MAX_KEYS_PER_CALL) {
    const chunk = candidates.slice(i, i + MAX_KEYS_PER_CALL);
    let infos: Array<{ owner: PublicKey; data: Uint8Array } | null>;
    try {
      infos = await opts.reader.getMultipleAccountsInfo(chunk.map((c) => c.key));
    } catch (err) {
      logger.warn(
        "mainnet_ca on-chain verification failed for this chunk — falling back to " +
          "the format check rather than dropping the overrides",
        { error: err instanceof Error ? err.message : String(err), chunk: chunk.length },
      );
      for (const c of chunk) out.set(c.slabAddress, { mainnetCA: c.ca });
      continue;
    }

    for (let j = 0; j < chunk.length; j++) {
      const c = chunk[j]!;
      const info = infos[j];
      if (!info || !isMint(info)) {
        logger.warn("mainnet_ca is not a token mint on mainnet — ignoring override", {
          slabAddress: c.slabAddress,
          mainnetCA: c.ca,
          actualOwner: info?.owner.toBase58() ?? "not found",
          dataLen: info?.data.length ?? 0,
        });
        out.set(c.slabAddress, {});
      } else {
        out.set(c.slabAddress, { mainnetCA: c.ca });
      }
    }
  }

  return out;
}
