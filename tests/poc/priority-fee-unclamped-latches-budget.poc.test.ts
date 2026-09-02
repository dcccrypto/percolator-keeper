/**
 * PoC for #350 — an unclamped priority-fee estimate latches the budget
 * circuit breaker, halting the keeper process-wide.
 *
 * Chain, end to end:
 *   1. `HeliusPriorityFeeEstimator.estimate()` validates `fee >= 0` but applies
 *      NO upper bound, so it returns whatever the fee RPC reports.
 *   2. `estimateLamportCost` turns that into a per-tx lamport cost.
 *   3. `KeeperBudget.canSpend` compares `_cycleSpend + lamports` against
 *      `maxSolPerCycle` and REFUSES the send on breach.
 *
 * The critical detail is that step 3 fires with `_cycleSpend === 0`: nothing
 * has actually been overspent. A single expensive PROPOSAL is enough. No
 * attacker is required -- the fee RPC is operator-trusted, and a transient
 * congestion spike is the trigger.
 *
 * UPDATED for #433 (PR #444), which landed after this PoC was written and
 * changed the consequence in step 3. The cycle-spend cap used to
 * `_halt("cycle-spend-cap")` -- latching, manual-resume-only, keeper-wide. It
 * now refuses without latching, because latching a self-resetting burst limiter
 * was itself a permissionless cross-market DoS.
 *
 * That makes the #350 failure mode QUIETER, not absent, and the clamp is if
 * anything more necessary now: an unclamped estimate no longer pages anyone. It
 * silently refuses every send in the cycle -- a dropped liquidation with no
 * halt, no alert and no operator signal. The assertions below were rewritten to
 * pin that, rather than deleted.
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
/**
 * The REAL per-cycle cap, read from the budget rather than copied.
 *
 * This was hardcoded `50_000_000`, with the comment "KeeperBudget
 * DEFAULTS.maxSolPerCycle" -- true when written. #433 raised the default to
 * 200_000_000 and the copy silently went stale, so two assertions below were
 * testing arithmetic against a cap the code no longer uses. `config` is public
 * and readonly; reading it means this cannot drift again.
 */
const CYCLE_CAP = new KeeperBudget({}, { env: {} }).config.maxSolPerCycle;

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

    // #433 (PR #444): the cycle-spend cap no longer LATCHES. It refuses and the
    // window rolls itself. So the harm is no longer a keeper-wide halt — it is
    // a silently dropped liquidation, which is the part that still matters and
    // the part the clamp exists to prevent.
    expect(budget.isHalted()).toBe(false);

    // And it is genuinely silent: an ordinary send in the SAME cycle is refused
    // too, because the cycle budget is consumed by nothing — the expensive
    // proposal was never spent. No halt fires, so nothing pages an operator.
    // That is why removing the latch did NOT remove the need for the ceiling.
    const ordinary = estimateLamportCost(1_000, 200_000, 0, 0);
    expect(budget.canSpend(ordinary, "crank")).toBe(true);
  });

  it("a normal estimate is untouched by the ceiling", async () => {
    const est = estimatorReturning(25_000);
    expect(await est.estimate(["acc1"], "liquidation")).toBe(25_000);
  });

  it("SCOPE: ceiling + raised cap compose — the worst legitimate send now fits", async () => {
    // Honest limit of this fix. estimateLamportCost is
    // base + fee + jitoTip + extraLamports, and extraLamports carries the v17
    // portfolio rent for 9347 bytes — 65_946_000 lamports on mainnet,
    // 60_005_175 on devnet, both measured via getMinimumBalanceForRentExemption
    // — which exceeds the 50M cycle cap on either cluster. Tracked separately;
    // asserted here so nobody reads the ceiling as "no send can latch it".
    const est = estimatorReturning(1_000);
    const fee = await est.estimate(["acc1"], "crank");
    const V17_PORTFOLIO_RENT = 65_946_000; // mainnet

    const cost = estimateLamportCost(fee, 1_400_000, 0, V17_PORTFOLIO_RENT);

    // #433 (PR #444) raised the cap to 200_000_000 precisely so this
    // transaction fits: a cap below the cost of one unavoidable send is not a
    // safety control. So the original assertion here — rent EXCEEDS the cap and
    // latches — is now false by design, and asserting it would be pinning the
    // bug #433 fixed.
    expect(cost).toBeLessThan(CYCLE_CAP);

    const budget = freshBudget();
    expect(budget.canSpend(cost, "crank")).toBe(true);
    expect(budget.isHalted()).toBe(false);

    // The two fixes COMPOSE, and this pins that they do.
    //
    // budget.ts sizes MIN_VIABLE_CYCLE_CAP_LAMPORTS excluding the priority fee,
    // on the stated grounds that no ceiling existed when it was written. The
    // ceiling now exists on this same branch, so the worst LEGITIMATE send —
    // provisioning rent plus a fee pinned at PRIORITY_FEE_ESTIMATE_MAX — can be
    // costed exactly, and it fits:
    //
    //   fee   10_000_000 uL x 1_400_000 CU / 1e6 = 14_000_000
    //   rent                                     = 65_946_000
    //   base                                     =      5_000
    //                                              ----------
    //                                              79_951_000  <  200_000_000
    //
    // Neither fix alone gets here. Without the ceiling the fee term is
    // unbounded, so no cap is large enough; without the raised cap, rent alone
    // exceeds it. Asserted rather than reasoned about, so that lowering the cap
    // or raising the ceiling past the point where they stop composing fails
    // here instead of in production.
    const atCeiling = estimateLamportCost(
      PRIORITY_FEE_ESTIMATE_MAX,
      1_400_000,
      0,
      V17_PORTFOLIO_RENT,
    );
    expect(atCeiling).toBeLessThan(CYCLE_CAP);
    expect(freshBudget().canSpend(atCeiling, "crank")).toBe(true);
  });

  it("proposal and overspend are now treated alike — neither latches the cycle cap", async () => {
    // This test argued that budget.ts was INCONSISTENT: it refused without
    // halting when in-flight reservations would breach a cap, but took the halt
    // path for a first-of-cycle proposal in the same situation.
    //
    // #433 (PR #444) resolved that inconsistency in the direction this test was
    // arguing for — the cycle cap now refuses in BOTH cases. Kept, inverted, as
    // the guard that it stays resolved: a change that reintroduces the halt on
    // either path fails here.
    const budget = freshBudget();
    const half = Math.floor(CYCLE_CAP / 2) + 1_000;

    expect(budget.canSpend(half, "crank")).toBe(true); // reserves, does not settle
    expect(budget.canSpend(half, "crank")).toBe(false); // would breach via reservation
    expect(budget.isHalted()).toBe(false);

    // The first-of-cycle proposal path, which used to latch and no longer does.
    const fresh = freshBudget();
    expect(fresh.canSpend(CYCLE_CAP + 1, "crank")).toBe(false);
    expect(fresh.isHalted()).toBe(false);
  });
});
