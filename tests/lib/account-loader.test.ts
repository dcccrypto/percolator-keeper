import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
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

/**
 * C3: minimal Connection stub exposing only getMultipleAccountsInfoAndContext.
 * The real type is large; the loader only calls this one method.
 */
interface AccountInfoLite {
  data: Uint8Array;
  owner: PublicKey;
}
function makeMockConnection(opts: {
  accounts: Record<string, AccountInfoLite | null>;
  slot?: number;
  throws?: Error;
  trackCalls?: { count: number; lastChunkSizes: number[] };
}) {
  return {
    getMultipleAccountsInfoAndContext: vi.fn(
      async (pubkeys: PublicKey[]) => {
        if (opts.trackCalls) {
          opts.trackCalls.count++;
          opts.trackCalls.lastChunkSizes.push(pubkeys.length);
        }
        if (opts.throws) throw opts.throws;
        return {
          context: { slot: opts.slot ?? 1000 },
          value: pubkeys.map((p) => opts.accounts[p.toBase58()] ?? null),
        };
      },
    ),
  };
}

// Two valid Solana pubkeys for additionalAccounts tests.
const PK_A = "So11111111111111111111111111111111111111112";
const PK_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

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

  describe("C3: RPC snapshot on (re)connect", () => {
    it("seeds cache from RPC before adapter.start() returns", async () => {
      const conn = makeMockConnection({
        accounts: {
          [PK_A]: { data: new Uint8Array([0xaa, 0xbb]), owner: new PublicKey(OWNER) },
          [PK_B]: { data: new Uint8Array([0xcc]), owner: new PublicKey(OWNER) },
        },
        slot: 5000,
      });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: [PK_A, PK_B], connection: conn as never },
        ad,
      );
      await l.start();

      expect(conn.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
      // The snapshot must run before adapter.start completes — otherwise
      // downstream code could read from the cache during the gap. We assert
      // this indirectly: at the moment loader.start() resolves, the cache is
      // already populated.
      const a = l.getCache().get(PK_A, 5000);
      const b = l.getCache().get(PK_B, 5000);
      expect(a?.slot).toBe(5000);
      expect(b?.slot).toBe(5000);
      expect(a?.owner).toBe(OWNER);
      await l.stop();
    });

    it("schedules reconnect when snapshot RPC throws and leaves connected=false", async () => {
      vi.useFakeTimers();
      const conn = makeMockConnection({
        accounts: {},
        throws: new Error("rpc 503"),
      });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: [PK_A], connection: conn as never },
        ad,
      );
      await l.start();

      // adapter.start() must NOT have been called — snapshot ran first and failed.
      expect(ad.startCallCount).toBe(0);
      expect(l.getStats().connected).toBe(false);
      // Reconnect must be queued.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(l.getStats().reconnectCount).toBeGreaterThanOrEqual(1);
      vi.useRealTimers();
      await l.stop();
    });

    it("re-runs snapshot after stream error → reconnect", async () => {
      vi.useFakeTimers();
      const conn = makeMockConnection({
        accounts: {
          [PK_A]: { data: new Uint8Array([1]), owner: new PublicKey(OWNER) },
        },
        slot: 7000,
      });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: [PK_A], connection: conn as never },
        ad,
      );
      await l.start();
      expect(conn.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);

      ad.pushError(new Error("stream dropped"));
      // Cache flushed on error (existing behavior).
      expect(l.getCache().size()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_100); // first backoff
      await Promise.resolve();
      vi.useRealTimers();

      // Snapshot must have been re-run on reconnect.
      expect(conn.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(2);
      expect(l.getCache().get(PK_A, 7000)?.slot).toBe(7000);
      await l.stop();
    });

    it("chunks additionalAccounts > 100 into separate RPC calls", async () => {
      // Build 250 valid pubkeys (we use derived seeds of PK_A for simplicity).
      // Easier: use a sequence of 32-byte buffers cast through PublicKey.
      const pubkeys: string[] = [];
      const accountsMap: Record<string, AccountInfoLite> = {};
      for (let i = 0; i < 250; i++) {
        const bytes = new Uint8Array(32);
        bytes[0] = i & 0xff;
        bytes[1] = (i >> 8) & 0xff;
        const pk = new PublicKey(bytes).toBase58();
        pubkeys.push(pk);
        accountsMap[pk] = { data: new Uint8Array([1]), owner: new PublicKey(OWNER) };
      }
      const tracker = { count: 0, lastChunkSizes: [] as number[] };
      const conn = makeMockConnection({ accounts: accountsMap, slot: 8000, trackCalls: tracker });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: pubkeys, connection: conn as never },
        ad,
      );
      await l.start();

      // 250 / 100 = 3 chunks (100, 100, 50).
      expect(tracker.count).toBe(3);
      expect(tracker.lastChunkSizes).toEqual([100, 100, 50]);
      expect(l.getCache().size()).toBe(250);
      await l.stop();
    });

    it("skips snapshot when no connection is provided (degraded mode)", async () => {
      // No `connection` opt — loader logs warn and proceeds without seeding.
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: [PK_A] },
        ad,
      );
      await l.start();
      expect(l.getStats().connected).toBe(true);
      expect(l.getCache().size()).toBe(0);
      await l.stop();
    });

    it("skips snapshot when additionalAccounts is empty (no RPC call)", async () => {
      const conn = makeMockConnection({ accounts: {} });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, connection: conn as never },
        ad,
      );
      await l.start();
      expect(conn.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
      expect(l.getStats().connected).toBe(true);
      await l.stop();
    });

    it("skips entries whose RPC value is null (account does not exist)", async () => {
      const conn = makeMockConnection({
        accounts: {
          [PK_A]: { data: new Uint8Array([1]), owner: new PublicKey(OWNER) },
          [PK_B]: null,
        },
        slot: 9000,
      });
      const ad = new FakeAdapter();
      const l = new AccountLoader(
        { ...BASE_OPTS, additionalAccounts: [PK_A, PK_B], connection: conn as never },
        ad,
      );
      await l.start();
      expect(l.getCache().get(PK_A, 9000)?.slot).toBe(9000);
      expect(l.getCache().get(PK_B, 9000)).toBeNull();
      await l.stop();
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
