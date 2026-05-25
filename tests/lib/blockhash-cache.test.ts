import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { BlockhashCache } from "../../src/lib/blockhash-cache.js";

function makeConnection(overrides: Partial<{
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getSlot: () => Promise<number>;
}> = {}) {
  return {
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "mockblockhash11111111111111111111111111",
      lastValidBlockHeight: 999_999,
    })),
    getSlot: vi.fn(async () => 100),
    ...overrides,
  } as any;
}

describe("BlockhashCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("getAsync fetches on first call and returns the cached value", async () => {
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 2_000, maxSlotsReuse: 60 });

    const result = await cache.getAsync();

    expect(result.blockhash).toBe("mockblockhash11111111111111111111111111");
    expect(result.lastValidBlockHeight).toBe(999_999);
    expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it("get() throws if cache is empty", () => {
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 2_000, maxSlotsReuse: 60 });

    expect(() => cache.get()).toThrow("BlockhashCache");
  });

  it("get() returns cached value after getAsync populates it", async () => {
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 2_000, maxSlotsReuse: 60 });

    await cache.getAsync();
    const result = cache.get();

    expect(result.blockhash).toBe("mockblockhash11111111111111111111111111");
    expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent getAsync calls into a single RPC fetch", async () => {
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 2_000, maxSlotsReuse: 60 });

    const [r1, r2, r3] = await Promise.all([
      cache.getAsync(),
      cache.getAsync(),
      cache.getAsync(),
    ]);

    expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
    expect(r1.blockhash).toBe(r2.blockhash);
    expect(r2.blockhash).toBe(r3.blockhash);
  });

  it("re-fetches after maxSlotsReuse window elapses", async () => {
    vi.useFakeTimers();
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 2_000, maxSlotsReuse: 1 });

    await cache.getAsync();
    expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(1);

    // Advance by 1 slot = 400ms + 1ms to exceed the 1-slot reuse window
    vi.advanceTimersByTime(401);

    await cache.getAsync();
    expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("start/stop controls background refresh timer", async () => {
    vi.useFakeTimers();
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 500, maxSlotsReuse: 60 });

    cache.start();
    await vi.advanceTimersByTimeAsync(1_600);

    // ~3 interval ticks have fired (0ms start is not a tick, but 500ms, 1000ms, 1500ms are)
    expect(conn.getLatestBlockhash).toBeGreaterThanOrEqual !== undefined;
    const callCount = conn.getLatestBlockhash.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(3);

    cache.stop();
    const countAfterStop = conn.getLatestBlockhash.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2_000);
    // No new calls after stop()
    expect(conn.getLatestBlockhash.mock.calls.length).toBe(countAfterStop);
  });

  it("start() is idempotent — second call does not create a second timer", async () => {
    vi.useFakeTimers();
    const conn = makeConnection();
    const cache = new BlockhashCache(conn, { refreshMs: 500, maxSlotsReuse: 60 });

    cache.start();
    cache.start();
    await vi.advanceTimersByTimeAsync(600);

    // Only one timer running → at most one refresh in 600ms window
    expect(conn.getLatestBlockhash.mock.calls.length).toBeLessThanOrEqual(1);

    cache.stop();
  });

  // A.11 (MED): the existing 3-caller coalesce test proves the lock works
  // for trivial concurrency; the brief specified 1k. Catches regressions
  // where someone "optimizes" away the in-flight promise share.
  it.skipIf(!process.env.STRESS)(
    "A.11 STRESS: 1000 concurrent getAsync() calls produce a single RPC fetch",
    { timeout: 15_000 },
    async () => {
      const conn = makeConnection();
      const cache = new BlockhashCache(conn, { refreshMs: 60_000, maxSlotsReuse: 60 });

      const results = await Promise.all(
        Array.from({ length: 1000 }, () => cache.getAsync()),
      );

      expect(conn.getLatestBlockhash).toHaveBeenCalledTimes(1);
      // Every caller saw the same blockhash.
      const uniq = new Set(results.map((r) => r.blockhash));
      expect(uniq.size).toBe(1);
    },
  );

  it("reads KEEPER_BLOCKHASH_CACHE_MS and KEEPER_BLOCKHASH_MAX_SLOTS_REUSE from env", () => {
    const origCache = process.env.KEEPER_BLOCKHASH_CACHE_MS;
    const origSlots = process.env.KEEPER_BLOCKHASH_MAX_SLOTS_REUSE;
    process.env.KEEPER_BLOCKHASH_CACHE_MS = "1234";
    process.env.KEEPER_BLOCKHASH_MAX_SLOTS_REUSE = "30";
    try {
      const conn = makeConnection();
      const cache = new BlockhashCache(conn);
      // Internal fields — cast to access for testing
      expect((cache as any)._refreshMs).toBe(1234);
      expect((cache as any)._maxSlotsReuse).toBe(30);
    } finally {
      if (origCache === undefined) delete process.env.KEEPER_BLOCKHASH_CACHE_MS;
      else process.env.KEEPER_BLOCKHASH_CACHE_MS = origCache;
      if (origSlots === undefined) delete process.env.KEEPER_BLOCKHASH_MAX_SLOTS_REUSE;
      else process.env.KEEPER_BLOCKHASH_MAX_SLOTS_REUSE = origSlots;
    }
  });
});
