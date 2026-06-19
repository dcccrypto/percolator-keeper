/**
 * Priority-lane transaction queue — Workstream H.
 *
 * Three p-queue lanes ensure liquidation and ADL transactions are never
 * starved behind a crank flood. Lane choice is orthogonal to keeperSend's
 * txType: txType controls budget and priority-fee tiering on-chain; the lane
 * controls which concurrency/rate-limit bucket the send sits in while it waits
 * for a slot. For example, UpdateHyperpMark calls keeperSend with txType
 * "crank" (budget category) but enqueues in the "oracle" lane (higher priority
 * than routine cranks, lower than liquidations).
 *
 * Singleton: import `sharedTxQueue` from here; constructing your own TxQueue
 * is only needed in tests.
 */

import PQueue from "p-queue";
import { createLogger } from "@percolatorct/shared";
import {
  txQueueWaitSeconds,
  txQueuePending,
  txQueueActive,
  txQueueCompletedTotal,
  txQueueFailedTotal,
} from "./metrics.js";

const logger = createLogger("keeper:tx-queue");

export type TxLane = "liquidation" | "oracle" | "crank";

const ALL_LANES: TxLane[] = ["liquidation", "oracle", "crank"];

export interface TxQueueConfig {
  liquidation?: {
    concurrency?: number;
    intervalCap?: number;
    interval?: number;
  };
  oracle?: {
    concurrency?: number;
    intervalCap?: number;
    interval?: number;
  };
  crank?: {
    concurrency?: number;
    intervalCap?: number;
    interval?: number;
  };
}

export interface TxLaneStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

function buildLaneConfig(lane: TxLane, defaults: { concurrency: number; intervalCap: number; interval: number }) {
  return {
    concurrency: parseEnvInt(`TX_QUEUE_${lane.toUpperCase()}_CONCURRENCY`, defaults.concurrency),
    intervalCap: parseEnvInt(`TX_QUEUE_${lane.toUpperCase()}_INTERVAL_CAP`, defaults.intervalCap),
    interval: parseEnvInt(`TX_QUEUE_${lane.toUpperCase()}_INTERVAL_MS`, defaults.interval),
  };
}

export class TxQueue {
  private readonly _lanes: Record<TxLane, PQueue>;
  private readonly _completed: Record<TxLane, number>;
  private readonly _failed: Record<TxLane, number>;
  private readonly _queuedRejectors: Record<TxLane, Set<(reason: Error) => void>>;

  constructor(config: TxQueueConfig = {}) {
    const liqCfg = {
      concurrency: config.liquidation?.concurrency ?? parseEnvInt("TX_QUEUE_LIQUIDATION_CONCURRENCY", 10),
      intervalCap: config.liquidation?.intervalCap ?? parseEnvInt("TX_QUEUE_LIQUIDATION_INTERVAL_CAP", 30),
      interval: config.liquidation?.interval ?? parseEnvInt("TX_QUEUE_LIQUIDATION_INTERVAL_MS", 1000),
    };
    const oracleCfg = {
      concurrency: config.oracle?.concurrency ?? parseEnvInt("TX_QUEUE_ORACLE_CONCURRENCY", 5),
      intervalCap: config.oracle?.intervalCap ?? parseEnvInt("TX_QUEUE_ORACLE_INTERVAL_CAP", 15),
      interval: config.oracle?.interval ?? parseEnvInt("TX_QUEUE_ORACLE_INTERVAL_MS", 1000),
    };
    const crankCfg = {
      concurrency: config.crank?.concurrency ?? parseEnvInt("TX_QUEUE_CRANK_CONCURRENCY", 5),
      intervalCap: config.crank?.intervalCap ?? parseEnvInt("TX_QUEUE_CRANK_INTERVAL_CAP", 10),
      interval: config.crank?.interval ?? parseEnvInt("TX_QUEUE_CRANK_INTERVAL_MS", 1000),
    };

    this._lanes = {
      liquidation: new PQueue({ concurrency: liqCfg.concurrency, intervalCap: liqCfg.intervalCap, interval: liqCfg.interval }),
      oracle:      new PQueue({ concurrency: oracleCfg.concurrency, intervalCap: oracleCfg.intervalCap, interval: oracleCfg.interval }),
      crank:       new PQueue({ concurrency: crankCfg.concurrency, intervalCap: crankCfg.intervalCap, interval: crankCfg.interval }),
    };

    this._completed = { liquidation: 0, oracle: 0, crank: 0 };
    this._failed = { liquidation: 0, oracle: 0, crank: 0 };
    this._queuedRejectors = {
      liquidation: new Set(),
      oracle: new Set(),
      crank: new Set(),
    };

    for (const lane of ALL_LANES) {
      const q = this._lanes[lane];
      q.on("add", () => {
        txQueuePending.set({ lane }, q.size);
      });
      q.on("next", () => {
        txQueuePending.set({ lane }, q.size);
        txQueueActive.set({ lane }, q.pending);
      });
      q.on("idle", () => {
        txQueuePending.set({ lane }, 0);
        txQueueActive.set({ lane }, 0);
      });
    }
  }

