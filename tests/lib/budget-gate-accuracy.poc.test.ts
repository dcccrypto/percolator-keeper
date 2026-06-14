import { describe, it, expect } from "vitest";
import { KeeperBudget } from "../../src/lib/budget.js";

/**
 * PoCs for two budget circuit-breaker correctness gaps. Both fail on current
 * main and pass after the fix.
 *
 * G — NaN cost bypass: a malformed fee env (e.g. JITO_TIP_LAMPORTS="abc") makes
 *     estimatedCost NaN. `NaN > cap` is false, so canSpend() admits it; recordTx
 *     then drops it (`!Number.isFinite`). Result: every send is allowed and
 *     nothing is recorded — the caps never trip. The breaker is silently off.
 *
 * B — canSpend TOCTOU: canSpend() is a pure read; spend is only booked by
 *     recordTx() after the send's await. Concurrent in-flight sends all clear
 *     the same pre-send snapshot and collectively overshoot the cap.
 */
describe("KeeperBudget gate accuracy (PoC)", () => {
  const CFG = {
    maxSolPerCycle: 100,
    maxSolPerHour: 1_000_000_000,
    maxSolPerDay: 1_000_000_000,
    maxTxPerCycle: 1_000,
  } as const;

  it("G: a non-finite cost must not pass canSpend (and must fail safe)", () => {
    const b = new KeeperBudget(CFG, { now: () => 1 });
    // NaN slips every `x > cap` comparison on main → admitted.
    expect(b.canSpend(NaN, "crank")).toBe(false); // FAILS on main: returns true
    // A non-finite cost signals a config bug (bad fee env); fail safe by halting
    // so an operator must fix it and resume, rather than running with the
    // breaker silently disabled.
    expect(b.isHalted()).toBe(true); // FAILS on main: not halted
  });

  it("B: concurrent pre-send checks must not both pass and overshoot the cycle cap", () => {
    const b = new KeeperBudget(CFG, { now: () => 1 });
    // Two sends of 60 are in flight at once (recordTx happens later, after the
    // network await). Together 120 > 100 cap. The first is admitted; the second
    // — checked before the first has recorded — must be refused.
    expect(b.canSpend(60, "crank")).toBe(true);
    expect(b.canSpend(60, "crank")).toBe(false); // FAILS on main: returns true (no reservation)
  });

  it("B: a reserved-then-recorded send leaves cycleSpend equal to the actual recorded amount", () => {
    // Guards that the reservation is released on recordTx and does not double-count.
    const b = new KeeperBudget({ ...CFG, maxSolPerCycle: 1_000_000 }, { now: () => 1 });
    expect(b.canSpend(60, "crank")).toBe(true); // reserves 60
    b.recordTx(60, "crank", "success"); // releases reservation, books 60
    expect(b.getStats().cycleSpend).toBe(60);
    // A second send is now admissible again (only 60 of the budget is used).
    expect(b.canSpend(60, "crank")).toBe(true);
  });
});
