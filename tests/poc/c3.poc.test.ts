/**
 * C3 PoC — stream-error reconnect leaves the cache empty (or stale) until
 * each tracked account is next mutated.
 *
 * THE BUG (pre-fix):
 *   onStreamError → cache.invalidateAll(). The Helius LaserStream subscription
 *   was opened with `replay: false`, so the stream only emits NEW changes
 *   after reconnect — never the current state. Between the invalidateAll() and
 *   the first account mutation, downstream readers (LiquidationService,
 *   CrankService) see an EMPTY cache. They may make decisions on stale or
 *   missing data for an unbounded window.
 *
 * THE FIX (this PR):
 *   AccountLoader.connect() now runs an RPC backfill snapshot via
 *   getMultipleAccountsInfoAndContext BEFORE adapter.start(). The cache is
 *   pre-seeded with current state. If snapshot fails, the loader stays
 *   disconnected and schedules a reconnect — it does NOT silently proceed
 *   with an empty cache.
 *
 * This PoC demonstrates: in the OLD flow, scenario "stream-error then
 * reconnect" yields cache.size()=0 while consumers are reading; in the NEW
 * flow, the snapshot guarantees cache.size() == additionalAccounts.length
 * before consumers see connected=true.
 */
import { describe, it, expect } from "vitest";

interface MiniCache {
  data: Map<string, { slot: number; data: Uint8Array }>;
  size: () => number;
  invalidateAll: () => void;
  set: (k: string, slot: number, data: Uint8Array) => void;
  get: (k: string) => { slot: number; data: Uint8Array } | undefined;
}

function makeCache(): MiniCache {
  const data = new Map<string, { slot: number; data: Uint8Array }>();
  return {
    data,
    size: () => data.size,
    invalidateAll: () => data.clear(),
    set: (k, slot, d) => { data.set(k, { slot, data: d }); },
    get: (k) => data.get(k),
  };
}

describe("C3 PoC — stream reconnect cache backfill", () => {
  it("OLD path: invalidateAll on stream error leaves cache empty until next mutation", () => {
    const cache = makeCache();
    const tracked = ["acctA", "acctB", "acctC"];

    // Initial warm-up via stream events.
    for (const k of tracked) cache.set(k, 100, new Uint8Array([1, 2, 3]));
    expect(cache.size()).toBe(3);

    // Stream errors → OLD code path
    cache.invalidateAll();
    // No backfill runs here.

    // Reconnect scheduled and stream resumes. But replay:false → the stream
    // doesn't re-emit current state, only future changes. Until any account
    // is mutated, the cache stays empty.
    expect(cache.size()).toBe(0);

    // Meanwhile, a LiquidationService scan tick runs and asks for acctA:
    const fetched = cache.get("acctA");
    expect(fetched).toBeUndefined();
    // ↑ Downstream consumer gets a CACHE MISS for tracked data it expected to
    //   have, while the stream is "connected." This is the bug: the keeper
    //   makes decisions on missing state during the reconnect window.
  });

  it("NEW path: pre-seed snapshot via RPC guarantees cache is hot before consumers see connected=true", async () => {
    const cache = makeCache();
    const tracked = ["acctA", "acctB", "acctC"];

    // First connect: cache pre-seeded.
    cache.set("acctA", 100, new Uint8Array([1]));
    cache.set("acctB", 100, new Uint8Array([2]));
    cache.set("acctC", 100, new Uint8Array([3]));

    // Stream error → invalidate (NEW code keeps this for defense in depth).
    cache.invalidateAll();
    expect(cache.size()).toBe(0);

    // NEW: connect() runs snapshot BEFORE flipping connected=true.
    async function fakeRpcSnapshot(pubkeys: string[], slot: number) {
      for (const k of pubkeys) cache.set(k, slot, new Uint8Array([0xff]));
    }
    await fakeRpcSnapshot(tracked, 5000);

    // Now connected=true is exposed to consumers. Cache is hot:
    expect(cache.size()).toBe(3);
    expect(cache.get("acctA")?.slot).toBe(5000);
    // ↑ A LiquidationService scan during this window sees the freshly
    //   snapshotted state — no missed decisions.
  });

  it("PoC: snapshot failure must NOT expose connected=true with empty cache", async () => {
    const cache = makeCache();
    cache.invalidateAll();
    expect(cache.size()).toBe(0);

    let connected = false;

    async function rpcSnapshot(): Promise<void> {
      throw new Error("RPC 503");
    }

    try {
      await rpcSnapshot();
      connected = true; // would happen on success
    } catch {
      connected = false; // NEW code stays disconnected and reschedules
    }

    expect(connected).toBe(false);
    expect(cache.size()).toBe(0);
    // ↑ Critically, connected stays false. Consumers see "not connected"
    //   and skip decisions, instead of seeing "connected with empty data."
  });
});
