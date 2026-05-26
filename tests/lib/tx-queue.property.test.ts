import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

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
import type { TxLane } from "../../src/lib/tx-queue.js";

const ALL_LANES: TxLane[] = ["liquidation", "oracle", "crank"];

function makeUnlimitedQueue(): TxQueue {
  return new TxQueue({
    liquidation: { concurrency: 200, intervalCap: 10_000, interval: 1 },
    oracle:      { concurrency: 200, intervalCap: 10_000, interval: 1 },
    crank:       { concurrency: 200, intervalCap: 10_000, interval: 1 },
  });
}

describe("TxQueue — property tests (fast-check)", () => {
  it("invariant: completed + failed + active + pending == total submitted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            lane: fc.constantFrom<TxLane>("liquidation", "oracle", "crank"),
            shouldFail: fc.boolean(),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (submissions) => {
          const q = makeUnlimitedQueue();
          let total = 0;

          const jobs = submissions.map(({ lane, shouldFail }) => {
            total++;
            return q.enqueue(lane, async () => {
              if (shouldFail) throw new Error("property-test failure");
              return "ok";
            }).catch(() => {});
          });

          await Promise.all(jobs);

          const stats = q.getStats();
          let completedSum = 0;
          let failedSum = 0;
          let pendingSum = 0;
          let activeSum = 0;

          for (const lane of ALL_LANES) {
            completedSum += stats[lane].completed;
            failedSum += stats[lane].failed;
            pendingSum += stats[lane].pending;
            activeSum += stats[lane].active;
          }

          // All jobs are done, so pending+active must be 0
          expect(pendingSum).toBe(0);
          expect(activeSum).toBe(0);
          expect(completedSum + failedSum).toBe(total);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("invariant: per-lane completed_total monotonically increases", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<TxLane>("liquidation", "oracle", "crank"),
          { minLength: 2, maxLength: 30 },
        ),
        async (lanes) => {
          const q = makeUnlimitedQueue();
          const snapshots: Record<TxLane, number[]> = {
            liquidation: [],
            oracle: [],
            crank: [],
          };

          for (const lane of lanes) {
            await q.enqueue(lane, async () => "ok");
            const stats = q.getStats();
            snapshots[lane].push(stats[lane].completed);
          }

          // Each lane's completed sequence must be non-decreasing
          for (const lane of ALL_LANES) {
            const seq = snapshots[lane];
            for (let i = 1; i < seq.length; i++) {
              expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("invariant: drain() resolves within timeoutMs + 200ms epsilon", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 100, max: 400 }),
        async (jobCount, timeoutMs) => {
          const q = makeUnlimitedQueue();

          // Submit fast jobs that complete quickly
          const jobs = Array.from({ length: jobCount }, () =>
            q.enqueue("crank", async () => {
              await new Promise((r) => setTimeout(r, 1));
              return "ok";
            }),
          );

          const drainStart = Date.now();
          await q.drain(timeoutMs);
          const drainMs = Date.now() - drainStart;

          // All jobs should have landed (fast enough to beat the timeout)
          await Promise.allSettled(jobs);

          // Drain must not wildly exceed timeoutMs + epsilon
          const epsilon = 200;
          expect(drainMs).toBeLessThan(timeoutMs + epsilon);
        },
      ),
      { numRuns: 500 },
    );
  });
});
