import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaderLock } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

/**
 * PoC: a leader that is demoted (transient Redis renew failure) must resume
 * polling so it can re-acquire leadership once Redis recovers and the lock is
 * free again.
 *
 * On current `main` `_demote()` clears both timers and enters "standby" WITHOUT
 * scheduling a standby poll (unlike `_enterStandby()`), so the node is parked
 * forever: services are stopped via onDemote and nothing ever re-acquires.
 * For a single-replica HA deployment that is a permanent, silent total outage
 * after one Redis blip; for a multi-replica cluster every node retires the
 * first time it is demoted until the whole cluster is dark.
 *
 * Both assertions below FAIL on current main and pass after the fix.
 */

const KEY = "keeper:leader:devnet";
type SetOpts = { ex: number; nx?: true } | { ex: number; xx?: true };

describe("LeaderLock demote recovery (PoC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-acquires leadership after a transient renew failure once Redis recovers", async () => {
    const store = new Map<string, string>();
    // Toggled true while we want the periodic RENEW (eval CAS) to fail,
    // simulating a transient Redis outage that costs the leader its lock.
    let renewShouldFail = true;

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
      async eval<T>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
        // Simulate transient Redis failure during renew (CAS eval).
        if (renewShouldFail) throw new Error("Redis connection refused");
        // CAS: return 1 if we still own the lock, 0 otherwise.
        const current = store.get(keys[0] ?? "");
        if (current === args[0]) return 1 as unknown as T;
        return 0 as unknown as T;
      },
    };

    const lock = new LeaderLock(redis, "node-a", {
      ttlMs: 30_000,
      renewMs: 10_000,
      pollMs: 5_000,
    });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(store.has(KEY)).toBe(true);

    // Two consecutive renew failures → demote("redis-renew-failed").
    await vi.advanceTimersByTimeAsync(10_100); // 1st failure → retry scheduled
    expect(lock.role()).toBe("leader");
    await vi.advanceTimersByTimeAsync(10_100); // 2nd failure → demote
    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-renew-failed");

    // Redis recovers and the stale lock expires server-side (TTL) so it is free.
    renewShouldFail = false;
    store.delete(KEY);

    // A healthy node MUST poll and re-acquire within pollMs. On current main no
    // poll was ever scheduled after demotion, so it stays standby forever.
    await vi.advanceTimersByTimeAsync(5_100);

    expect(lock.role()).toBe("leader"); // FAILS on main: stuck in "standby"
    expect(onPromote).toHaveBeenCalledTimes(2); // recovery promote never fires on main

    await lock.stop();
  });

  it("re-acquires after a stolen-lock demotion (eval returns 0) once the lock frees", async () => {
    const store = new Map<string, string>();
    // eval CAS returns 0 while the lock is considered lost; flip to allow
    // a fresh nx acquire on recovery.
    let lockLost = false;

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
      async eval<T>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
        // CAS renew: return 0 when lock is considered lost (identity mismatch/gone).
        if (lockLost) return 0 as unknown as T;
        const current = store.get(keys[0] ?? "");
        if (current === args[0]) return 1 as unknown as T;
        return 0 as unknown as T;
      },
    };

    const lock = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);
    expect(lock.role()).toBe("leader");

    // Lock stolen/expired: next renew eval returns 0 → single-failure demote.
    lockLost = true;
    store.delete(KEY);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-lock-lost");

    // Lock is free again; standby poll must re-acquire.
    lockLost = false;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledTimes(2);

    await lock.stop();
  });

  it("stop() after demotion cancels the recovery poll — no zombie re-promotion", async () => {
    const store = new Map<string, string>();
    let renewShouldFail = true;

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
      async eval<T>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
        if (renewShouldFail) throw new Error("Redis connection refused");
        const current = store.get(keys[0] ?? "");
        if (current === args[0]) return 1 as unknown as T;
        return 0 as unknown as T;
      },
    };

    const lock = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    lock.start({ network: "devnet", onPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    expect(lock.role()).toBe("leader");

    await vi.advanceTimersByTimeAsync(10_100);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("standby");

    // Operator shuts the node down before the recovery poll fires.
    await lock.stop();

    // Free the lock and advance well past pollMs — a stopped node must NOT
    // resurrect itself.
    renewShouldFail = false;
    store.delete(KEY);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(lock.role()).toBe("standby");
    expect(onPromote).toHaveBeenCalledTimes(1); // only the original promote

    await lock.stop();
  });

  it("does not promote when stop() lands mid-poll (use-after-stop guard)", async () => {
    const store = new Map<string, string>(); // lock is free
    const lock = new LeaderLock(
      // get() shuts the node down before returning, simulating stop() landing
      // while the poll is awaiting Redis. The post-await _stopped re-check must
      // then prevent promotion.
      {
        async set(key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
          const hasNx = "nx" in opts && opts.nx === true;
          if (hasNx && store.has(key)) return null;
          store.set(key, value);
          return "OK";
        },
        async get(key: string): Promise<string | null> {
          // Stop the node mid-poll, then report the lock as free.
          await lock.stop();
          return store.get(key) ?? null;
        },
        async del(...keys: string[]): Promise<number> {
          let n = 0;
          for (const k of keys) if (store.delete(k)) n++;
          return n;
        },
        async eval<T>(): Promise<T> {
          // This test starts in standby — renew (eval) is never called.
          throw new Error("eval should not be called in this test");
        },
      },
      "node-a",
      { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 },
    );
    const onPromote = vi.fn();

    // Start as standby (another node holds the lock) so the poll loop runs.
    store.set(KEY, "other");
    lock.start({ network: "devnet", onPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    expect(lock.role()).toBe("standby");

    // Free the lock so the poll WOULD promote if the guard were missing, then
    // let the poll fire (its get() calls stop() mid-flight).
    store.delete(KEY);
    await vi.advanceTimersByTimeAsync(5_100);

    expect(onPromote).not.toHaveBeenCalled();
    expect(lock.role()).toBe("standby");
  });
});
