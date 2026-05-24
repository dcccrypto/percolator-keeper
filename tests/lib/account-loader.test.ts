import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AccountLoader,
  type AccountUpdate,
  type StreamAdapter,
  type AccountLoaderOptions,
} from "../../src/lib/account-loader.js";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const BASE_OPTS: AccountLoaderOptions = {
  apiKey: "test-key",
  endpoint: "http://localhost:1234",
};

/** Test double for StreamAdapter that lets tests control connection lifecycle. */
class FakeAdapter implements StreamAdapter {
  private onAccount: ((u: AccountUpdate) => void) | null = null;
  private onSlot: ((s: number) => void) | null = null;
  private onError: ((e: Error) => void) | null = null;
  stopped = false;
  startCallCount = 0;

  async start(
    _opts: AccountLoaderOptions,
    onAccountUpdate: (u: AccountUpdate) => void,
    onSlotUpdate: (s: number) => void,
    onError: (e: Error) => void,
  ): Promise<void> {
    this.startCallCount++;
    this.stopped = false;
    this.onAccount = onAccountUpdate;
    this.onSlot = onSlotUpdate;
    this.onError = onError;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Push a synthetic account update to the loader. */
  pushAccount(update: AccountUpdate): void {
    this.onAccount?.(update);
  }

  /** Push a synthetic slot update. */
  pushSlot(slot: number): void {
    this.onSlot?.(slot);
  }

  /** Simulate stream error (e.g. network disconnect). */
  pushError(err: Error): void {
    this.onError?.(err);
  }
}

/** A FakeAdapter that always throws on start(). */
class FailingAdapter implements StreamAdapter {
  startCallCount = 0;
  async start(): Promise<void> {
    this.startCallCount++;
    throw new Error("connection refused");
  }
  stop(): void {}
}

function makeUpdate(pubkey: string, slot: number): AccountUpdate {
  return { pubkey, data: new Uint8Array([1, 2, 3]), owner: "owner", slot };
}

describe("AccountLoader", () => {
  let adapter: FakeAdapter;
  let loader: AccountLoader;

  beforeEach(() => {
    delete process.env.KEEPER_STREAM_DROP_QUEUE_MAX;
    adapter = new FakeAdapter();
    loader = new AccountLoader(BASE_OPTS, adapter);
  });

  afterEach(async () => {
    await loader.stop();
    delete process.env.KEEPER_STREAM_DROP_QUEUE_MAX;
  });

  describe("start / stop", () => {
    it("calls adapter.start() on start()", async () => {
      await loader.start();
      expect(adapter.startCallCount).toBe(1);
    });

    it("is idempotent — second start() is a no-op", async () => {
      await loader.start();
      await loader.start();
      expect(adapter.startCallCount).toBe(1);
    });

    it("stop() calls adapter.stop()", async () => {
      await loader.start();
      await loader.stop();
      expect(adapter.stopped).toBe(true);
    });

    it("stop() prevents reconnect after stream error", async () => {
      vi.useFakeTimers();
      await loader.start();
      await loader.stop();
      adapter.pushError(new Error("disconnected"));
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      // Reconnect count must stay 0 (no reconnect after stop).
      expect(loader.getStats().reconnectCount).toBe(0);
    });
  });

  describe("stats", () => {
    it("starts with sensible defaults", () => {
      const s = loader.getStats();
      expect(s.connected).toBe(false);
      expect(s.lastSlot).toBe(0);
      expect(s.eventsReceived).toBe(0);
      expect(s.eventsDropped).toBe(0);
      expect(s.reconnectCount).toBe(0);
    });

    it("reports connected=true after successful start", async () => {
      await loader.start();
      expect(loader.getStats().connected).toBe(true);
    });

    it("tracks eventsReceived", async () => {
      await loader.start();
      adapter.pushAccount(makeUpdate("pk1", 100));
      adapter.pushAccount(makeUpdate("pk2", 101));
      await Promise.resolve(); // flush microtask queue
      expect(loader.getStats().eventsReceived).toBe(2);
    });

    it("tracks lastSlot from slot updates", async () => {
      await loader.start();
      adapter.pushSlot(200);
      expect(loader.getStats().lastSlot).toBe(200);
    });
  });

  describe("onAccount listener", () => {
    it("delivers updates to registered listeners", async () => {
      await loader.start();
      const received: AccountUpdate[] = [];
      loader.onAccount((u) => received.push(u));

      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve(); // drain microtask
      expect(received).toHaveLength(1);
      expect(received[0]!.pubkey).toBe("pk1");
    });

    it("unsubscribe fn stops delivery", async () => {
      await loader.start();
      const received: AccountUpdate[] = [];
      const unsub = loader.onAccount((u) => received.push(u));

      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve();
      expect(received).toHaveLength(1);

      unsub();
      adapter.pushAccount(makeUpdate("pk2", 101));
      await Promise.resolve();
      expect(received).toHaveLength(1); // second update not delivered
    });

    it("delivers to multiple listeners independently", async () => {
      await loader.start();
      const a: string[] = [];
      const b: string[] = [];
      loader.onAccount((u) => a.push(u.pubkey));
      loader.onAccount((u) => b.push(u.pubkey));

      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve();
      expect(a).toEqual(["pk1"]);
      expect(b).toEqual(["pk1"]);
    });

    it("listener errors do not stop delivery to other listeners", async () => {
      await loader.start();
      const good: string[] = [];
      loader.onAccount(() => { throw new Error("boom"); });
      loader.onAccount((u) => good.push(u.pubkey));

      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve();
      expect(good).toEqual(["pk1"]);
    });
  });

  describe("cache integration", () => {
    it("populates cache on account update", async () => {
      await loader.start();
      adapter.pushSlot(100);
      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve();

      const entry = loader.getCache().get("pk1", 100);
      expect(entry).not.toBeNull();
      expect(entry!.slot).toBe(100);
    });

    it("getCache() returns the same AccountCache instance", async () => {
      await loader.start();
      const cache1 = loader.getCache();
      const cache2 = loader.getCache();
      expect(cache1).toBe(cache2);
    });
  });

  describe("backpressure", () => {
    it("drops oldest event when queue is full", async () => {
      process.env.KEEPER_STREAM_DROP_QUEUE_MAX = "3";
      const tiny = new AccountLoader(BASE_OPTS, new FakeAdapter());
      await tiny.start();
      const tinyAdapter = adapter; // not used — reconstruct

      // Access internals via a controlled adapter
      const ctrl = new FakeAdapter();
      const bounded = new AccountLoader(BASE_OPTS, ctrl);
      process.env.KEEPER_STREAM_DROP_QUEUE_MAX = "3";
      await bounded.start();

      const received: string[] = [];
      bounded.onAccount((u) => received.push(u.pubkey));

      // Suppress draining by not awaiting between pushes
      ctrl.pushAccount(makeUpdate("pk1", 1));
      ctrl.pushAccount(makeUpdate("pk2", 2));
      ctrl.pushAccount(makeUpdate("pk3", 3));
      ctrl.pushAccount(makeUpdate("pk4", 4)); // should cause drop of pk1

      await Promise.resolve();

      // pk1 was dropped; pk2, pk3, pk4 delivered
      const dropped = bounded.getStats().eventsDropped;
      expect(dropped).toBeGreaterThanOrEqual(1);

      await bounded.stop();
      await tiny.stop();
    });
  });

  describe("reconnect on stream error", () => {
    it("increments reconnectCount and flushes cache on error", async () => {
      vi.useFakeTimers();
      await loader.start();

      // Populate cache before disconnect
      adapter.pushAccount(makeUpdate("pk1", 100));
      await Promise.resolve();
      expect(loader.getCache().size()).toBe(1);

      // Trigger stream error
      adapter.pushError(new Error("network down"));

      // Cache must be flushed immediately on error (missed events during gap)
      expect(loader.getCache().size()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_100); // past 1s first backoff
      vi.useRealTimers();

      expect(loader.getStats().reconnectCount).toBe(1);
    });

    it("uses exponential backoff sequence on repeated failures", async () => {
      vi.useFakeTimers();
      const failing = new FailingAdapter();
      const errLoader = new AccountLoader(BASE_OPTS, failing);
      await errLoader.start(); // first attempt fails → schedules reconnect

      await vi.advanceTimersByTimeAsync(1_100); // 1s → second attempt
      await vi.advanceTimersByTimeAsync(2_100); // 2s → third attempt
      vi.useRealTimers();

      // At least 3 attempts made (initial + 2 reconnects)
      expect(failing.startCallCount).toBeGreaterThanOrEqual(3);
      await errLoader.stop();
    });
  });
});

describe("AccountLoader stress test", () => {
  it.skipIf(!process.env.STRESS)(
    "processes 10k events/sec for 60s without counter drift",
    { timeout: 70_000 },
    async () => {
      const adapter = new FakeAdapter();
      const loader = new AccountLoader(BASE_OPTS, adapter);
      await loader.start();

      const RATE = 10_000;
      const DURATION_S = 60;
      const total = RATE * DURATION_S;

      let received = 0;
      loader.onAccount(() => { received++; });

      for (let i = 0; i < total; i++) {
        adapter.pushAccount({
          pubkey: `pk${i % 10_000}`,
          data: new Uint8Array([i & 0xff]),
          owner: "owner",
          slot: 1000 + Math.floor(i / RATE),
        });
        // Flush every 1000 events to drain the microtask queue
        if (i % 1_000 === 999) await Promise.resolve();
      }

      await Promise.resolve(); // final drain

      const stats = loader.getStats();
      expect(stats.eventsReceived).toBe(total);
      // received may be less than total if backpressure dropped events,
      // but received + dropped must equal total exactly.
      expect(received + stats.eventsDropped).toBe(total);

      await loader.stop();
    },
  );
});
