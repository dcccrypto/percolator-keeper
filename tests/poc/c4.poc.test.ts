/**
 * C4 PoC — shadow-harness divergence formula fires alerts every cycle.
 *
 * THE BUG (pre-fix):
 *   ShadowHarness compared shadowTotal (this keeper's own DecisionLog entries)
 *   against liveTotal (every signature touching the program id, from
 *   getSignaturesForAddress). On any active perp market, liveTotal is
 *   dominated by user/maker/oracle/other-keeper traffic. The formula
 *     divergencePct = |shadow - live| / max(shadow, live) * 100
 *   is ~99% every cycle. The alert gate `divergencePct > 1%` fires
 *   continuously → operators mute the channel → harness is useless.
 *
 * THE FIX (this PR):
 *   Drop the pct-divergence alert. Replace with two structural gates that
 *   don't depend on signer attribution:
 *     - shadow-silent: shadowTotal===0 AND liveTotal>0 for N consecutive
 *       cycles (catches "shadow keeper hung")
 *     - shadow-runaway: shadowTotal > 3x*liveTotal AND shadowTotal >= 10
 *       (catches "shadow over-fires" or "live keeper dead")
 *   Per-alert cooldown (1hr) + RPC-failure suspension.
 *
 * This PoC reproduces the day-1 alert-fatigue scenario AND verifies the new
 * gates don't fire on the same input.
 */
import { describe, it, expect } from "vitest";

function computeDivergencePct(shadowTotal: number, liveTotal: number): number {
  const maxTotal = Math.max(shadowTotal, liveTotal);
  if (maxTotal === 0) return 0;
  return Math.min((Math.abs(shadowTotal - liveTotal) / maxTotal) * 100, 100);
}

// NEW gates (post-fix).
function shadowSilentFires(opts: {
  shadowTotal: number;
  liveTotal: number;
  consecutiveSilentCycles: number;
  threshold: number; // N
}): boolean {
  return opts.shadowTotal === 0 && opts.liveTotal > 0 && opts.consecutiveSilentCycles >= opts.threshold;
}

function shadowRunawayFires(opts: {
  shadowTotal: number;
  liveTotal: number;
  multiplier: number;
  minSamples: number;
}): boolean {
  return (
    opts.shadowTotal >= opts.minSamples &&
    opts.shadowTotal > opts.multiplier * opts.liveTotal
  );
}

describe("C4 PoC — shadow harness alert fatigue", () => {
  it("OLD path: realistic mainnet traffic (5 shadow decisions / 500 live txs) fires pct alert", () => {
    const shadowTotal = 5;   // keeper-only — small even on busy markets
    const liveTotal = 500;   // user fills, maker placements, oracle pushes, etc.

    const divergencePct = computeDivergencePct(shadowTotal, liveTotal);
    expect(divergencePct).toBe(99);

    const OLD_threshold = 1.0;
    const oldAlertFires = divergencePct > OLD_threshold;
    expect(oldAlertFires).toBe(true);
    // ↑ Fires on every 5-minute cycle from day 1. Alert fatigue → harness
    //   muted by operators within hours.
  });

  it("NEW path: same input (5 vs 500) does NOT fire either structural gate", () => {
    const shadowTotal = 5;
    const liveTotal = 500;

    const silentFires = shadowSilentFires({
      shadowTotal,
      liveTotal,
      consecutiveSilentCycles: 1,
      threshold: 3,
    });
    const runawayFires = shadowRunawayFires({
      shadowTotal,
      liveTotal,
      multiplier: 3,
      minSamples: 10,
    });

    expect(silentFires).toBe(false); // shadow isn't silent (shadow=5)
    expect(runawayFires).toBe(false); // shadow is below live, not above
    // ↑ The regression case for C4: structural gates correctly silent.
  });

  it("NEW path: legitimate shadow-silent failure (shadow=0, live=100) fires after N consecutive cycles", () => {
    const fires0 = shadowSilentFires({ shadowTotal: 0, liveTotal: 100, consecutiveSilentCycles: 1, threshold: 3 });
    const fires1 = shadowSilentFires({ shadowTotal: 0, liveTotal: 100, consecutiveSilentCycles: 2, threshold: 3 });
    const fires2 = shadowSilentFires({ shadowTotal: 0, liveTotal: 100, consecutiveSilentCycles: 3, threshold: 3 });

    expect(fires0).toBe(false);
    expect(fires1).toBe(false);
    expect(fires2).toBe(true);
    // ↑ Catches the actual failure mode the harness exists to detect, with a
    //   streak requirement that suppresses transient blips.
  });

  it("NEW path: shadow-runaway (shadow=50, live=10) fires above min-samples threshold", () => {
    expect(shadowRunawayFires({ shadowTotal: 50, liveTotal: 10, multiplier: 3, minSamples: 10 })).toBe(true);
    // Below min-samples: no alert even at infinite ratio.
    expect(shadowRunawayFires({ shadowTotal: 5, liveTotal: 0, multiplier: 3, minSamples: 10 })).toBe(false);
  });
});
