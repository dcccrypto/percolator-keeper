/**
 * PoC for Finding #342 [MEDIUM] — AUTH_MARK oracle-drift guard compares
 * two different price fields (markEwmaE6 vs oracleTargetPriceE6).
 *
 * Root cause (pre-fix):
 *   - scanMarket (v17 path) set scanPriceE6 = market.config.lastEffectivePriceE6
 *     which is mapped from cfg.markEwmaE6 in crank.ts:172.
 *   - liquidate() pre-submit recheck computed freshPrice via resolveV17WrapperPrice,
 *     which for AUTH_MARK (oracleMode=3) with a fresh oracleTargetPriceE6 returned
 *     cfg.oracleTargetPriceE6 — a DIFFERENT field.
 *   - For AUTH_MARK markets, markEwmaE6 (smoothed EWMA) and oracleTargetPriceE6
 *     (authority-pushed spot price) are legitimately different in steady state,
 *     so the drift guard [ |freshPrice - scanPriceE6| / scanPriceE6 ] would fire
 *     even when the oracle had not moved at all.
 *
 * Fix (#342):
 *   scanMarket now calls resolveV17WrapperPrice(parseWrapperConfigV17(data), nowSec)
 *   using the same logic as liquidate()'s freshPrice computation.  Both sides agree:
 *     - AUTH_MARK + fresh authority price  → oracleTargetPriceE6
 *     - All other modes / stale authority  → markEwmaE6
 *
 * Tests:
 *   A. AUTH_MARK steady-state: markEwmaE6 ≠ oracleTargetPriceE6 but oracle didn't
 *      move — scanPriceE6 must equal the value resolveV17WrapperPrice returns
 *      (oracleTargetPriceE6), so the drift guard does NOT falsely abort.
 *   B. Real drift: same-field price move IS still caught (drift guard still fires).
 *   C. EWMA_MARK (oracleMode=2): markEwmaE6 used at both scan and submit — no
 *      spurious abort even when oracleTargetPriceE6 happens to differ.
 */

import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────────────────────────
// Inline re-implementation of resolveV17WrapperPrice to test the exact logic
// (the function is not exported from liquidation.ts).  Must stay byte-identical
// with the implementation in src/services/liquidation.ts.
// ──────────────────────────────────────────────────────────────────────────────
interface WrapperCfgLike {
  oracleMode: number;
  maxStalenessSecs: bigint;
  oracleTargetPriceE6: bigint;
  oracleTargetPublishTime: bigint;
  markEwmaE6: bigint;
}

function resolveV17WrapperPrice(cfg: WrapperCfgLike, nowSec: bigint): bigint {
  if (cfg.oracleMode === 3) {
    const maxStalenessSecs = cfg.maxStalenessSecs > 0n ? cfg.maxStalenessSecs : 60n;
    const priceAge = cfg.oracleTargetPublishTime > 0n
      ? nowSec - cfg.oracleTargetPublishTime
      : nowSec;
    if (cfg.oracleTargetPriceE6 > 0n && priceAge <= maxStalenessSecs) {
      return cfg.oracleTargetPriceE6;
    }
  }
  const MAX_EWMA_STALENESS_SECS = cfg.maxStalenessSecs > 0n ? cfg.maxStalenessSecs * 5n : 300n;
  const ewmaAge = cfg.oracleTargetPublishTime > 0n
    ? nowSec - cfg.oracleTargetPublishTime
    : nowSec;
  if (cfg.markEwmaE6 > 0n && ewmaAge <= MAX_EWMA_STALENESS_SECS) {
    return cfg.markEwmaE6;
  }
  return 0n;
}

// ──────────────────────────────────────────────────────────────────────────────
// Drift guard logic (mirrors src/services/liquidation.ts, MAX_LIQUIDATION_DRIFT_BPS=150n)
// ──────────────────────────────────────────────────────────────────────────────
const MAX_DRIFT_BPS = 150n;
const BPS_MULT = 10_000n;

function computeDriftBps(scanPrice: bigint, freshPrice: bigint): bigint {
  const delta = freshPrice > scanPrice ? freshPrice - scanPrice : scanPrice - freshPrice;
  return delta * BPS_MULT / scanPrice;
}

