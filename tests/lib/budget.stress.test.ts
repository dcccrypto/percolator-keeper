import { describe, it, expect } from "vitest";
import { KeeperBudget } from "../../src/lib/budget.js";

const STRESS = process.env.STRESS === "true";

const STRESS_CONFIG = {
  maxSolPerCycle: Number.MAX_SAFE_INTEGER,
  maxSolPerHour: Number.MAX_SAFE_INTEGER,
  maxSolPerDay: Number.MAX_SAFE_INTEGER,
  maxTxPerCycle: Number.MAX_SAFE_INTEGER,
  txSuccessRateWindow: 60_000,
  txSuccessRateThreshold: 0.5,
  txSuccessRateMinSamples: 10,
} as const;

describe.skipIf(!STRESS)("KeeperBudget — stress (10k concurrent ops)", () => {
  it(
    "10,000 interleaved canSpend + recordTx calls — no counter drift",
    async () => {
      const b = new KeeperBudget(STRESS_CONFIG, { now: () => 1_700_000_000_000 });
      const N = 10_000;
      const LAMPORTS = 100;
      const promises: Promise<void>[] = [];
      let expectedSpendNonDrop = 0;
      let expectedTxCount = 0;
      for (let i = 0; i < N; i++) {
        promises.push(
          new Promise<void>((resolve) => {
            b.canSpend(LAMPORTS, "crank");
            const result = i % 3 === 0 ? "drop" : i % 2 === 0 ? "success" : "fail";
            if (result !== "drop") expectedSpendNonDrop += LAMPORTS;
            expectedTxCount += 1;
            b.recordTx(LAMPORTS, "crank", result);
            resolve();
          }),
        );
      }
      await Promise.all(promises);

      const stats = b.getStats();
      expect(stats.cycleTxCount).toBe(expectedTxCount);
      expect(stats.cycleSpend).toBe(expectedSpendNonDrop);
      expect(stats.hourSpend).toBe(expectedSpendNonDrop);
      expect(stats.daySpend).toBe(expectedSpendNonDrop);
    },
    60_000,
  );

  it(
    "10,000 ops finish under 5 seconds wall clock",
    async () => {
      const b = new KeeperBudget(STRESS_CONFIG, { now: () => 1_700_000_000_000 });
      const N = 10_000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        b.canSpend(100, "crank");
        b.recordTx(100, "crank", i % 2 === 0 ? "success" : "fail");
      }
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(5_000);
    },
    30_000,
  );

  it(
    "halt latches under 10k op stream — exactly one halt fires",
    async () => {
      let haltCount = 0;
      const tight = { ...STRESS_CONFIG, maxSolPerCycle: 50 };
      const b = new KeeperBudget(tight, {
        now: () => 1_700_000_000_000,
        onHalt: () => {
          haltCount++;
        },
      });
      for (let i = 0; i < 10_000; i++) {
        b.canSpend(10, "crank");
        b.recordTx(10, "crank", "success");
      }
      expect(haltCount).toBe(1);
      expect(b.isHalted()).toBe(true);
    },
    30_000,
  );
});

// Always-on lightweight version: 1k ops to catch egregious bugs in CI without STRESS=true
describe("KeeperBudget — lightweight concurrency smoke (1k ops, always on)", () => {
  it("1,000 interleaved ops keep counters consistent", async () => {
    const b = new KeeperBudget(STRESS_CONFIG, { now: () => 1_700_000_000_000 });
    const N = 1_000;
    const LAMPORTS = 100;
    let expectedSpendNonDrop = 0;
    let expectedTxCount = 0;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        Promise.resolve().then(() => {
          b.canSpend(LAMPORTS, "crank");
          const result = i % 3 === 0 ? "drop" : i % 2 === 0 ? "success" : "fail";
          if (result !== "drop") expectedSpendNonDrop += LAMPORTS;
          expectedTxCount += 1;
          b.recordTx(LAMPORTS, "crank", result);
        }),
      );
    }
    await Promise.all(promises);
    const stats = b.getStats();
    expect(stats.cycleTxCount).toBe(expectedTxCount);
    expect(stats.cycleSpend).toBe(expectedSpendNonDrop);
    expect(stats.hourSpend).toBe(expectedSpendNonDrop);
  });
});
