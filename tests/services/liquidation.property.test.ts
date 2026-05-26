import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeMarginRatioBps } from "../../src/services/liquidation.js";

// A.13: property tests for computeMarginRatioBps. The B3 fix removed an
// unreachable `-1` sentinel; these properties pin down the semantics that
// scanMarket + liquidate both depend on, so the two call sites can't drift.

describe("computeMarginRatioBps (A.13)", () => {
  it("property: result is non-negative for any (equity, notional) with notional > 0n", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        (equity, notional) => {
          return computeMarginRatioBps(equity, notional) >= 0n;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: equity == 0n always returns 0n (regardless of notional)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        (notional) => {
          return computeMarginRatioBps(0n, notional) === 0n;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: notional == 0n always returns 0n (regardless of equity)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        (equity) => {
          return computeMarginRatioBps(equity, 0n) === 0n;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: equity < 0n always returns 0n (underwater is treated as liquidatable, not negative)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: -1n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        (equity, notional) => {
          return computeMarginRatioBps(equity, notional) === 0n;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: monotonic non-decreasing in equity for fixed notional > 0n (when both equity values are positive)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        (eqA, eqB, notional) => {
          const lo = eqA < eqB ? eqA : eqB;
          const hi = eqA < eqB ? eqB : eqA;
          return computeMarginRatioBps(lo, notional) <= computeMarginRatioBps(hi, notional);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: monotonic non-increasing in notional for fixed equity > 0n (more notional = lower ratio)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        (equity, notA, notB) => {
          const lo = notA < notB ? notA : notB;
          const hi = notA < notB ? notB : notA;
          // Higher notional → lower (or equal) ratio
          return computeMarginRatioBps(equity, hi) <= computeMarginRatioBps(equity, lo);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("known values: bigint truncation matches the live call sites", () => {
    expect(computeMarginRatioBps(0n, 100n)).toBe(0n);
    expect(computeMarginRatioBps(-1n, 100n)).toBe(0n);
    expect(computeMarginRatioBps(100n, 0n)).toBe(0n);
    // equity = notional → exactly 1.0× = 10_000 bps
    expect(computeMarginRatioBps(1000n, 1000n)).toBe(10_000n);
    // equity = 2× notional → 20_000 bps
    expect(computeMarginRatioBps(2000n, 1000n)).toBe(20_000n);
    // equity = 0.05 × notional → 500 bps (matches typical 5% maintenance margin)
    expect(computeMarginRatioBps(50n, 1000n)).toBe(500n);
  });
});
