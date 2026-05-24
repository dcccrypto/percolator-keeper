import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { HeliusPriorityFeeEstimator } from "../../src/lib/priority-fee.js";
import type { PriorityFeeTier } from "../../src/lib/priority-fee.js";

function mockFetch(response: object, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => response,
  })) as unknown as typeof fetch;
}

const HELIUS_SUCCESS_RESPONSE = {
  result: {
    priorityFeeLevels: {
      min: 100,
      low: 500,
      medium: 1_000,
      high: 5_000,
      veryHigh: 10_000,
    },
  },
};

describe("HeliusPriorityFeeEstimator", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns p50 (medium) fee for crank tier", async () => {
    global.fetch = mockFetch(HELIUS_SUCCESS_RESPONSE);
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1", "acc2"], "crank");

    expect(result).toBe(1_000); // medium = p50
  });

  it("returns p75 (high) fee for liquidation tier", async () => {
    global.fetch = mockFetch(HELIUS_SUCCESS_RESPONSE);
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1"], "liquidation");

    expect(result).toBe(5_000); // high = p75
  });

  it("returns p25 (low) fee for oracle tier", async () => {
    global.fetch = mockFetch(HELIUS_SUCCESS_RESPONSE);
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1"], "oracle");

    expect(result).toBe(500); // low = p25
  });

  it("returns fallback (1000) when fetch throws", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network error"); }) as any;
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1"], "crank");

    expect(result).toBe(1_000); // fallback
  });

  it("returns fallback when response is not ok", async () => {
    global.fetch = mockFetch({}, false, 500);
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1"], "crank");

    expect(result).toBe(1_000);
  });

  it("returns fallback when response has malformed priorityFeeLevels", async () => {
    global.fetch = mockFetch({ result: { priorityFeeLevels: null } });
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

    const result = await estimator.estimate(["acc1"], "crank");

    expect(result).toBe(1_000);
  });

  it("caches results for cacheMs duration and returns cached value without additional fetch", async () => {
    vi.useFakeTimers();
    const fetchFn = mockFetch(HELIUS_SUCCESS_RESPONSE);
    global.fetch = fetchFn;
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 5_000 });

    await estimator.estimate(["acc1"], "crank");
    await estimator.estimate(["acc1"], "crank");

    // Only one real fetch call — second was served from cache
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache expires", async () => {
    vi.useFakeTimers();
    const fetchFn = mockFetch(HELIUS_SUCCESS_RESPONSE);
    global.fetch = fetchFn;
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 1_000 });

    await estimator.estimate(["acc1"], "crank");
    vi.advanceTimersByTime(1_001);
    await estimator.estimate(["acc1"], "crank");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("different account-key sets have separate cache entries", async () => {
    const fetchFn = mockFetch(HELIUS_SUCCESS_RESPONSE);
    global.fetch = fetchFn;
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 60_000 });

    await estimator.estimate(["acc1"], "crank");
    await estimator.estimate(["acc2"], "crank");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("different tiers have separate cache entries for same account keys", async () => {
    const fetchFn = mockFetch(HELIUS_SUCCESS_RESPONSE);
    global.fetch = fetchFn;
    const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 60_000 });

    await estimator.estimate(["acc1"], "crank");
    await estimator.estimate(["acc1"], "liquidation");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reads percentile overrides from env", async () => {
    const origEnv = process.env.KEEPER_PRIORITY_FEE_PERCENTILE_CRANK;
    // Override crank to p95 (veryHigh)
    process.env.KEEPER_PRIORITY_FEE_PERCENTILE_CRANK = "95";
    try {
      global.fetch = mockFetch(HELIUS_SUCCESS_RESPONSE);
      const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });

      const result = await estimator.estimate(["acc1"], "crank");

      expect(result).toBe(10_000); // veryHigh = p95
    } finally {
      if (origEnv === undefined) delete process.env.KEEPER_PRIORITY_FEE_PERCENTILE_CRANK;
      else process.env.KEEPER_PRIORITY_FEE_PERCENTILE_CRANK = origEnv;
    }
  });
});
