/**
 * H4 PoC — crank watchdog allows a second crankAll() to run concurrently.
 *
 * THE BUG (pre-fix):
 *   The setInterval watchdog set `_cycling = false` whenever elapsed cycle
 *   time exceeded MAX_CYCLE_MS. But the original crankAll() invocation was
 *   still awaiting Promise.all — the watchdog merely cleared the in-flight
 *   guard, it did NOT cancel anything. The next interval tick saw
 *   `_cycling === false` and launched a SECOND crankAll() concurrently.
 *
 * THE FIX (this PR):
 *   The watchdog now arms a grace timer + alerts once, never flips _cycling.
 *   If the cycle recovers within WATCHDOG_GRACE_MS, normal recovery; if it
 *   stays hung past the grace, process.exit(1) lets the supervisor restart.
 *
 * This PoC demonstrates: under the OLD code path, an interval tick after a
 * watchdog reset would happily start a second cycle while the first is still
 * mid-flight. Under the NEW code path, the second cycle is suppressed.
 */
import { describe, it, expect, vi } from "vitest";

interface CrankState {
  _cycling: boolean;
  _cycleStartedAt: number;
  _watchdogArmedAt: number;
  startedCount: number;
}

const MAX_CYCLE_MS = 5 * 60_000;
const WATCHDOG_GRACE_MS = 30_000;

// OLD watchdog body — buggy: flips _cycling, allowing next tick to start another.
function tickOld(state: CrankState, nowMs: number): { exited: boolean } {
  if (state._cycling) {
    const elapsed = nowMs - state._cycleStartedAt;
    if (elapsed > MAX_CYCLE_MS) {
      state._cycling = false; // ← THE BUG
    }
    return { exited: false };
  }
  state._cycling = true;
  state._cycleStartedAt = nowMs;
  state.startedCount++;
  return { exited: false };
}

// NEW watchdog body — fix: arm grace timer, do not flip _cycling.
function tickNew(
  state: CrankState,
  nowMs: number,
  alertSpy: () => void,
): { exited: boolean } {
  if (state._cycling) {
    const elapsed = nowMs - state._cycleStartedAt;
    if (elapsed > MAX_CYCLE_MS) {
      if (state._watchdogArmedAt === 0) {
        state._watchdogArmedAt = nowMs;
        alertSpy();
      } else if (nowMs - state._watchdogArmedAt > WATCHDOG_GRACE_MS) {
        return { exited: true }; // process.exit(1) — supervisor restarts
      }
    }
    return { exited: false };
  }
  state._cycling = true;
  state._cycleStartedAt = nowMs;
  state._watchdogArmedAt = 0;
  state.startedCount++;
  return { exited: false };
}

describe("H4 PoC — watchdog double-execution guard", () => {
  it("OLD path: hung cycle is force-reset → next tick starts a SECOND crankAll", () => {
    const state: CrankState = { _cycling: true, _cycleStartedAt: 0, _watchdogArmedAt: 0, startedCount: 1 };

    // Tick 1: at 6 min — exceeds MAX_CYCLE_MS (5 min). OLD code flips _cycling=false.
    tickOld(state, 6 * 60_000);
    expect(state._cycling).toBe(false); // ← guard down

    // Tick 2: at 6:30 min — _cycling=false, so a SECOND cycle starts while
    // the original crankAll is still awaiting Promise.all results.
    tickOld(state, 6.5 * 60_000);
    expect(state.startedCount).toBe(2); // ← DOUBLE EXECUTION
  });

  it("NEW path: hung cycle is NOT force-reset → second cycle cannot launch", () => {
    const state: CrankState = { _cycling: true, _cycleStartedAt: 0, _watchdogArmedAt: 0, startedCount: 1 };
    const alertSpy = vi.fn();

    // Tick 1: at 6 min — watchdog arms but DOES NOT flip _cycling.
    tickNew(state, 6 * 60_000, alertSpy);
    expect(state._cycling).toBe(true); // ← guard still up
    expect(state._watchdogArmedAt).toBeGreaterThan(0);
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // Tick 2: at 6:20 min — still within grace, still _cycling=true.
    tickNew(state, 6 * 60_000 + 20_000, alertSpy);
    expect(state._cycling).toBe(true);
    expect(state.startedCount).toBe(1); // ← NO double execution
    expect(alertSpy).toHaveBeenCalledTimes(1); // alerts once, not every tick
  });

  it("NEW path: after grace expires, process.exit(1) is signalled", () => {
    const state: CrankState = { _cycling: true, _cycleStartedAt: 0, _watchdogArmedAt: 0, startedCount: 1 };
    const alertSpy = vi.fn();

    tickNew(state, 6 * 60_000, alertSpy); // arm
    const result = tickNew(state, 6 * 60_000 + 31_000, alertSpy); // past 30s grace
    expect(result.exited).toBe(true);
  });

  it("NEW path: cycle recovers within grace → watchdog disarms cleanly", () => {
    const state: CrankState = { _cycling: true, _cycleStartedAt: 0, _watchdogArmedAt: 0, startedCount: 1 };
    const alertSpy = vi.fn();
    tickNew(state, 6 * 60_000, alertSpy); // arm
    expect(state._watchdogArmedAt).toBeGreaterThan(0);

    // Simulate the original cycle's finally block running:
    state._cycling = false;
    state._watchdogArmedAt = 0;

    // Next interval tick starts a fresh cycle normally.
    tickNew(state, 7 * 60_000, alertSpy);
    expect(state.startedCount).toBe(2);
    expect(state._cycling).toBe(true);
  });
});
