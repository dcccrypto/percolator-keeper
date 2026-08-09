import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaderLock } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

/**
 * PoC — leader renewal has no deadline, so a hung Redis keeps a node believing
 * it is leader past its lease expiry (split-brain double-send).
 *
 * `_renew()` awaits `redis.eval(RENEW_SCRIPT, ...)` with no timeout, and the
 * Upstash client is constructed with no request signal. Demotion is purely
 * event-driven — it happens only when the eval THROWS (2-strike counter) or
 * RETURNS a lease-lost result. A hung/partitioned Redis (fetch that neither
 * resolves nor rejects) produces neither, so `_renew` stalls forever, no new
 * renew timer is scheduled, and `_role` stays "leader" indefinitely. Meanwhile
 * the Redis lock TTL lapses and a standby acquires it — now two nodes act as
 * leader against a permissionless program (duplicate liquidations / sends).
 *
 * A correct leader must relinquish leadership by the time the lease it last set
 * would expire (ttlMs since the last successful renewal), regardless of why
 * renewal stopped succeeding. This PoC hangs every renewal and asserts the node
 * has demoted itself by the lease deadline. It FAILS before the fix (stuck
 * "leader") and passes after.
 */

const KEY = "keeper:leader:devnet";
type SetOpts = { ex: number; nx?: true } | { ex: number; xx?: true };

describe("LeaderLock hung-renewal lease expiry (PoC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("demotes by the lease deadline when Redis renewal hangs", async () => {
    const store = new Map<string, string>();
    const redis: RedisLike = {
      async set(key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        if (hasNx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null;
      },
      async del(...keys: string[]): Promise<number> {
        let n = 0;
        for (const k of keys) if (store.delete(k)) n++;
        return n;
      },
      // Renewal hangs forever — Redis partitioned/unresponsive mid-request, the
      // fetch neither resolves nor rejects.
      eval<T>(): Promise<T> {
        return new Promise<T>(() => {});
      },
    };

    const lock = new LeaderLock(redis, "node-a", {
      ttlMs: 30_000,
      renewMs: 10_000,
      pollMs: 5_000,
    });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });

    await vi.advanceTimersByTimeAsync(100);
    expect(lock.role()).toBe("leader");
    expect(store.has(KEY)).toBe(true);

    // Renewal fires at 10s and hangs. By the 30s lease deadline the node must
    // relinquish leadership — otherwise a standby that acquires the expired lock
    // and this node both act (split-brain). Advance just past the deadline.
    await vi.advanceTimersByTimeAsync(31_000);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalled();

    await lock.stop();
  });
});
