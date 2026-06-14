import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const PYTH_PDA = PublicKey.unique();

vi.mock("@percolatorct/sdk", () => ({
  derivePythPushOraclePDA: vi.fn(() => [PYTH_PDA, 0]),
}));
vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import {
  resolveExternalOracleAccount,
  CHAINLINK_OCR2_PROGRAM_ID,
  _resetOracleAccountCache,
} from "../../src/lib/oracle-account.js";

const FEED = new PublicKey("Cv4T27XbjVoKUYwP72NQQanvZeA7W4YF9L4EnYT9kx5o"); // Chainlink aggregator / Pyth feed id
const OTHER_OWNER = PublicKey.unique();

/** Build a fake Connection whose getAccountInfo is a spy with the given behavior. */
function fakeConn(getAccountInfo: any) {
  return { getAccountInfo } as any;
}

describe("resolveExternalOracleAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOracleAccountCache();
  });

  it("pins to the program's CHAINLINK_OCR2 program id", () => {
    expect(CHAINLINK_OCR2_PROGRAM_ID.toBase58()).toBe("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
  });

  it("Chainlink owner → returns index_feed_id (the aggregator account)", async () => {
    const conn = fakeConn(vi.fn(async () => ({ owner: CHAINLINK_OCR2_PROGRAM_ID, data: new Uint8Array(0) })));
    const acct = await resolveExternalOracleAccount(FEED, conn);
    expect(acct.toBase58()).toBe(FEED.toBase58());
  });

  it("null account (a Pyth feed id is not an account) → derives the Pyth Push PDA", async () => {
    const conn = fakeConn(vi.fn(async () => null));
    const acct = await resolveExternalOracleAccount(FEED, conn);
    expect(acct.toBase58()).toBe(PYTH_PDA.toBase58());
  });

  it("some unrelated owner → derives the Pyth Push PDA (safe default)", async () => {
    const conn = fakeConn(vi.fn(async () => ({ owner: OTHER_OWNER, data: new Uint8Array(0) })));
    const acct = await resolveExternalOracleAccount(FEED, conn);
    expect(acct.toBase58()).toBe(PYTH_PDA.toBase58());
  });

  it("caches a positive verdict — getAccountInfo is called once across repeated resolves", async () => {
    const spy = vi.fn(async () => ({ owner: CHAINLINK_OCR2_PROGRAM_ID, data: new Uint8Array(0) }));
    const conn = fakeConn(spy);
    await resolveExternalOracleAccount(FEED, conn);
    await resolveExternalOracleAccount(FEED, conn);
    await resolveExternalOracleAccount(FEED, conn);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("RPC error → falls back to Pyth PDA and does NOT cache (self-heals on retry)", async () => {
    let call = 0;
    const conn = fakeConn(vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("RPC down");
      return { owner: CHAINLINK_OCR2_PROGRAM_ID, data: new Uint8Array(0) };
    }));

    const first = await resolveExternalOracleAccount(FEED, conn);
    expect(first.toBase58()).toBe(PYTH_PDA.toBase58()); // fallback

    // The failure was not cached: the next resolve re-fetches and now sees Chainlink.
    const second = await resolveExternalOracleAccount(FEED, conn);
    expect(second.toBase58()).toBe(FEED.toBase58());
  });
});
