/**
 * M9 PoC — deactivated markets still poll at the active interval because
 * lastCrankTime isn't advanced on failure.
 *
 * THE BUG (pre-fix):
 *   `isDue(state)` at src/services/crank.ts:678 returns:
 *     const interval = state.isActive ? this.intervalMs : this.inactiveIntervalMs;
 *     return Date.now() - state.lastCrankTime >= interval;
 *
 *   On failure, the catch block at line 914+ updates `failureCount` and
 *   `consecutiveFailures` but does NOT update `lastCrankTime`. After 10
 *   consecutive failures `isActive` flips to false, intending to slow polls
 *   from intervalMs (30s) to inactiveIntervalMs (120s). But the back-off
 *   never fires because:
 *     - If the market never succeeded once → lastCrankTime = 0 → isDue always true.
 *     - If the market succeeded long ago → lastCrankTime is stale → isDue always true.
 *
 *   The dead market keeps cranking every 30s (active interval) regardless
 *   of the isActive flag. RPC quota + priority fees burn on broken markets.
 *
 * THE FIX (this PR):
 *   Add `state.lastCrankTime = Date.now()` at the top of the catch block,
 *   right after the failureCount/consecutiveFailures increment. This
 *   advances the time anchor on every attempt (success or failure), so
 *   `isDue` honors the inactive interval as designed.
 *
 * This PoC walks through both shapes with a minimal isDue/state model.
 */
import { describe, it, expect } from "vitest";

interface State {
  isActive: boolean;
  lastCrankTime: number;
  consecutiveFailures: number;
}

const INTERVAL_MS = 30_000;          // active interval
const INACTIVE_INTERVAL_MS = 120_000; // inactive interval

function isDue(state: State, now: number): boolean {
  const interval = state.isActive ? INTERVAL_MS : INACTIVE_INTERVAL_MS;
  return now - state.lastCrankTime >= interval;
}

// OLD catch-block behavior: failure does NOT advance lastCrankTime.
function oldCatch(state: State, _now: number): void {
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= 10) state.isActive = false;
}

// NEW catch-block behavior: failure advances lastCrankTime.
function newCatch(state: State, now: number): void {
  state.consecutiveFailures++;
  state.lastCrankTime = now;
  if (state.consecutiveFailures >= 10) state.isActive = false;
}

describe("M9 PoC — lastCrankTime advances on failure to honor inactive interval", () => {
  it("OLD pattern: market never succeeds → lastCrankTime stays 0 → isDue always true (no back-off)", () => {
    const state: State = { isActive: true, lastCrankTime: 0, consecutiveFailures: 0 };

    // Simulate 12 failed cycles, each 30s apart.
    for (let i = 1; i <= 12; i++) {
      const cycleTime = i * 30_000;
      expect(isDue(state, cycleTime)).toBe(true); // always due → keeper cranks
      oldCatch(state, cycleTime);
    }

    // After 10 failures, isActive flips to false (intent: back off).
    expect(state.isActive).toBe(false);
    expect(state.consecutiveFailures).toBe(12);

    // BUG: at cycle 13 (T=390s = 13 × 30s), 30s after cycle 12's failure,
    // isDue is STILL true even though isActive=false and the inactive
    // interval is 120s. Why? Because lastCrankTime never moved from 0.
    expect(isDue(state, 13 * 30_000)).toBe(true);
    // ↑ Keeper keeps cranking the dead market every 30s. The 120s
    //   inactive interval never fires.
  });

  it("NEW pattern: lastCrankTime advances on every failure → inactive back-off is honored", () => {
    const state: State = { isActive: true, lastCrankTime: 0, consecutiveFailures: 0 };

    // 10 failed cycles, each 30s apart.
    for (let i = 1; i <= 10; i++) {
      const cycleTime = i * 30_000;
      expect(isDue(state, cycleTime)).toBe(true);
      newCatch(state, cycleTime);
    }

    // After 10 failures: isActive=false, lastCrankTime=300_000 (cycle 10).
    expect(state.isActive).toBe(false);
    expect(state.lastCrankTime).toBe(300_000);

    // Cycle 11 is 30s after cycle 10. The inactive interval is 120s.
    // isDue checks 330_000 - 300_000 = 30_000 < 120_000 → false. SKIP.
    expect(isDue(state, 11 * 30_000)).toBe(false);

    // Cycle 12 (60s after): 60_000 < 120_000 → still skipped.
    expect(isDue(state, 12 * 30_000)).toBe(false);

    // Cycle 13 (90s after): still skipped.
    expect(isDue(state, 13 * 30_000)).toBe(false);

    // Cycle 14 (120s after): now eligible.
    expect(isDue(state, 14 * 30_000)).toBe(true);

    // ↑ The dead market polls every 120s instead of every 30s.
    //   4× reduction in wasted RPC quota and priority-fee spend.
  });

  it("NEW pattern: active failing market is unaffected (still polls at 30s)", () => {
    const state: State = { isActive: true, lastCrankTime: 0, consecutiveFailures: 0 };

    // Fail 5 times — still active.
    for (let i = 1; i <= 5; i++) {
      const cycleTime = i * 30_000;
      expect(isDue(state, cycleTime)).toBe(true);
      newCatch(state, cycleTime);
    }

    expect(state.isActive).toBe(true);
    expect(state.lastCrankTime).toBe(5 * 30_000);

    // Next cycle 30s later: still due (active interval 30s).
    expect(isDue(state, 6 * 30_000)).toBe(true);

    // 15s later: not yet due.
    expect(isDue(state, 5 * 30_000 + 15_000)).toBe(false);
  });

  it("NEW pattern: success after recovery resets to active and lastCrankTime advances normally", () => {
    const state: State = { isActive: false, lastCrankTime: 1_000_000, consecutiveFailures: 15 };

    // Simulate the success path's resets (production code lines 905-909).
    function successPath(now: number) {
      state.lastCrankTime = now;
      state.consecutiveFailures = 0;
      state.isActive = true;
    }
    successPath(2_000_000);

    expect(state.isActive).toBe(true);
    expect(state.lastCrankTime).toBe(2_000_000);
    expect(state.consecutiveFailures).toBe(0);

    // Back to active polling cadence.
    expect(isDue(state, 2_030_000)).toBe(true); // 30s later → due
    expect(isDue(state, 2_015_000)).toBe(false); // 15s → not yet
  });
});
