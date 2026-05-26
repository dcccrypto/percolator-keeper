/**
 * Property-based tests for divergenceBps (fraud-detector).
 * fast-check: >=500 runs per property.
 *
 * Properties under test:
 *   1. Non-negativity: result is always >= 0.
 *   2. Zero identity: divergenceBps(A, A) == 0 for any A > 0.
 *   3. Zero-offchain guard: divergenceBps(A, 0) == 0 (divide-by-zero guard, caller skips).
 *   4. Monotonicity: larger absolute diff → larger or equal divergence.
 *   5. Approximate symmetry characterisation: divergenceBps(A, B) and divergenceBps(B, A)
 *      agree within a factor of 2 for non-pathological inputs (A, B both > 0, ratio < 10x).
 *      The brief prescribes |A-B|/B (offchain as denominator), so the formula is intentionally
 *      asymmetric — we test that the asymmetry is bounded, not that it is zero.
 *
 * We do not test the NaN/Infinity properties because the implementation converts
 * bigint to Number; a zero denominator is guarded explicitly. The property suite
 * verifies both bigint and Number inputs.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { divergenceBps } from "../../src/services/fraud-detector.js";

// We mute the metrics and shared imports at the module level — this file only
// imports the exported pure function, so no service-layer mocks are needed.

const NUM_RUNS = 500;

describe("divergenceBps property tests", () => {
  // 1. Non-negativity
  it("result is always non-negative for any finite inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (a, b) => {
          const result = divergenceBps(a, b);
          expect(result).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(result)).toBe(true);
          expect(Number.isNaN(result)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 2. Zero identity: divergenceBps(A, A) == 0 for A > 0
  it("divergenceBps(A, A) === 0 for any positive A", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),
        (a) => {
          expect(divergenceBps(a, a)).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 3. Zero-offchain guard: returns 0, not NaN / Infinity
  it("divergenceBps(A, 0n) returns 0 and not NaN or Infinity", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (a) => {
          const result = divergenceBps(a, 0n);
          expect(result).toBe(0);
          expect(Number.isNaN(result)).toBe(false);
          expect(Number.isFinite(result)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Same guard with Number zero
  it("divergenceBps(A, 0) returns 0 for Number inputs", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e9, noNaN: true }),
        (a) => {
          const result = divergenceBps(a, 0);
          expect(result).toBe(0);
          expect(Number.isNaN(result)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 4. Monotonicity: for fixed offchain B > 0, a larger |onchain - offchain|
  //    must produce a larger or equal divergence.
  //    We construct two onchain values equidistant from offchain on the same side.
  it("larger absolute difference → larger or equal divergence (monotonicity)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 1_000_000_000n }), // offchain
        fc.bigInt({ min: 0n, max: 500_000n }),             // smallDiff
        fc.bigInt({ min: 500_001n, max: 1_000_000n }),     // largeDiff
        (b, smallDiff, largeDiff) => {
          // Both onchain values are above offchain by different amounts
          const aSmall = b + smallDiff;
          const aLarge = b + largeDiff;
          const dSmall = divergenceBps(aSmall, b);
          const dLarge = divergenceBps(aLarge, b);
          expect(dLarge).toBeGreaterThanOrEqual(dSmall);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 5. Approximate symmetry: with offchain as denominator the result is
  //    asymmetric by construction. For inputs where both A and B are in
  //    the range [1, 2B] (i.e., ratio < 2x), the two directions must agree
  //    within a factor of 2 (they share the same numerator |A-B|; only the
  //    denominator changes). This validates the math is correct, not that
  //    it is symmetric.
  it("asymmetry is bounded within factor of 2 when A and B are within 2x of each other", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 1_000_000_000n }), // B (offchain)
        fc.bigInt({ min: 1n, max: 999n }),               // deviation as thousandths of B (< 100%)
        (b, deviationThousandths) => {
          // A is within [B - 99.9% B, B + 99.9% B] so ratio stays < 2x
          const diff = (b * deviationThousandths) / 1000n;
          const a = b + diff; // A > B case

          const dAB = divergenceBps(a, b); // |A-B|/B * 10_000
          const dBA = divergenceBps(b, a); // |B-A|/A * 10_000

          // Both numerators are the same (|diff|); denominators differ (B vs A).
          // Since A = B + diff, A >= B → dBA <= dAB.
          // The ratio dAB / dBA = A / B, which is between 1 and 2.
          // Check the weaker bound: max / min <= 2.
          const maxD = Math.max(dAB, dBA);
          const minD = Math.min(dAB, dBA);
          if (minD === 0) {
            // diff is 0 → both should be 0
            expect(maxD).toBe(0);
          } else {
            expect(maxD / minD).toBeLessThanOrEqual(2.1); // allow tiny fp rounding
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // 6. No NaN / Infinity for any Number inputs in the E6 price range
  it("never produces NaN or Infinity for E6-range Number inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000_000 }), // up to $1_000_000 in E6
        fc.integer({ min: 1, max: 1_000_000_000_000 }), // offchain > 0
        (a, b) => {
          const result = divergenceBps(a, b);
          expect(Number.isNaN(result)).toBe(false);
          expect(Number.isFinite(result)).toBe(true);
          expect(result).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
