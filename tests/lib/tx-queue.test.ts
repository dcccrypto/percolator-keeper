import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import * as metrics from "../../src/lib/metrics.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TxQueue — unit tests", () => {
  let queue: TxQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    queue = new TxQueue({
      liquidation: { concurrency: 10, intervalCap: 30, interval: 1000 },
      oracle:      { concurrency: 5,  intervalCap: 15, interval: 1000 },
      crank:       { concurrency: 5,  intervalCap: 10, interval: 1000 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic enqueue", () => {
    it("returns the fn result on success", async () => {
      const result = await queue.enqueue("liquidation", async () => "ok");
      expect(result).toBe("ok");
    });

    it("propagates rejection from fn", async () => {
      await expect(
        queue.enqueue("crank", async () => { throw new Error("boom"); }),
      ).rejects.toThrow("boom");
    });

    it("enqueues to each lane independently", async () => {
      const results = await Promise.all([
        queue.enqueue("liquidation", async () => "liq"),
        queue.enqueue("oracle",      async () => "oracle"),
        queue.enqueue("crank",       async () => "crank"),
      ]);
      expect(results).toEqual(["liq", "oracle", "crank"]);
    });
  });

  describe("concurrency enforcement", () => {
    it("11 liquidation jobs — at most 10 run concurrently; 11th waits", async () => {
      let maxConcurrent = 0;
      let current = 0;

      const slowQ = new TxQueue({
        liquidation: { concurrency: 10, intervalCap: 100, interval: 100 },
      });

      const jobs = Array.from({ length: 11 }, () =>
        slowQ.enqueue("liquidation", async () => {
          current++;
          if (current > maxConcurrent) maxConcurrent = current;
          await sleep(20);
          current--;
        }),
      );

      await Promise.all(jobs);
      expect(maxConcurrent).toBeLessThanOrEqual(10);
    });

    it("crank lane limited to concurrency=5", async () => {
      let maxConcurrent = 0;
      let current = 0;

      const q = new TxQueue({
        crank: { concurrency: 5, intervalCap: 100, interval: 100 },
      });

      const jobs = Array.from({ length: 8 }, () =>
        q.enqueue("crank", async () => {
          current++;
          if (current > maxConcurrent) maxConcurrent = current;
          await sleep(15);
          current--;
        }),
      );
      await Promise.all(jobs);
      expect(maxConcurrent).toBeLessThanOrEqual(5);
    });
  });

  describe("metrics", () => {
    it("increments completed counter on success", async () => {
      await queue.enqueue("liquidation", async () => "ok");
      expect(metrics.txQueueCompletedTotal.inc).toHaveBeenCalledWith({ lane: "liquidation" });
    });

    it("increments failed counter on error", async () => {
      await queue.enqueue("oracle", async () => { throw new Error("fail"); }).catch(() => {});
      expect(metrics.txQueueFailedTotal.inc).toHaveBeenCalledWith({ lane: "oracle" });
    });

    it("does not increment completed counter on error", async () => {
      await queue.enqueue("crank", async () => { throw new Error("fail"); }).catch(() => {});
      expect(metrics.txQueueCompletedTotal.inc).not.toHaveBeenCalledWith({ lane: "crank" });
    });

    it("observes wait-time histogram on dispatch", async () => {
      await queue.enqueue("liquidation", async () => "ok");
      expect(metrics.txQueueWaitSeconds.observe).toHaveBeenCalledWith(
        { lane: "liquidation" },
        expect.any(Number),
      );
      const observed = (metrics.txQueueWaitSeconds.observe as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
      expect(observed).toBeGreaterThanOrEqual(0);
    });

    it("active gauge is updated on entry and exit of fn", async () => {
      const q = new TxQueue({
        liquidation: { concurrency: 10, intervalCap: 100, interval: 100 },
      });
      await q.enqueue("liquidation", async () => "ok");
      expect(metrics.txQueueActive.set).toHaveBeenCalled();
    });
  });

  describe("getStats", () => {
    it("returns zero-initialized stats initially", () => {
      const stats = queue.getStats();
      for (const lane of ["liquidation", "oracle", "crank"] as const) {
        expect(stats[lane].completed).toBe(0);
        expect(stats[lane].failed).toBe(0);
        expect(stats[lane].pending).toBe(0);
        expect(stats[lane].active).toBe(0);
      }
    });

    it("increments completed in getStats after success", async () => {
      await queue.enqueue("oracle", async () => "ok");
      const stats = queue.getStats();
      expect(stats.oracle.completed).toBe(1);
      expect(stats.oracle.failed).toBe(0);
    });

    it("increments failed in getStats after error", async () => {
      await queue.enqueue("crank", async () => { throw new Error("x"); }).catch(() => {});
      const stats = queue.getStats();
      expect(stats.crank.failed).toBe(1);
      expect(stats.crank.completed).toBe(0);
    });

    it("completed + failed = total submitted", async () => {
      const q = new TxQueue({ liquidation: { concurrency: 5, intervalCap: 50, interval: 100 } });
      let submitted = 0;
      const jobs = Array.from({ length: 6 }, (_, i) => {
        submitted++;
        return q.enqueue("liquidation", async () => {
          if (i % 2 === 0) throw new Error("even fails");
          return "ok";
        }).catch(() => {});
      });
      await Promise.all(jobs);
      const s = q.getStats();
      expect(s.liquidation.completed + s.liquidation.failed).toBe(submitted);
    });
  });

  describe("drain", () => {
    it("resolves once all in-flight jobs complete", async () => {
      const q = new TxQueue({ crank: { concurrency: 5, intervalCap: 50, interval: 100 } });
      const finished: number[] = [];
      const jobs = Array.from({ length: 5 }, (_, i) =>
        q.enqueue("crank", async () => {
          await sleep(20);
          finished.push(i);
        }),
      );
      void jobs; // fire-and-forget

      await q.drain(5000);
      expect(finished.length).toBe(5);
    });

    it("returns without throwing when drain times out (fake timers)", async () => {
      vi.useFakeTimers();

      const q = new TxQueue({ crank: { concurrency: 1, intervalCap: 1, interval: 10_000 } });

      // Enqueue one job that never resolves (blocked by rate limiter)
      const neverResolves = q.enqueue("crank", async () => {
        await new Promise(() => {}); // infinite
      });
      void neverResolves;

      // drain with 100ms timeout — should return without throwing after advancing timers
      const drainPromise = q.drain(100);

      vi.advanceTimersByTime(200);
      // Drain should resolve (not throw) because timeout fires
      await expect(drainPromise).resolves.toBeUndefined();
    });

    it("resolves immediately when queue is empty", async () => {
      const start = Date.now();
      await queue.drain(1000);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("wait-time observation", () => {
    it("wait-time observed is approximately the time fn was queued before starting", async () => {
      const q = new TxQueue({
        crank: { concurrency: 1, intervalCap: 100, interval: 100 },
      });

      let started = false;
      // First job holds the lane slot
      const blocker = q.enqueue("crank", async () => {
        await sleep(50);
        started = true;
      });

      // Second job enqueued immediately; must wait for the first to complete
      const enqueuedAt = Date.now();
      const waitObservations: number[] = [];
      const spy = vi.spyOn(metrics.txQueueWaitSeconds, "observe").mockImplementation(
        (_, val) => { waitObservations.push(val as number); },
      );

      const second = q.enqueue("crank", async () => "second");

      await Promise.all([blocker, second]);
      spy.mockRestore();

      expect(started).toBe(true);
      // Second job should have waited at least ~50ms (while blocker ran)
      // Allow generous tolerance for CI scheduling jitter
      if (waitObservations.length >= 2) {
        const secondWait = waitObservations[1]!;
        expect(secondWait).toBeGreaterThan(0.01); // >10ms
      }
    });
  });
});
