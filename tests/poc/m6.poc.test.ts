/**
 * M6 PoC — fetchPrice's dual-null path has no circuit breaker.
 *
 * THE BUG (pre-fix):
 *   In services/oracle.ts, when BOTH DexScreener and Jupiter return null AND
 *   there's no fresh cache entry, fetchPrice silently returned null with no
 *   consecutive-failure counter, no alert, no escalation. A sustained
 *   dual-source outage was invisible to ops until the downstream
 *   "stale oracle" cron eventually fired (with its own delays).
 *
 *   Compare to the existing SINGLE-source state machine: per-mint consecutive
 *   counter, threshold-gated sendWarningAlert, reset on recovery. That pattern
 *   existed for "one source down" but not for the worse "both sources down".
 *
 * THE FIX (M6):
 *   - Add _dualNullState per-mint consecutive counter.
 *   - At threshold (default 5), fire sendCriticalAlert ONCE per outage window.
 *   - Reset state on any successful fetch (live OR cached).
 *   - Skip the alert when fresh cache is available — keeper still has a price.
 *
 * This PoC walks through the state machine at the observer-shape level.
 */
import { describe, it, expect, vi } from "vitest";

interface DualNullState { consecutive: number; alertSent: boolean }
const THRESHOLD = 5;

class FakeOracle {
  state = new Map<string, DualNullState>();
  onCritical = vi.fn<(mint: string, consecutive: number) => void>();

  fetchPrice(mint: string, opts: { bothDown: boolean; freshCache: boolean }): bigint | null {
    if (opts.bothDown) {
      const s = this.state.get(mint) ?? { consecutive: 0, alertSent: false };
      s.consecutive++;
      if (!opts.freshCache && s.consecutive >= THRESHOLD && !s.alertSent) {
        s.alertSent = true;
        this.onCritical(mint, s.consecutive);
      }
      this.state.set(mint, s);
      return opts.freshCache ? 999_999n /* cached */ : null;
    }
    // success path — reset
    const s = this.state.get(mint);
    if (s && (s.consecutive > 0 || s.alertSent)) {
      s.consecutive = 0;
      s.alertSent = false;
      this.state.set(mint, s);
    }
    return 1_000_000n;
  }
}

describe("M6 PoC — dual-null circuit breaker", () => {
  it("OLD pattern: 100 consecutive dual-nulls produce ZERO alerts (invisible outage)", () => {
    const oldCritical = vi.fn();
    function oldFetchPrice(): null { return null; /* no counter, no alert */ }

    for (let i = 0; i < 100; i++) oldFetchPrice();

    expect(oldCritical).not.toHaveBeenCalled();
    // 100 cycles of "no price for this mint" and ops sees nothing.
  });

  it("NEW pattern: fires critical alert exactly once at threshold (idempotent)", () => {
    const oracle = new FakeOracle();
    for (let i = 0; i < THRESHOLD * 3; i++) {
      oracle.fetchPrice("MINT-A", { bothDown: true, freshCache: false });
    }
    expect(oracle.onCritical).toHaveBeenCalledTimes(1);
    expect(oracle.onCritical).toHaveBeenCalledWith("MINT-A", THRESHOLD);
  });

  it("NEW pattern: state resets on recovery, re-arming the alert for the next outage", () => {
    const oracle = new FakeOracle();

    // Outage 1
    for (let i = 0; i < THRESHOLD + 1; i++) {
      oracle.fetchPrice("MINT-B", { bothDown: true, freshCache: false });
    }
    expect(oracle.onCritical).toHaveBeenCalledTimes(1);

    // Recovery
    oracle.fetchPrice("MINT-B", { bothDown: false, freshCache: false });

    // Outage 2
    for (let i = 0; i < THRESHOLD + 1; i++) {
      oracle.fetchPrice("MINT-B", { bothDown: true, freshCache: false });
    }
    expect(oracle.onCritical).toHaveBeenCalledTimes(2);
  });

  it("NEW pattern: dual-null with FRESH CACHE does NOT alert (keeper still has a usable price)", () => {
    const oracle = new FakeOracle();
    for (let i = 0; i < THRESHOLD * 3; i++) {
      const result = oracle.fetchPrice("MINT-C", { bothDown: true, freshCache: true });
      expect(result).toBe(999_999n);
    }
    expect(oracle.onCritical).not.toHaveBeenCalled();
  });

  it("NEW pattern: state is per-mint (one market's outage does not trigger another's alert)", () => {
    const oracle = new FakeOracle();

    for (let i = 0; i < THRESHOLD + 1; i++) {
      oracle.fetchPrice("MINT-D", { bothDown: true, freshCache: false });
    }
    expect(oracle.onCritical).toHaveBeenCalledTimes(1);
    expect(oracle.onCritical).toHaveBeenLastCalledWith("MINT-D", expect.any(Number));

    for (let i = 0; i < THRESHOLD + 1; i++) {
      oracle.fetchPrice("MINT-E", { bothDown: true, freshCache: false });
    }
    expect(oracle.onCritical).toHaveBeenCalledTimes(2);
    expect(oracle.onCritical).toHaveBeenLastCalledWith("MINT-E", expect.any(Number));
  });
});
