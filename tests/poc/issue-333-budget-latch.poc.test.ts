/**
 * PoC for Finding #333 [HIGH] — global budget latch DoS.
 *
 * ROOT CAUSE (pre-fix): KeeperBudget.canSpend() treated exceeding maxTxPerCycle
 * as a genuine anomaly and called _halt("cycle-tx-count-cap", ...), LATCHING a
 * permanent halt that survived the 30s window rollover and only cleared via an
 * operator resume(). Because permissionless market creation drives crank /
 * provisioning / lp-vault tx volume, an attacker could latch the keeper with
 * mere volume and stop ALL cranks AND liquidations cross-market.
 *
 * FIX (#333):
 *   1. De-latch the count cap → soft backpressure: canSpend() returns false
 *      WITHOUT setting _isHalted; _rollCycleIfElapsed auto-resumes next window.
 *   2. Reserve safety-critical capacity (reservedCriticalTxPerCycle, default 10)
 *      so routine lanes (crank / provisioning / lp-vault) see an effective cap
 *      of maxTxPerCycle - reserved, while critical lanes (liquidation / oracle /
 *      adl) may use the full maxTxPerCycle.
 *
 * The reporter's PoC asserted the OLD (vulnerable) latch behavior. The
 * assertions below are FLIPPED to the FIXED behavior.
 */
import { describe, it, expect } from "vitest";
import { KeeperBudget } from "../../src/lib/budget.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// Wide spend caps so ONLY the per-cycle tx-COUNT cap is exercised; that is the
// lane the #333 DoS abused.
const CONFIG = {
  maxSolPerCycle: 1_000_000_000,
  maxSolPerHour: 1_000_000_000,
  maxSolPerDay: 1_000_000_000,
  maxTxPerCycle: 60,
  reservedCriticalTxPerCycle: 10, // routine "crank" lane effective cap = 50
  cycleWindowMs: 30_000,
  txSuccessRateWindow: 60_000,
  txSuccessRateThreshold: 0.7,
  txSuccessRateMinSamples: 1_000_000, // disable success-rate breaker for this PoC
} as const;

describe("#333 PoC — budget count-cap latch DoS is fixed", () => {
  it("the over-cap crank returns false WITHOUT halting (soft backpressure)", () => {
    const clock = makeClock();
    const b = new KeeperBudget(CONFIG, { now: clock.now });

    // Drive the routine "crank" lane up to its effective cap (50).
    for (let i = 0; i < 50; i++) {
      expect(b.canSpend(1, "crank")).toBe(true);
      b.recordTx(1, "crank", "success");
    }
    // The 51st crank is refused — but as SOFT backpressure, NOT a latch.
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(false);
    expect(b.haltKind).toBeUndefined();
  });

  it("after the window rolls (now += 31_000) crank is accepted again — no operator resume()", () => {
    const clock = makeClock();
    const b = new KeeperBudget(CONFIG, { now: clock.now });
    for (let i = 0; i < 50; i++) b.recordTx(1, "crank", "success"); // saturate crank lane
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(false);

    clock.advance(31_000); // window rolls → _cycleTxCount zeroed
    expect(b.canSpend(1, "crank")).toBe(true); // auto-resumed without resume()
    expect(b.isHalted()).toBe(false);
  });

  it("a liquidation is STILL accepted even when the non-critical (crank) lane is saturated", () => {
    const clock = makeClock();
    const b = new KeeperBudget(CONFIG, { now: clock.now });

    // Attacker floods routine crank/provisioning volume to the crank cap.
    for (let i = 0; i < 50; i++) b.recordTx(1, "crank", "success");
    expect(b.canSpend(1, "crank")).toBe(false); // crank backpressured

    // The reserved critical slots remain: liquidation uses the FULL cap of 60.
    expect(b.canSpend(1, "liquidation")).toBe(true);
    expect(b.canSpend(1, "oracle")).toBe(true);
    expect(b.canSpend(1, "adl")).toBe(true);
    expect(b.isHalted()).toBe(false);
  });

  it("a day-spend breach STILL latches (genuine anomalies are unchanged)", () => {
    const clock = makeClock();
    // Tight day cap; first big send breaches it → real overspend → latch.
    const b = new KeeperBudget(
      { ...CONFIG, maxSolPerDay: 1_000 },
      { now: clock.now },
    );
    expect(b.canSpend(2_000, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("day-spend-cap");

    // And a day-cap latch is NOT cleared by a window roll — operator-only.
    clock.advance(120_000);
    expect(b.isHalted()).toBe(true);
    expect(b.canSpend(1, "liquidation")).toBe(false); // even critical lanes are halted
    b.resume("op");
    expect(b.canSpend(1, "liquidation")).toBe(true);
  });

  it("reservation back-pressure path also honors the reserved critical capacity", () => {
    const clock = makeClock();
    const b = new KeeperBudget(CONFIG, { now: clock.now });
    // Reserve (canSpend without recordTx) 50 in-flight crank slots.
    for (let i = 0; i < 50; i++) expect(b.canSpend(1, "crank")).toBe(true);
    // The 51st crank reservation is refused (50 reserved + 1 > effective cap 50).
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(false);
    // Liquidation can still reserve into the held-back slots (full cap 60).
    expect(b.canSpend(1, "liquidation")).toBe(true);
  });
});
