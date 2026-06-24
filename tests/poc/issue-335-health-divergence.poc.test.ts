/**
 * PoC for Finding #335 [HIGH] — liquidation health divergence RESIDUAL.
 *
 * #330/#331 already added aggregate maintenance, per-asset effective_price, and
 * minNonzeroMmReq to scanV17Portfolios. The RESIDUAL items fixed here:
 *   1. Pre-submit recheck shares the SAME aggregate-maintenance evaluator as the
 *      scan (no per-leg vs aggregate divergence) — both now call
 *      evaluateV17PortfolioHealth().
 *   2. Positive-PnL conservatism: equity = capital + min(pnl, 0n) - feeDebt. The
 *      engine haircuts positive PnL to realizable source support
 *      (account_haircut_equity, percolator src/v16.rs:8451; positive PnL with no
 *      source claims contributes ZERO), which the keeper cannot reproduce
 *      off-chain — so it counts positive PnL at 0 (safe: only flags MORE).
 *   3. Target/effective-price lag penalty ADDED to per-leg maintenance
 *      (src/v16.rs:1207). long: effective>raw_target; short: raw_target>effective.
 *   4. Conservative "unknown": a missing required input flags for verification
 *      (treats as candidate), never returns "healthy".
 *
 * This drives the REAL exported evaluateV17PortfolioHealth() with byte-accurate
 * market buffers, asserting every divergence case flags liquidatable.
 */
import { describe, it, expect } from "vitest";
import { evaluateV17PortfolioHealth } from "../../src/services/liquidation.js";

// Per-asset slot byte offsets (must match src/lib/v17-risk.ts).
const V17_MARKET_GROUP_OFF = 448;
const V17_MARKET_GROUP_LEN = 758;
const V17_ASSET_ORACLE_WRAPPER_LEN = 512;
const V17_ASSET_SLOT_STRIDE = 1797;
const V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT = 25;
const V17_RAW_ORACLE_TARGET_PRICE_OFF_IN_ASSET_SLOT = 17;

function slotBase(assetIndex: number): number {
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN
    + assetIndex * V17_ASSET_SLOT_STRIDE
    + V17_ASSET_ORACLE_WRAPPER_LEN;
}

/**
 * Build a market-data buffer with per-asset effective_price and (optionally)
 * raw_oracle_target_price written at the correct offsets.
 */
function buildMarketData(
  assets: Array<{ assetIndex: number; effectivePrice: bigint; rawTargetPrice?: bigint }>,
): Uint8Array {
  let maxOff = 0;
  for (const a of assets) {
    maxOff = Math.max(maxOff, slotBase(a.assetIndex) + V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT + 8);
  }
  const buf = new Uint8Array(maxOff);
  const dv = new DataView(buf.buffer);
  for (const a of assets) {
    const base = slotBase(a.assetIndex);
    dv.setBigUint64(base + V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT, a.effectivePrice, true);
    if (a.rawTargetPrice !== undefined) {
      dv.setBigUint64(base + V17_RAW_ORACLE_TARGET_PRICE_OFF_IN_ASSET_SLOT, a.rawTargetPrice, true);
    }
  }
  return buf;
}

// Minimal PortfolioV17-shaped object (only fields the evaluator reads).
function mkPf(opts: {
  capital: bigint;
  pnl: bigint;
  feeCredits?: bigint;
  legs: Array<{ active: boolean; basisPosQ: bigint; assetIndex: number }>;
}): any {
  return {
    capital: opts.capital,
    pnl: opts.pnl,
    feeCredits: opts.feeCredits ?? 0n,
    legs: opts.legs.map((l) => ({ ...l, side: l.basisPosQ < 0n ? 1 : 0 })),
  };
}

const RISK = { maintenanceMarginBps: 500n, minNonzeroMmReq: 0n }; // 5%

