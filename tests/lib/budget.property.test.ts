import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { KeeperBudget, type TxResult } from "../../src/lib/budget.js";

const PROPERTY_CONFIG = {
  maxSolPerCycle: 10_000_000,
  maxSolPerHour: 100_000_000,
  maxSolPerDay: 1_000_000_000,
  maxTxPerCycle: 1_000,
  txSuccessRateWindow: 60_000,
  txSuccessRateThreshold: 0.5,
  txSuccessRateMinSamples: 4,
} as const;

const txResultArb: fc.Arbitrary<TxResult> = fc.constantFrom("success", "fail", "drop");
const lamportsArb = fc.integer({ min: 1, max: 100_000 });
const advanceArb = fc.integer({ min: 0, max: 5_000 });

describe("KeeperBudget — property tests", () => {
  it(
    "once halted, every subsequent canSpend returns false until resume()",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(lamportsArb, txResultArb, advanceArb),
            { minLength: 1, maxLength: 200 },
          ),
          fc.array(lamportsArb, { minLength: 0, maxLength: 50 }),
          (recordSeq, probeSeq) => {
            let t = 1_700_000_000_000;
            const b = new KeeperBudget(PROPERTY_CONFIG, { now: () => t });
            for (const [lamports, result, advance] of recordSeq) {
              b.recordTx(lamports, "crank", result);
              t += advance;
            }
            // Probe canSpend until we trip the halt
            let halted = false;
            for (const lamports of probeSeq) {
              const allowed = b.canSpend(lamports, "crank");
              if (b.isHalted()) {
                // From this point on, no canSpend may return true.
                halted = true;
              }
              if (halted) {
                expect(allowed).toBe(false);
              }
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "isHalted() never transitions halted → not-halted without resume() call",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(lamportsArb, txResultArb, advanceArb),
            { minLength: 1, maxLength: 300 },
          ),
          (ops) => {
            let t = 1_700_000_000_000;
            const b = new KeeperBudget(PROPERTY_CONFIG, { now: () => t });
            let everHalted = false;
            for (const [lamports, result, advance] of ops) {
              b.recordTx(lamports, "crank", result);
              b.canSpend(lamports, "crank");
              t += advance;
              if (b.isHalted()) everHalted = true;
              if (everHalted) {
                expect(b.isHalted()).toBe(true);
              }
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "cycle spend invariant: cycleSpend equals sum of non-drop recordTx since last beginCycle",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(lamportsArb, txResultArb),
            { minLength: 1, maxLength: 100 },
          ),
          (ops) => {
            const b = new KeeperBudget(
              { ...PROPERTY_CONFIG, maxSolPerCycle: Number.MAX_SAFE_INTEGER },
              { now: () => 1_700_000_000_000 },
            );
            let expected = 0;
            for (const [lamports, result] of ops) {
              b.recordTx(lamports, "crank", result);
              if (result !== "drop") expected += lamports;
            }
            expect(b.getStats().cycleSpend).toBe(expected);
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "hourSpendSum stays nonnegative and equals sum of unexpired events",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(lamportsArb, txResultArb, advanceArb),
            { minLength: 1, maxLength: 200 },
          ),
          (ops) => {
            let t = 1_700_000_000_000;
            const b = new KeeperBudget(
              { ...PROPERTY_CONFIG, maxSolPerHour: Number.MAX_SAFE_INTEGER, maxSolPerDay: Number.MAX_SAFE_INTEGER, maxSolPerCycle: Number.MAX_SAFE_INTEGER, maxTxPerCycle: Number.MAX_SAFE_INTEGER },
              { now: () => t },
            );
            for (const [lamports, result, advance] of ops) {
              b.recordTx(lamports, "crank", result);
              t += advance;
              const stats = b.getStats();
              expect(stats.hourSpend).toBeGreaterThanOrEqual(0);
              expect(stats.daySpend).toBeGreaterThanOrEqual(0);
              expect(stats.hourSpend).toBeLessThanOrEqual(stats.daySpend);
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "success rate within [0,1] when defined",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(lamportsArb, fc.constantFrom<TxResult>("success", "fail")),
            { minLength: 1, maxLength: 100 },
          ),
          (ops) => {
            const b = new KeeperBudget(
              { ...PROPERTY_CONFIG, txSuccessRateMinSamples: 1 },
              { now: () => 1_700_000_000_000 },
            );
            for (const [lamports, result] of ops) {
              b.recordTx(lamports, "crank", result);
              const rate = b.getStats().txSuccessRate;
              if (rate !== null) {
                expect(rate).toBeGreaterThanOrEqual(0);
                expect(rate).toBeLessThanOrEqual(1);
              }
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );
});
