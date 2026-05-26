import { describe, it, expect, vi } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../src/lib/metrics.js", () => {
  const makeCounter = () => ({ inc: vi.fn() });
  const makeGauge = () => ({ set: vi.fn() });
  const makeHistogram = () => ({ observe: vi.fn() });
  return {
    txQueueWaitSeconds: makeHistogram(),
    txQueuePending: makeGauge(),
    txQueueActive: makeGauge(),
    txQueueCompletedTotal: makeCounter(),
    txQueueFailedTotal: makeCounter(),
  };
});

import { TxQueue } from "../../src/lib/tx-queue.js";

const STRESS = process.env.STRESS === "true";

describe.skipIf(!STRESS)("TxQueue — stress tests (STRESS=true)", () => {
  it(
    "1000 cranks + 10 liqs — all 10 liquidations complete in <2s wall clock",
    { timeout: 30_000 },
    async () => {
      const q = new TxQueue({
        liquidation: { concurrency: 10, intervalCap: 1000, interval: 1 },
        oracle:      { concurrency: 5,  intervalCap: 1000, interval: 1 },
        crank:       { concurrency: 5,  intervalCap: 1000, interval: 1 },
      });

      const liqCompleted: number[] = [];
      const liqStart = Date.now();

      // Start 1000 crank jobs that each take 5ms (simulate real send overhead)
      const crankJobs = Array.from({ length: 1000 }, (_, i) =>
        q.enqueue("crank", async () => {
          await new Promise((r) => setTimeout(r, 5));
          return `crank-${i}`;
        }),
      );

      // Immediately enqueue 10 liquidations — they should NOT wait behind cranks
      const liqJobs = Array.from({ length: 10 }, (_, i) =>
        q.enqueue("liquidation", async () => {
          await new Promise((r) => setTimeout(r, 5));
          liqCompleted.push(Date.now() - liqStart);
          return `liq-${i}`;
        }),
      );

      // Wait for all liquidations to complete
      await Promise.all(liqJobs);
      const liqElapsed = Date.now() - liqStart;

      // All 10 liquidations must land within 2s
      expect(liqCompleted.length).toBe(10);
      expect(liqElapsed).toBeLessThan(2000);

      // Wait for cranks to finish (don't leave them hanging)
      await Promise.allSettled(crankJobs);
    },
  );

  it(
    "chaos: 50 in-flight + drain(30_000) completes or times out cleanly — no exception",
    { timeout: 60_000 },
    async () => {
      const q = new TxQueue({
        crank: { concurrency: 50, intervalCap: 1000, interval: 1 },
      });

      // Enqueue 50 jobs that each take 100ms
      const jobs = Array.from({ length: 50 }, (_, i) =>
        q.enqueue("crank", async () => {
          await new Promise((r) => setTimeout(r, 100));
          return i;
        }),
      );

      // Drain with a 30s timeout — should complete within the 5s window
      // since all 50 jobs run in parallel and complete in ~100ms
      await expect(q.drain(30_000)).resolves.toBeUndefined();

      // All jobs should land
      const results = await Promise.allSettled(jobs);
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      expect(succeeded).toBe(50);
    },
  );

  it(
    "SIGTERM drain simulation: drain(100ms timeout) with long-running jobs logs warning and returns",
    { timeout: 15_000 },
    async () => {
      const q = new TxQueue({
        crank: { concurrency: 1, intervalCap: 1, interval: 10_000 },
      });

      // Enqueue one job that runs immediately but is slow
      let jobStarted = false;
      const slowJob = q.enqueue("crank", async () => {
        jobStarted = true;
        await new Promise((r) => setTimeout(r, 2000)); // 2s
        return "done";
      });

      // Give the job a moment to start
      await new Promise((r) => setTimeout(r, 20));

      expect(jobStarted).toBe(true);

      // Drain with a very short timeout — should return without throwing
      const drainStart = Date.now();
      await expect(q.drain(100)).resolves.toBeUndefined();
      const drainMs = Date.now() - drainStart;

      // Drain returned quickly (≤ 300ms including some scheduling jitter)
      expect(drainMs).toBeLessThan(300);

      // Clean up the lingering job
      await Promise.allSettled([slowJob]);
    },
  );
});

// Always-on smoke — runs in normal CI without STRESS=true
describe("TxQueue — stress smoke (always on)", () => {
  it(
    "100 cranks + 5 liqs — liqs complete in reasonable time",
    { timeout: 30_000 },
    async () => {
      const q = new TxQueue({
        liquidation: { concurrency: 5, intervalCap: 500, interval: 1 },
        oracle:      { concurrency: 5, intervalCap: 500, interval: 1 },
        crank:       { concurrency: 5, intervalCap: 500, interval: 1 },
      });

      const liqStart = Date.now();
      const liqCompleted: number[] = [];

      // 100 cranks (2ms each)
      const cranks = Array.from({ length: 100 }, (_, i) =>
        q.enqueue("crank", async () => {
          await new Promise((r) => setTimeout(r, 2));
          return i;
        }),
      );

      // 5 liqs (2ms each)
      const liqs = Array.from({ length: 5 }, (_, i) =>
        q.enqueue("liquidation", async () => {
          await new Promise((r) => setTimeout(r, 2));
          liqCompleted.push(Date.now() - liqStart);
          return i;
        }),
      );

      await Promise.all(liqs);
      expect(liqCompleted.length).toBe(5);

      await Promise.allSettled(cranks);

      const stats = q.getStats();
      expect(stats.liquidation.completed).toBe(5);
      expect(stats.liquidation.failed).toBe(0);
    },
  );
});