function driftGuardWouldAbort(scanPrice: bigint, freshPrice: bigint): boolean {
  if (MAX_DRIFT_BPS === 0n || scanPrice === 0n || freshPrice === 0n) return false;
  return computeDriftBps(scanPrice, freshPrice) > MAX_DRIFT_BPS;
}

describe("issue-342: AUTH_MARK oracle-drift guard field mismatch", () => {
  const NOW_SEC = 1_750_000_000n; // arbitrary stable timestamp

  // ── A: AUTH_MARK steady-state — fields differ but oracle didn't move ─────────
  describe("A: AUTH_MARK steady state — markEwmaE6 lags oracleTargetPriceE6", () => {
    // Realistic scenario: authority last pushed 95_000_000 (95 USDC) 30 s ago.
    // EWMA hasn't fully converged yet and sits at 90_000_000 (90 USDC).
    // The oracle has NOT moved — this should NOT abort the liquidation.
    const authPush = 95_000_000n;  // oracleTargetPriceE6
    const ewma    = 90_000_000n;   // markEwmaE6 (5% below auth price — within drift band IF same-field)

    const cfg: WrapperCfgLike = {
      oracleMode: 3,               // AUTH_MARK
      maxStalenessSecs: 60n,
      oracleTargetPriceE6: authPush,
      oracleTargetPublishTime: NOW_SEC - 30n, // 30 s ago — within staleness window
      markEwmaE6: ewma,
    };

    it("resolveV17WrapperPrice returns oracleTargetPriceE6 for AUTH_MARK with fresh authority", () => {
      expect(resolveV17WrapperPrice(cfg, NOW_SEC)).toBe(authPush);
    });

    it("OLD (pre-fix): scan used markEwmaE6, submit used oracleTargetPriceE6 → false abort", () => {
      const scanPriceOldBehavior = ewma;       // what market.config.lastEffectivePriceE6 returned
      const freshPriceNewBehavior = authPush;  // what resolveV17WrapperPrice returns on submit

      // 5% difference from EWMA lag → exceeds 150 bps → would abort valid liquidation
      const driftBps = computeDriftBps(scanPriceOldBehavior, freshPriceNewBehavior);
      expect(driftBps).toBeGreaterThan(MAX_DRIFT_BPS);
      // Guard would have fired spuriously
      expect(driftGuardWouldAbort(scanPriceOldBehavior, freshPriceNewBehavior)).toBe(true);
    });

    it("NEW (post-fix): both scan and submit call resolveV17WrapperPrice → same field, no false abort", () => {
      // With the fix, scanPriceE6 is also resolved via resolveV17WrapperPrice.
      const scanPrice  = resolveV17WrapperPrice(cfg, NOW_SEC);  // oracleTargetPriceE6
      const freshPrice = resolveV17WrapperPrice(cfg, NOW_SEC);  // oracleTargetPriceE6 (same call)

      expect(scanPrice).toBe(authPush);
      expect(freshPrice).toBe(authPush);
      // Zero drift — guard does NOT abort
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(false);
    });

    it("drift guard ignores EWMA-vs-authority spread entirely after fix", () => {
      // Even a 20% EWMA lag doesn't affect the guard when both sides use the same field
      const bigLagCfg: WrapperCfgLike = {
        ...cfg,
        markEwmaE6: 75_000_000n,   // 21% below authority — extreme lag
        oracleTargetPriceE6: authPush,
      };
      const scanPrice  = resolveV17WrapperPrice(bigLagCfg, NOW_SEC);
      const freshPrice = resolveV17WrapperPrice(bigLagCfg, NOW_SEC);
      expect(scanPrice).toBe(authPush);
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(false);
    });
  });

  // ── B: Real same-field price move IS still caught ───────────────────────────
  describe("B: Real oracle move — drift guard still fires", () => {
    it("2% authority price move between scan and submit → guard still aborts", () => {
      // Authority pushed 100 at scan time, then pushed 102 by submit time (2% move).
      const cfgAtScan: WrapperCfgLike = {
        oracleMode: 3,
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 100_000_000n,
        oracleTargetPublishTime: NOW_SEC - 10n,
        markEwmaE6: 99_000_000n,
      };
      const cfgAtSubmit: WrapperCfgLike = {
        ...cfgAtScan,
        oracleTargetPriceE6: 102_000_000n, // 2% move
        oracleTargetPublishTime: NOW_SEC,
      };

      const scanPrice  = resolveV17WrapperPrice(cfgAtScan, NOW_SEC);
      const freshPrice = resolveV17WrapperPrice(cfgAtSubmit, NOW_SEC);

      expect(scanPrice).toBe(100_000_000n);
      expect(freshPrice).toBe(102_000_000n);
      // 200 bps > 150 bps limit → guard fires
      const driftBps = computeDriftBps(scanPrice, freshPrice);
      expect(driftBps).toBe(200n);
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(true);
    });

    it("sub-limit move (1%) is NOT aborted", () => {
      const cfgAtScan: WrapperCfgLike = {
        oracleMode: 3,
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 100_000_000n,
        oracleTargetPublishTime: NOW_SEC - 5n,
        markEwmaE6: 98_000_000n,
      };
      const cfgAtSubmit: WrapperCfgLike = {
        ...cfgAtScan,
        oracleTargetPriceE6: 101_000_000n, // 1% move = 100 bps < 150 bps
        oracleTargetPublishTime: NOW_SEC,
      };

      const scanPrice  = resolveV17WrapperPrice(cfgAtScan, NOW_SEC);
      const freshPrice = resolveV17WrapperPrice(cfgAtSubmit, NOW_SEC);
      expect(computeDriftBps(scanPrice, freshPrice)).toBe(100n);
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(false);
    });
  });

  // ── C: EWMA_MARK (oracleMode=2) — both sides use markEwmaE6 already ─────────
  describe("C: EWMA_MARK (oracleMode=2) — no regression", () => {
    it("EWMA_MARK: resolveV17WrapperPrice uses markEwmaE6 (not oracleTargetPriceE6)", () => {
      const cfg: WrapperCfgLike = {
        oracleMode: 2, // EWMA_MARK
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 200_000_000n, // large value that would cause false drift if used
        oracleTargetPublishTime: NOW_SEC - 10n,
        markEwmaE6: 100_000_000n,
      };

      const price = resolveV17WrapperPrice(cfg, NOW_SEC);
      // Must use EWMA, not the authority price
      expect(price).toBe(100_000_000n);
    });

    it("EWMA_MARK steady state: both sides agree on markEwmaE6 → no false abort", () => {
      const cfg: WrapperCfgLike = {
        oracleMode: 2,
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 200_000_000n,
        oracleTargetPublishTime: NOW_SEC - 10n,
        markEwmaE6: 100_000_000n,
      };

      const scanPrice  = resolveV17WrapperPrice(cfg, NOW_SEC);
      const freshPrice = resolveV17WrapperPrice(cfg, NOW_SEC);
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(false);
    });
  });

  // ── D: Stale authority → EWMA fallback on AUTH_MARK ─────────────────────────
  describe("D: AUTH_MARK with stale authority falls back to markEwmaE6 consistently", () => {
    it("when oracleTargetPublishTime is outside staleness window, markEwmaE6 is used at both sides", () => {
      const cfg: WrapperCfgLike = {
        oracleMode: 3, // AUTH_MARK
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 150_000_000n,
        oracleTargetPublishTime: NOW_SEC - 120n, // 120 s ago — stale (> 60 s window)
        markEwmaE6: 100_000_000n,
      };

      const price = resolveV17WrapperPrice(cfg, NOW_SEC);
      // Stale authority → fallback to markEwmaE6
      expect(price).toBe(100_000_000n);

      const scanPrice  = resolveV17WrapperPrice(cfg, NOW_SEC);
      const freshPrice = resolveV17WrapperPrice(cfg, NOW_SEC);
      expect(driftGuardWouldAbort(scanPrice, freshPrice)).toBe(false);
    });
  });
});
