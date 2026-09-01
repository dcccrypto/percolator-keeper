/**
 * PoC for #350 — an unclamped priority-fee estimate latches the budget
 * circuit breaker, halting the keeper process-wide.
 *
 * Chain, end to end:
 *   1. `HeliusPriorityFeeEstimator.estimate()` validates `fee >= 0` but applies
 *      NO upper bound, so it returns whatever the fee RPC reports.
 *   2. `estimateLamportCost` turns that into a per-tx lamport cost.
 *   3. `KeeperBudget.canSpend` compares `_cycleSpend + lamports` against
 *      `maxSolPerCycle` and, on breach, calls `_halt("cycle-spend-cap")` --
 *      LATCHING, manual-resume-only.
 *
 * The critical detail is that step 3 fires with `_cycleSpend === 0`: nothing
 * has actually been overspent. A single expensive PROPOSAL is enough, and it
 * takes every other lane down with it. No attacker is required -- the fee RPC
 * is operator-trusted, and a transient congestion spike is the trigger.
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

import {
  HeliusPriorityFeeEstimator,
  PRIORITY_FEE_ESTIMATE_MAX,
} from "../../src/lib/priority-fee.js";
import { estimateLamportCost } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";

/** The CU ceiling the estimator can produce: 1.4M fallback, x1.1 sim margin. */
const MAX_CU = 1_540_000;
const CYCLE_CAP = 50_000_000; // KeeperBudget DEFAULTS.maxSolPerCycle

function estimatorReturning(fee: number): HeliusPriorityFeeEstimator {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ result: { priorityFeeLevels: { high: fee } } }),
  })) as unknown as typeof fetch;
  return new HeliusPriorityFeeEstimator("https://rpc.example.com", { cacheMs: 0 });
}

/** A budget with no halt-state file, so the PoC cannot touch real keeper state. */
function freshBudget(): KeeperBudget {
  return new KeeperBudget({}, { env: {} });
}

describe("#350 — unclamped priority-fee estimate latches the budget breaker", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    // resolveEstimateCeiling reads the live env — a machine that exports this
    // would otherwise silently change what the assertions below mean.
    vi.stubEnv("KEEPER_PRIORITY_FEE_ESTIMATE_MAX_MICROLAMPORTS", "");
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("an absurd RPC value is CLAMPED, not passed through verbatim", async () => {
    const absurd = 500_000_000; // microLamports per CU
    const est = estimatorReturning(absurd);

    const value = await est.estimate(["acc1"], "liquidation");

    expect(value).toBe(PRIORITY_FEE_ESTIMATE_MAX);
    expect(value).toBeLessThan(absurd);
  });

  it("a legitimate p95/veryHigh congestion bid is NOT clamped", async () => {
    // The ceiling defends against absurd/malformed values, not against an
    // operator's deliberate congestion response. resolvePercentile accepts
    // 0-100, so a lane raised to p95 reads `veryHigh`, documented in the
    // millions of uL. Cutting that would cost a liquidation.
    const veryHigh = 5_483_925;
    const est = estimatorReturning(veryHigh);

    expect(await est.estimate(["acc1"], "liquidation")).toBe(veryHigh);
  });

  it("the clamped estimate can no longer reach the cycle cap on one send", async () => {
    const est = estimatorReturning(500_000_000);
    const microLamports = await est.estimate(["acc1"], "liquidation");

    // Worst case: the CU ceiling AND the mainnet Jito tip.
    const cost = estimateLamportCost(microLamports, MAX_CU, 200_000, 0);
    expect(cost).toBeLessThan(CYCLE_CAP);

    const budget = freshBudget();
    expect(budget.canSpend(cost, "liquidation")).toBe(true);
    expect(budget.isHalted()).toBe(false);
  });

  it("PRE-FIX REGRESSION GUARD: the unclamped value WOULD have latched a keeper-wide halt", async () => {
    // Pinning the vulnerability itself, so a future change that removes or
    // widens the clamp is caught here rather than in production. This feeds
    // canSpend the raw pre-clamp value the RPC reported.
    const unclamped = 500_000_000;
    const cost = estimateLamportCost(unclamped, MAX_CU, 0, 0);
    expect(cost).toBeGreaterThan(CYCLE_CAP);

    const budget = freshBudget();
    expect(budget.canSpend(cost, "liquidation")).toBe(false);
    // Nothing was ever spent — a REFUSED proposal — yet the breaker latched,
    // and it latched for every lane, not just this one.
    expect(budget.isHalted()).toBe(true);
    expect(budget.haltKind).toBe("cycle-spend-cap");

    const ordinary = estimateLamportCost(1_000, 200_000, 0, 0);
    expect(budget.canSpend(ordinary, "crank")).toBe(false);
    budget.resume("poc"); // only an operator can clear it
    expect(budget.canSpend(ordinary, "crank")).toBe(true);
  });

  it("a normal estimate is untouched by the ceiling", async () => {
    const est = estimatorReturning(25_000);
    expect(await est.estimate(["acc1"], "liquidation")).toBe(25_000);
  });

  it("SCOPE: the ceiling bounds the FEE term only — rent still latches", async () => {
    // Honest limit of this fix. estimateLamportCost is
    // base + fee + jitoTip + extraLamports, and extraLamports carries the v17
    // portfolio rent (~60.0M lamports, measured on-chain for 9347 bytes),
    // which exceeds the 50M cycle cap on its own. Tracked separately; asserted
    // here so nobody reads the ceiling as "no send can latch the breaker".
    const est = estimatorReturning(1_000);
    const fee = await est.estimate(["acc1"], "crank");
    const V17_PORTFOLIO_RENT = 60_005_175;

    const cost = estimateLamportCost(fee, 1_400_000, 0, V17_PORTFOLIO_RENT);
    expect(cost).toBeGreaterThan(CYCLE_CAP);

    const budget = freshBudget();
    expect(budget.canSpend(cost, "crank")).toBe(false);
    expect(budget.isHalted()).toBe(true);
  });

  it("the breaker ALREADY distinguishes proposal from overspend — for reservations", async () => {
    // budget.ts refuses WITHOUT halting when in-flight reservations would breach
    // a cap, on the stated grounds that "nothing has been over-spent yet".
    // A first-of-cycle proposal is the same situation, but takes the halt path.
    const budget = freshBudget();
    const half = Math.floor(CYCLE_CAP / 2) + 1_000;

    expect(budget.canSpend(half, "crank")).toBe(true); // reserves, does not settle
    expect(budget.canSpend(half, "crank")).toBe(false); // would breach via reservation
    expect(budget.isHalted()).toBe(false); // ...and correctly does NOT latch
  });
});
