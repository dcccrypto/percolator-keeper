/**
 * AlertAggregator — buffer high-frequency alerts and flush them as a single
 * summary so Discord (or any sink) isn't spammed during a cascade.
 *
 * Usage: per `add(key)` call we increment that key's bucket. After
 * `bufferMs` of any-key activity we flush all buckets via `flushFn(key, count)`
 * and clear them. The timer is anchored to the first `add` since the last
 * flush — not rolling — so an event 4 s into a 5 s window still flushes 1 s
 * later, not 5 s later. Bounded memory by `maxBuckets`.
 */

export interface AlertAggregatorOptions {
  /** ms between first add and flush. Default 5_000. */
  bufferMs?: number;
  /** Cap on distinct keys before forced flush. Default 1_000. */
  maxBuckets?: number;
  /** Logger used when flushFn throws — never thrown back to the caller. */
  onFlushError?: (err: unknown) => void;
  /** Injectable scheduler for tests. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Injectable cancel for tests. */
  clearTimer?: (handle: unknown) => void;
}

export type FlushFn = (key: string, count: number) => Promise<void> | void;

export class AlertAggregator {
  private readonly buckets = new Map<string, number>();
  private readonly bufferMs: number;
  private readonly maxBuckets: number;
  private readonly onFlushError: (err: unknown) => void;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timerHandle: unknown = null;

  constructor(
    private readonly flushFn: FlushFn,
    opts: AlertAggregatorOptions = {},
  ) {
    this.bufferMs = opts.bufferMs ?? 5_000;
    this.maxBuckets = opts.maxBuckets ?? 1_000;
    this.onFlushError = opts.onFlushError ?? (() => {});
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  add(key: string): void {
    const prev = this.buckets.get(key) ?? 0;
    this.buckets.set(key, prev + 1);
    if (this.buckets.size > this.maxBuckets) {
      // Cap-bound flush so a runaway producer never grows the Map unboundedly.
      void this.flush();
      return;
    }
    if (this.timerHandle === null) {
      this.timerHandle = this.setTimer(() => {
        void this.flush();
      }, this.bufferMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.buckets.size === 0) return;
    const snapshot = Array.from(this.buckets.entries());
    this.buckets.clear();
    for (const [key, count] of snapshot) {
      try {
        await this.flushFn(key, count);
      } catch (err) {
        this.onFlushError(err);
      }
    }
  }

  /** Drop pending buckets without flushing (used on shutdown when the sink is also closing). */
  stop(): void {
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }
}
