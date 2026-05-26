import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { estimateLamportCost, BASE_FEE_LAMPORTS } from "../../src/lib/keeper-send.js";

// A.12: property tests for the keeper send-path cost formula.
// Formula: cost = BASE_FEE_LAMPORTS + ceil(microLamports * cu / 1_000_000) + jitoTip.
//
// These properties protect the budget cap math against silent regressions in
// the priority-fee + CU + tip composition that drives every keeper send.

describe("estimateLamportCost (A.12)", () => {
  it("property: cost is always >= BASE_FEE_LAMPORTS for any non-negative inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (microLamports, cu, jitoTip) => {
          return estimateLamportCost(microLamports, cu, jitoTip) >= BASE_FEE_LAMPORTS;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: cost is monotonically non-decreasing in cu (for fixed microLamports + tip)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (microLamports, jitoTip, cuA, cuB) => {
          const lo = Math.min(cuA, cuB);
          const hi = Math.max(cuA, cuB);
          return (
            estimateLamportCost(microLamports, lo, jitoTip) <=
            estimateLamportCost(microLamports, hi, jitoTip)
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: cost is monotonically non-decreasing in microLamports (for fixed cu + tip)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (cu, jitoTip, microA, microB) => {
          const lo = Math.min(microA, microB);
          const hi = Math.max(microA, microB);
          return (
            estimateLamportCost(lo, cu, jitoTip) <= estimateLamportCost(hi, cu, jitoTip)
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: cost == BASE + jitoTip when microLamports == 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (cu, jitoTip) => {
          return estimateLamportCost(0, cu, jitoTip) === BASE_FEE_LAMPORTS + jitoTip;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: cost == BASE + jitoTip when cu == 0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (microLamports, jitoTip) => {
          return estimateLamportCost(microLamports, 0, jitoTip) === BASE_FEE_LAMPORTS + jitoTip;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("known value: ceil rounding is correct", () => {
    // 1 microLamport * 999_999 CU = 0.999999 lamports → ceil → 1
    expect(estimateLamportCost(1, 999_999, 0)).toBe(BASE_FEE_LAMPORTS + 1);
    // 1 microLamport * 1_000_000 CU = 1 lamport
    expect(estimateLamportCost(1, 1_000_000, 0)).toBe(BASE_FEE_LAMPORTS + 1);
    // 1 microLamport * 1_000_001 CU = 1.000001 lamports → ceil → 2
    expect(estimateLamportCost(1, 1_000_001, 0)).toBe(BASE_FEE_LAMPORTS + 2);
  });
});
