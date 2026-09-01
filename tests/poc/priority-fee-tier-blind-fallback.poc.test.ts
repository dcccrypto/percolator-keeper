/**
 * PoC for #426 §5.1 (fallback half).
 *
 * `HeliusPriorityFeeEstimator.estimate()` resolves a per-tier percentile on the
 * success path — liquidation/adl p75, crank p50, oracle p25 — but its catch
 * block returns a single flat constant for every tier, with `tier` in scope and
 * unused. So precisely when the fee RPC is degraded, the tier system stops
 * existing: a liquidation bids the same as an oracle push.
 *
 * The harm is under-bidding on the urgent tiers during congestion -> the
 * liquidation lands late or not at all.
 *
 * Note the budget coupling (#396) does NOT make an over-large bid harmless:
 * `budget.canSpend` LATCHES a manual-resume, keeper-wide halt rather than
 * refusing a single send, which is why the override bounds below exist.
 */
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

/** Every tier resolves through the same unreachable RPC, forcing the catch. */
async function fallbackFor(tier: PriorityFeeTier): Promise<number> {
  global.fetch = vi.fn(async () => {
    throw new Error("fee RPC unreachable");
  }) as unknown as typeof fetch;
  const estimator = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });
  return estimator.estimate(["acc1"], tier);
}

describe("#426 §5.1 — priority-fee fallback must stay tier-aware", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("the SUCCESS path differentiates tiers — this is the contract the fallback breaks", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        result: { priorityFeeLevels: { low: 500, medium: 1_000, high: 5_000 } },
      }),
    })) as unknown as typeof fetch;

    const est = new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });
    const liquidation = await est.estimate(["acc1"], "liquidation"); // p75 -> high
    const crank = await est.estimate(["acc1"], "crank"); // p50 -> medium
    const oracle = await est.estimate(["acc1"], "oracle"); // p25 -> low

    expect(liquidation).toBeGreaterThan(crank);
    expect(crank).toBeGreaterThan(oracle);
  });

  it("a liquidation must not fall back to the same bid as an oracle push", async () => {
    const liquidation = await fallbackFor("liquidation");
    const oracle = await fallbackFor("oracle");

    // Pre-fix both are 1_000 and this fails.
    expect(liquidation).toBeGreaterThan(oracle);
  });

  it("the urgent lanes bid above the base lane on the degraded path", async () => {
    const liquidation = await fallbackFor("liquidation");
    const adl = await fallbackFor("adl");
    const crank = await fallbackFor("crank");

    expect(liquidation).toBeGreaterThan(crank);
    expect(adl).toBeGreaterThan(crank);
  });

  it("NO lane regresses below the historical flat 1_000 — including oracle", async () => {
    // oracle is p25 on the success path, but budget.ts counts it a
    // CRITICAL_LANE alongside liquidation and adl. Deriving its fallback
    // straight from the percentile ladder would hand a safety-critical lane
    // the lowest bid in the fleet — strictly worse than the flat constant
    // being replaced. The floor is the point of this test.
    for (const tier of ["liquidation", "adl", "crank", "oracle"] as PriorityFeeTier[]) {
      expect(await fallbackFor(tier)).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("crank's fallback stays exactly 1_000 — the common path is unchanged", async () => {
    expect(await fallbackFor("crank")).toBe(1_000);
  });

  it("oracle's fallback is exactly 1_000 — it coincides with crank BY DESIGN", async () => {
    // Pinned exactly, because "oracle and crank happen to be equal" is precisely
    // the kind of thing a later reader tidies into a derived p25 value. It is
    // held at the floor deliberately: oracle is a budget.ts CRITICAL_LANE.
    expect(await fallbackFor("oracle")).toBe(1_000);
  });

  it("an operator override is honored within bounds", async () => {
    vi.stubEnv("KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION", "20000");
    expect(await fallbackFor("liquidation")).toBe(20_000);
  });

  it("an override BELOW the historical floor is REFUSED", async () => {
    // The floor is the flat 1_000 this change replaces: no lane may end up
    // bidding less than it did before.
    vi.stubEnv("KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION", "999");
    expect(await fallbackFor("liquidation")).toBe(5_000);
  });

  it("a zero override is REFUSED — it would silently disable priority fees", async () => {
    // keeper-send forwards the bid with `??`, which does not coalesce 0, so a
    // zero would reach setComputeUnitPrice, pass the budget gate cleanly, and
    // leave no metric behind.
    vi.stubEnv("KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION", "0");
    expect(await fallbackFor("liquidation")).toBe(5_000);
  });

  it("an absurd override is REFUSED — it would latch a keeper-wide budget halt", async () => {
    // Unbounded, this sits dormant until the fee RPC degrades and then trips
    // budget.ts _halt("cycle-spend-cap"), which is manual-resume and stops
    // every lane, not just this send.
    vi.stubEnv("KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION", "999999999");
    expect(await fallbackFor("liquidation")).toBe(5_000);
  });
});
