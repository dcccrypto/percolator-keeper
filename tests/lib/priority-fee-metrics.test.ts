import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch before importing the estimator so network calls never leave the process.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { HeliusPriorityFeeEstimator } from "../../src/lib/priority-fee.js";
import {
  priorityFeeEstimateTotal,
  priorityFeeMicrolamports,
  getRegistry,
} from "../../src/lib/metrics.js";

// Include all common level keys so the estimator can find whichever it requests
// (level is resolved from tier+percentile: crank=50→medium, oracle=25→low,
//  liquidation=75→high, adl=75→high).
function makeHeliusResponse(fee: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        priorityFeeLevels: {
          min: fee,
          low: fee,
          medium: fee,
          high: fee,
          veryHigh: fee,
        },
      },
    }),
  } as unknown as Response;
}

describe("HeliusPriorityFeeEstimator — metric wiring", () => {
  let estimator: HeliusPriorityFeeEstimator;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use a tiny cache TTL so consecutive calls within a test don't serve cached values.
    estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });
  });

  it("increments priorityFeeEstimateTotal once per estimate() call", async () => {
    mockFetch.mockResolvedValue(makeHeliusResponse(5_000));

    const before = (await priorityFeeEstimateTotal.get()).values;
    const prevCrank = before.find((v) => v.labels.tier === "crank")?.value ?? 0;

    await estimator.estimate(["AaAaAa11111111111111111111111111111111111111"], "crank");

    const after = (await priorityFeeEstimateTotal.get()).values;
    const nextCrank = after.find((v) => v.labels.tier === "crank")?.value ?? 0;
    expect(nextCrank).toBe(prevCrank + 1);
  });

  it("increments priorityFeeEstimateTotal per tier correctly", async () => {
    mockFetch.mockResolvedValue(makeHeliusResponse(10_000));

    const before = (await priorityFeeEstimateTotal.get()).values;
    const prevLiquidation = before.find((v) => v.labels.tier === "liquidation")?.value ?? 0;

    await estimator.estimate(["BbBbBb11111111111111111111111111111111111111"], "liquidation");

    const after = (await priorityFeeEstimateTotal.get()).values;
    const nextLiquidation = after.find((v) => v.labels.tier === "liquidation")?.value ?? 0;
    expect(nextLiquidation).toBe(prevLiquidation + 1);
  });

  it("also increments counter on cache hit", async () => {
    // Use a non-zero cache TTL so second call hits cache.
    const cachedEstimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 60_000 });
    mockFetch.mockResolvedValue(makeHeliusResponse(3_000));

    const before = (await priorityFeeEstimateTotal.get()).values;
    const prevOracle = before.find((v) => v.labels.tier === "oracle")?.value ?? 0;

    const keys = ["CcCcCc11111111111111111111111111111111111111"];
    await cachedEstimator.estimate(keys, "oracle"); // network call — populates cache
    await cachedEstimator.estimate(keys, "oracle"); // cache hit

    const after = (await priorityFeeEstimateTotal.get()).values;
    const nextOracle = after.find((v) => v.labels.tier === "oracle")?.value ?? 0;
    expect(nextOracle).toBe(prevOracle + 2);
  });

  it("sets priorityFeeMicrolamports gauge with non-trivial fee", async () => {
    const feeValue = 7_500;
    mockFetch.mockResolvedValue(makeHeliusResponse(feeValue));

    const keys = ["DdDdDd11111111111111111111111111111111111111"];
    await estimator.estimate(keys, "adl");

    const result = await priorityFeeMicrolamports.get();
    // At least one label-set should have the fee value we set.
    const match = result.values.find((v) => v.labels.tier === "adl" && v.value === feeValue);
    expect(match).toBeDefined();
  });

  it("does NOT set priorityFeeMicrolamports when fee is 0", async () => {
    mockFetch.mockResolvedValue(makeHeliusResponse(0));

    const before = (await priorityFeeMicrolamports.get()).values;
    const zeroKeys = ["EeEeEe11111111111111111111111111111111111111"];
    // Snapshot before
    const beforeCount = before.length;

    await estimator.estimate(zeroKeys, "crank");

    const after = (await priorityFeeMicrolamports.get()).values;
    // Zero-fee should not add a new label set (gauge count stays the same
    // OR doesn't contain a record with value 0 for this specific hash).
    const zeroEntry = after.find(
      (v) => v.labels.tier === "crank" && v.value === 0,
    );
    // The gauge should not have been set to 0 by a zero-fee estimate.
    expect(zeroEntry).toBeUndefined();
  });

  it("falls back to FALLBACK_MICROLAMPORTS on fetch error — counter still increments", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"));

    const before = (await priorityFeeEstimateTotal.get()).values;
    const prevAdl = before.find((v) => v.labels.tier === "adl")?.value ?? 0;

    const fee = await estimator.estimate(["FfFfFf11111111111111111111111111111111111111"], "adl");
    expect(fee).toBe(1_000); // FALLBACK_MICROLAMPORTS

    const after = (await priorityFeeEstimateTotal.get()).values;
    const nextAdl = after.find((v) => v.labels.tier === "adl")?.value ?? 0;
    expect(nextAdl).toBe(prevAdl + 1);
  });
});
