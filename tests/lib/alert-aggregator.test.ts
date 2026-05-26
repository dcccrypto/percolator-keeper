import { describe, it, expect, vi } from "vitest";
import { AlertAggregator } from "../../src/lib/alert-aggregator.js";

function makeFakeTimer() {
  let queued: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    set: vi.fn((cb: () => void, ms: number) => {
      const entry = { cb, ms, cancelled: false };
      queued.push(entry);
      return entry;
    }),
    clear: vi.fn((h: unknown) => {
      const e = h as { cancelled: boolean };
      e.cancelled = true;
    }),
    fireFirst() {
      const e = queued.shift();
      if (e && !e.cancelled) e.cb();
    },
    queued() {
      return queued.filter((e) => !e.cancelled);
    },
  };
}

describe("AlertAggregator", () => {
  it("emits one flush per key after bufferMs", async () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 5_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("liq:marketA");
    agg.add("liq:marketA");
    agg.add("liq:marketA");

    expect(flush).not.toHaveBeenCalled();
    expect(timer.set).toHaveBeenCalledTimes(1);
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 5_000);

    timer.fireFirst();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("liq:marketA", 3);
  });

  it("aggregates per-key counts across mixed keys", async () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 1_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("liq:A");
    agg.add("liq:B");
    agg.add("liq:A");
    agg.add("liq:B");
    agg.add("liq:B");

    timer.fireFirst();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith("liq:A", 2);
    expect(flush).toHaveBeenCalledWith("liq:B", 3);
  });

  it("does not re-schedule while a flush is pending", () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 1_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("k1");
    agg.add("k2");
    agg.add("k3");
    expect(timer.set).toHaveBeenCalledTimes(1);
  });

  it("schedules a new timer after a flush", async () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 1_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("k1");
    timer.fireFirst();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);

    agg.add("k1");
    expect(timer.set).toHaveBeenCalledTimes(2);
  });

  it("manual flush() drains and clears the pending timer", async () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 60_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("k1");
    await agg.flush();

    expect(flush).toHaveBeenCalledWith("k1", 1);
    expect(timer.clear).toHaveBeenCalledTimes(1);
    expect(agg.size()).toBe(0);
  });

  it("stop() drops pending buckets without flushing", () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 5_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("k1");
    agg.stop();
    expect(flush).not.toHaveBeenCalled();
    expect(agg.size()).toBe(0);
    expect(timer.clear).toHaveBeenCalledTimes(1);
  });

  it("maxBuckets triggers an immediate flush instead of unbounded growth", async () => {
    const flush = vi.fn();
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 60_000,
      maxBuckets: 3,
      setTimer: timer.set,
      clearTimer: timer.clear,
    });

    agg.add("a");
    agg.add("b");
    agg.add("c");
    agg.add("d"); // crosses cap
    await Promise.resolve();
    await Promise.resolve();

    expect(flush).toHaveBeenCalled();
    expect(agg.size()).toBeLessThanOrEqual(0);
  });

  it("flush errors are swallowed and reported via onFlushError", async () => {
    const onFlushError = vi.fn();
    const flush = vi.fn().mockRejectedValue(new Error("discord down"));
    const timer = makeFakeTimer();
    const agg = new AlertAggregator(flush, {
      bufferMs: 1_000,
      setTimer: timer.set,
      clearTimer: timer.clear,
      onFlushError,
    });

    agg.add("k");
    timer.fireFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(onFlushError).toHaveBeenCalledTimes(1);
  });
});
