/**
 * Property tests for shadow-harness divergence formula.
 * ≥500 runs per property (fast-check default ≥ 100, overridden to 500 here).
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeDivergencePct } from "../../src/lib/shadow-harness.js";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  shadowDecisionsTotal: { inc: vi.fn() },
  shadowMatchTotal: { inc: vi.fn() },
  shadowDivergencePct: { set: vi.fn() },
}));

import { vi } from "vitest";

const NUM_RUNS = 500;

// Arbitrary non-negative safe integer for shadow/live totals.
const nonNegSafeInt = fc.nat({ max: Number.MAX_SAFE_INTEGER });

describe("computeDivergencePct — property tests (≥500 runs)", () => {
  it("result is always in [0, 100] for any non-negative integers", () => {
    fc.assert(
      fc.property(nonNegSafeInt, nonNegSafeInt, (shadow, live) => {
        const result = computeDivergencePct(shadow, live);
        return result >= 0 && result <= 100;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("result is never NaN for any non-negative integers", () => {
    fc.assert(
      fc.property(nonNegSafeInt, nonNegSafeInt, (shadow, live) => {
        const result = computeDivergencePct(shadow, live);
        return !Number.isNaN(result);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("result is never Infinity for any non-negative integers", () => {
    fc.assert(
      fc.property(nonNegSafeInt, nonNegSafeInt, (shadow, live) => {
        const result = computeDivergencePct(shadow, live);
        return Number.isFinite(result);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("when both are 0, result is 0 (no activity = no divergence)", () => {
    expect(computeDivergencePct(0, 0)).toBe(0);
  });

  it("when shadow === live AND both > 0, result is 0 (perfect match)", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (n) => {
        if (n === 0) return true; // 0,0 case handled above
        return computeDivergencePct(n, n) === 0;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("when matches=0 (one side is 0) and other > 0, result is 100", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (n) => {
        if (n === 0) return true; // 0,0 case handled separately
        return computeDivergencePct(n, 0) === 100 && computeDivergencePct(0, n) === 100;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("divergence is symmetric: computeDivergencePct(a, b) === computeDivergencePct(b, a)", () => {
    fc.assert(
      fc.property(nonNegSafeInt, nonNegSafeInt, (a, b) => {
        return computeDivergencePct(a, b) === computeDivergencePct(b, a);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("divergence is monotone: more imbalanced inputs produce >= divergence", () => {
    // shadow=n, live=2n is more imbalanced than shadow=n, live=n+1
    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), (n) => {
        if (n === 0) return true;
        const balanced = computeDivergencePct(n, n + 1);
        const imbalanced = computeDivergencePct(n, 2 * n);
        return imbalanced >= balanced;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