  enqueue<T>(lane: TxLane, fn: () => Promise<T>): Promise<T> {
    const enqueuedAt = Date.now();
    const q = this._lanes[lane];

    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const rejectQueued = (reason: Error): void => {
        if (started || settled) return;
        settled = true;
        reject(reason);
      };
      this._queuedRejectors[lane].add(rejectQueued);

      const queued = q.add(async (): Promise<T> => {
        started = true;
        this._queuedRejectors[lane].delete(rejectQueued);
        const waitMs = Date.now() - enqueuedAt;
        txQueueWaitSeconds.observe({ lane }, waitMs / 1000);
        txQueueActive.set({ lane }, q.pending);

        try {
          const result = await fn();
          this._completed[lane]++;
          txQueueCompletedTotal.inc({ lane });
          return result;
        } catch (err) {
          this._failed[lane]++;
          txQueueFailedTotal.inc({ lane });
          throw err;
        } finally {
          txQueueActive.set({ lane }, q.pending);
          txQueuePending.set({ lane }, q.size);
        }
      }) as Promise<T>;

      queued.then(
        (value) => {
          if (settled) return;
          settled = true;
          this._queuedRejectors[lane].delete(rejectQueued);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this._queuedRejectors[lane].delete(rejectQueued);
          reject(err);
        },
      );
    });
  }

  async drain(timeoutMs: number): Promise<void> {
    const idlePromises = ALL_LANES.map((lane) => this._lanes[lane].onIdle());
    const drainAll = Promise.all(idlePromises).then(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
    });

    await Promise.race([drainAll, timeoutPromise]);

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const stats = this.getStats();
    const anyPending = ALL_LANES.some((lane) => stats[lane].pending > 0 || stats[lane].active > 0);
    if (anyPending) {
      logger.warn("TxQueue drain timed out — in-flight transactions may not have landed", {
        timeoutMs,
        remaining: {
          liquidation: { pending: stats.liquidation.pending, active: stats.liquidation.active },
          oracle: { pending: stats.oracle.pending, active: stats.oracle.active },
          crank: { pending: stats.crank.pending, active: stats.crank.active },
        },
      });
    }
  }

  /**
   * Drop all queued (not-yet-started) tasks from every lane. In-flight tasks
   * (already executing) are unaffected — they run to completion.
   *
   * Called on demotion so a node that loses leadership does not process a
   * backlog of sends it queued while still leader.
   */
  clearPending(): void {
    const err = new Error("TxQueue task cleared before dispatch");
    for (const lane of ALL_LANES) {
      this._lanes[lane].clear();
      for (const rejectQueued of this._queuedRejectors[lane]) {
        rejectQueued(err);
      }
      this._queuedRejectors[lane].clear();
      txQueuePending.set({ lane }, 0);
    }
    logger.info("TxQueue: cleared all pending tasks from every lane (post-demote)");
  }

  getStats(): Record<TxLane, TxLaneStats> {
    const result = {} as Record<TxLane, TxLaneStats>;
    for (const lane of ALL_LANES) {
      const q = this._lanes[lane];
      result[lane] = {
        pending: q.size,
        active: q.pending,
        completed: this._completed[lane],
        failed: this._failed[lane],
      };
    }
    return result;
  }
}

const DRAIN_TIMEOUT_MS = parseEnvInt("TX_QUEUE_DRAIN_TIMEOUT_MS", 30_000);

export const sharedTxQueue = new TxQueue();

export { DRAIN_TIMEOUT_MS };
