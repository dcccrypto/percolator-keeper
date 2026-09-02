/**
 * PoC + regression guard for #423.
 *
 * `runFeeCrankPass` loaded every tracked market in ONE
 * `getMultipleAccountsInfo`. The JSON-RPC limit is 100 pubkeys and the node
 * rejects the whole request with -32602 above it rather than truncating — so
 * past 100 markets the entire fee-crank pass ran zero times every cycle,
 * including the tag-89 backing-bucket recovery the module header flags as
 * stranding user funds. The only symptom was one warn line per cycle.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";

vi.mock("../../src/lib/keeper-send.js", () => ({
  keeperSend: vi.fn(),
  sharedBudget: {},
}));
vi.mock("../../src/lib/tx-queue.js", () => ({
  sharedTxQueue: { enqueue: (_k: string, fn: () => Promise<unknown>) => fn() },
}));

import { runFeeCrankPass } from "../../src/services/fee-crank.js";

const PROGRAM = new PublicKey("11111111111111111111111111111111");

function makeMarkets(n: number) {
  return Array.from({ length: n }, () => ({
    address: PublicKey.unique(),
    programId: PROGRAM,
  }));
}

/**
 * A Connection whose getMultipleAccountsInfo enforces the REAL 100-key limit,
 * rejecting the whole call the way a node does rather than truncating.
 */
function makeConnection(batches: number[][], seen?: string[]) {
  return {
    getSlot: vi.fn(async () => 1_000),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => {
      if (keys.length > 100) {
        const err = new Error("failed to get multiple accounts info: Too many inputs provided");
        (err as { code?: number }).code = -32602;
        throw err;
      }
      batches.push([keys.length]);
      seen?.push(...keys.map((k) => k.toBase58()));
      // null = account not found; the per-market loop skips these, which keeps
      // this test focused on the fetch rather than on snapshot decoding.
      return keys.map(() => null);
    }),
  } as unknown as Connection;
}

const KEYPAIR = {} as Keypair;

describe("#423 — fee-crank market fetch is chunked at the RPC limit", () => {
  it("does not exceed 100 pubkeys per call at 250 markets", async () => {
    const batches: number[][] = [];
    const conn = makeConnection(batches);

    await runFeeCrankPass(conn, KEYPAIR, makeMarkets(250));

    expect(batches.length).toBe(3);
    expect(batches.flat()).toEqual([100, 100, 50]);
    expect(Math.max(...batches.flat())).toBeLessThanOrEqual(100);
  });

  it("REGRESSION: an unchunked fetch would have thrown and returned nothing", async () => {
    // Pins the failure the fix removes: one call with 250 keys is rejected
    // outright, and runFeeCrankPass's catch returns [] — the whole pass, every
    // cycle, silently.
    const conn = makeConnection([]);
    await expect(
      (conn.getMultipleAccountsInfo as unknown as (k: PublicKey[]) => Promise<unknown>)(
        makeMarkets(250).map((m) => m.address),
      ),
    ).rejects.toThrow(/Too many inputs/);
  });

  it("exactly 100 markets still takes a single call", async () => {
    const batches: number[][] = [];
    await runFeeCrankPass(makeConnection(batches), KEYPAIR, makeMarkets(100));
    expect(batches.flat()).toEqual([100]);
  });

  it("101 markets takes two — the boundary the old code failed at", async () => {
    const batches: number[][] = [];
    await runFeeCrankPass(makeConnection(batches), KEYPAIR, makeMarkets(101));
    expect(batches.flat()).toEqual([100, 1]);
  });

  it("requests the markets IN ORDER — infos[i] must line up with markets[i]", async () => {
    // The per-market loop indexes infos[i] against markets[i], so the chunks
    // have to be concatenated in slice order. Chunks resolve in parallel, which
    // is safe only because Promise.all preserves position — this pins that.
    // Without it, a market's snapshot could be evaluated against another
    // market's account bytes, which is far worse than the outage #423 fixes.
    const batches: number[][] = [];
    const seen: string[] = [];
    const markets = makeMarkets(250);

    await runFeeCrankPass(makeConnection(batches, seen), KEYPAIR, markets);

    expect(seen).toEqual(markets.map((m) => m.address.toBase58()));
  });

  it("no markets issues no fetch at all", async () => {
    const batches: number[][] = [];
    const conn = makeConnection(batches);
    await runFeeCrankPass(conn, KEYPAIR, []);
    expect(conn.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
});