describe("#335 PoC — shared aggregate-maintenance health evaluator", () => {
  it("AGGREGATE: two legs each individually fine, aggregate insolvent → liquidatable", () => {
    // Each leg: absPos 10_000, price $1 → notional 10_000, maintenance 500.
    // Two legs → aggregate maintenance 1_000. Equity 900: above each leg (500),
    // below the aggregate (1_000). The OLD per-leg check missed this; the shared
    // evaluator catches it in BOTH scan and pre-submit recheck.
    const md = buildMarketData([
      { assetIndex: 0, effectivePrice: 1_000_000n },
      { assetIndex: 1, effectivePrice: 1_000_000n },
    ]);
    const pf = mkPf({
      capital: 900n,
      pnl: 0n,
      legs: [
        { active: true, basisPosQ: 10_000n, assetIndex: 0 },
        { active: true, basisPosQ: 10_000n, assetIndex: 1 },
      ],
    });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(true);
    expect(h.deficit).toBe(100n); // 1_000 - 900
    expect(h.closeQ).toBe(10_000n);
  });

  it("FLOOR: minNonzeroMmReq clamps tiny-position maintenance up → liquidatable", () => {
    // Dust position: raw maintenance ~0, but minNonzeroMmReq floor = 1_000.
    const md = buildMarketData([{ assetIndex: 0, effectivePrice: 1_000_000n }]);
    const pf = mkPf({ capital: 500n, pnl: 0n, legs: [{ active: true, basisPosQ: 1n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, { maintenanceMarginBps: 500n, minNonzeroMmReq: 1_000n }, 1_000_000n);
    expect(h.liquidatable).toBe(true); // 500 < 1_000 floor
  });

  it("LAG PENALTY: long with effective > raw_target adds penalty → liquidatable", () => {
    // absPos 10_000, effective $1.00, raw_target $0.90 (adverse for a long).
    // base notional = 10_000, base maintenance = 500.
    // adverse_delta = 1_000_000 - 900_000 = 100_000.
    // lag penalty = ceil(10_000 * 100_000 / 1_000_000) = ceil(1_000_000_000/1e6) = 1_000.
    // leg maintenance = 500 + 1_000 = 1_500. Equity 900 < 1_500 → liquidatable.
    // WITHOUT the penalty (base 500), equity 900 would have looked HEALTHY.
    const md = buildMarketData([
      { assetIndex: 0, effectivePrice: 1_000_000n, rawTargetPrice: 900_000n },
    ]);
    const pf = mkPf({ capital: 900n, pnl: 0n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(true);

    // Control: with raw_target == effective (no lag), equity 900 > base 500 → healthy.
    const mdNoLag = buildMarketData([
      { assetIndex: 0, effectivePrice: 1_000_000n, rawTargetPrice: 1_000_000n },
    ]);
    const hNoLag = evaluateV17PortfolioHealth(pf, mdNoLag, RISK, 1_000_000n);
    expect(hNoLag.liquidatable).toBe(false);
  });

  it("LAG PENALTY: short with raw_target > effective adds penalty → liquidatable", () => {
    // Short leg (negative basisPosQ). adverse when raw_target > effective.
    const md = buildMarketData([
      { assetIndex: 0, effectivePrice: 900_000n, rawTargetPrice: 1_000_000n },
    ]);
    const pf = mkPf({ capital: 900n, pnl: 0n, legs: [{ active: true, basisPosQ: -10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 900_000n);
    expect(h.liquidatable).toBe(true);
  });

  it("POSITIVE-PnL HAIRCUT: face-value pnl would look healthy; conservative pnl=0 flags it", () => {
    // capital 100, positive pnl 1_000, no fee debt. Position needs maintenance 500.
    // Face-value equity = 100 + 1_000 = 1_100 > 500 → would look HEALTHY (false neg).
    // Conservative equity = 100 + min(1_000,0) = 100 < 500 → liquidatable (safe).
    const md = buildMarketData([{ assetIndex: 0, effectivePrice: 1_000_000n }]);
    const pf = mkPf({ capital: 100n, pnl: 1_000n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(true);
  });

  it("NEGATIVE-PnL is still fully counted", () => {
    // capital 600, pnl -200 → equity 400 < maintenance 500 → liquidatable.
    const md = buildMarketData([{ assetIndex: 0, effectivePrice: 1_000_000n }]);
    const pf = mkPf({ capital: 600n, pnl: -200n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(true);
  });

  it("WRONG/MISSING PRICE: an active leg with no resolvable price is flagged (conservative-unknown)", () => {
    // marketData too short to hold the asset slot AND fallbackPrice 0 → legPrice 0n.
    // Must NOT return healthy: flag for verification (candidate).
    const md = new Uint8Array(10); // too short
    const pf = mkPf({ capital: 1_000_000n, pnl: 0n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 0n);
    expect(h.liquidatable).toBe(true);
    expect(h.closeQ).toBe(10_000n);
  });

  it("HEALTHY: well-collateralized portfolio is NOT liquidatable (no false positives)", () => {
    const md = buildMarketData([{ assetIndex: 0, effectivePrice: 1_000_000n, rawTargetPrice: 1_000_000n }]);
    const pf = mkPf({ capital: 1_000_000n, pnl: 0n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(false);
  });

  it("equity<=0n is unconditionally liquidatable (H-8 defense-in-depth)", () => {
    const md = buildMarketData([{ assetIndex: 0, effectivePrice: 1_000_000n }]);
    const pf = mkPf({ capital: 0n, pnl: 0n, feeCredits: -100n, legs: [{ active: true, basisPosQ: 10_000n, assetIndex: 0 }] });
    const h = evaluateV17PortfolioHealth(pf, md, RISK, 1_000_000n);
    expect(h.liquidatable).toBe(true);
  });
});
