import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaderLock } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

// ─── Mock Redis ───────────────────────────────────────────────────────────────

type SetOpts = { ex: number; nx?: true } | { ex: number; xx?: true };

function makeMockRedis(): {
  redis: RedisLike;
  store: Map<string, string>;
  calls: { set: number; get: number; del: number; eval: number };
  failNext: { set?: boolean; get?: boolean; eval?: boolean };
} {
  const store = new Map<string, string>();
  const calls = { set: 0, get: 0, del: 0, eval: 0 };
  const failNext = { set: false, get: false, eval: false };

  const redis: RedisLike = {
    async set(key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
      calls.set++;
      if (failNext.set) { failNext.set = false; throw new Error("Redis error"); }
      const hasNx = "nx" in opts && opts.nx === true;
      const hasXx = "xx" in opts && (opts as { xx?: true }).xx === true;
      if (hasNx && store.has(key)) return null;
      if (hasXx && !store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      calls.get++;
      if (failNext.get) { failNext.get = false; throw new Error("Redis error"); }
      return store.get(key) ?? null;
    },
    async del(...keys: string[]): Promise<number> {
      calls.del++;
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    // C2: emulate the LeaderLock RENEW_SCRIPT semantics. We only model the
    // single Lua script the keeper actually invokes — anything else throws.
    async eval<T = unknown>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
      calls.eval++;
      if (failNext.eval) { failNext.eval = false; throw new Error("Redis error"); }
      const [key] = keys;
      const expectedIdentity = args[0] as string;
      const stored = store.get(key!);
      if (stored === undefined) return 0 as unknown as T;
      if (stored !== expectedIdentity) return 0 as unknown as T;
      // PEXPIRE returns 1 on success. We do not model TTL in this in-memory mock.
      return 1 as unknown as T;
    },
  };

  return { redis, store, calls, failNext };
}

// ─── Unit tests: state machine ────────────────────────────────────────────────

describe("LeaderLock state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts in 'starting' role before start() is called", () => {
    const { redis } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    expect(lock.role()).toBe("starting");
  });

  it("promotes to leader when lock is free", async () => {
    const { redis } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();
    expect(onDemote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("enters standby when another leader holds the lock", async () => {
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-keeper-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();
    expect(onDemote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("standby promotes when leader releases lock", async () => {
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-keeper-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    store.delete("keeper:leader:devnet");

    // Advance past pollMs (5000ms)
    await vi.advanceTimersByTimeAsync(6_000);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();

    await lock.stop();
  });

  it("leader renews lock on schedule", async () => {
    const { redis, calls } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    // C2: renewal moved from SET XX to a fenced Lua EVAL — count EVALs, not SETs.
    const evalCountAfterPromote = calls.eval;
    expect(lock.role()).toBe("leader");

    await vi.advanceTimersByTimeAsync(10_100);
    expect(calls.eval).toBeGreaterThan(evalCountAfterPromote);
    expect(lock.role()).toBe("leader");

    await lock.stop();
  });

  it("demotes after two consecutive renew failures", async () => {
    // C2: renewal now uses Lua EVAL; transient thrown errors from the EVAL
    // call still observe the 2-strike tolerance (M15 is unchanged by C2).
    const mockRedis: RedisLike = {
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        return hasNx ? "OK" : null;
      },
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async eval<T = unknown>(): Promise<T> {
        throw new Error("Redis connection refused");
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(onPromote).toHaveBeenCalledOnce();

    // First renew failure
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("leader");
    expect(onDemote).not.toHaveBeenCalled();

    // Second renew failure triggers demotion
    await vi.advanceTimersByTimeAsync(10_100);
    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-renew-failed");
  });

  it("standby poll error does NOT promote (fail-safe)", async () => {
    let pollCallCount = 0;
    const { redis, store } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-id");

    const mockRedis: RedisLike = {
      set: redis.set.bind(redis),
      del: redis.del.bind(redis),
      eval: redis.eval.bind(redis),
      async get(key: string): Promise<string | null> {
        pollCallCount++;
        if (pollCallCount <= 2) throw new Error("network partition");
        return redis.get(key);
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    // Poll errors — must stay standby
    await vi.advanceTimersByTimeAsync(5_100);
    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();

    await lock.stop();
  });

  it("stop() releases lock and DELs the key when leader", async () => {
    const { redis, store } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(store.has("keeper:leader:devnet")).toBe(true);

    await lock.stop();

    expect(store.has("keeper:leader:devnet")).toBe(false);
    expect(lock.role()).toBe("standby");
  });

  it("stop() when standby does not call del", async () => {
    const { redis, store, calls } = makeMockRedis();
    store.set("keeper:leader:devnet", "other-id");

    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");

    await lock.stop();
    expect(calls.del).toBe(0);
  });

  it("demotes when renew fencing fails (lock stolen)", async () => {
    let setCallCount = 0;
    const mockRedis: RedisLike = {
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        setCallCount++;
        const hasNx = "nx" in opts && opts.nx === true;
        if (setCallCount === 1 && hasNx) return "OK";
        return null;
      },
      // C2: fenced renew returns 0 when identity no longer matches the stored
      // value — definitive lease loss, demote immediately.
      async eval<T = unknown>(): Promise<T> {
        return 0 as unknown as T;
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");

    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-lock-lost");
  });

  it("lock key includes the network name", async () => {
    const { redis, store } = makeMockRedis();
    const lock = new LeaderLock(redis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "mainnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(store.has("keeper:leader:mainnet")).toBe(true);
    expect(store.has("keeper:leader:devnet")).toBe(false);

    await lock.stop();
  });

  it("C2: renews via fenced Lua EVAL, not SET XX", async () => {
    // The previous A.6 test asserted that renewal used SET XX. The C2 finding
    // showed SET XX is value-blind and allows split-brain; the renew path now
    // uses an atomic compare-and-pexpire via EVAL. This test guards the new
    // contract: renew issues at most one SET (the NX-acquire) and uses eval
    // for ongoing renewals.
    const setCalls: Array<SetOpts> = [];
    const evalCalls: Array<{ keys: string[]; args: (string | number)[] }> = [];
    let identity = "";
    const mockRedis: RedisLike = {
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(_key: string, value: string, opts: SetOpts): Promise<"OK" | null> {
        setCalls.push(opts);
        const hasNx = "nx" in opts && opts.nx === true;
        if (setCalls.length === 1 && hasNx) { identity = value; return "OK"; }
        return null;
      },
      async eval<T = unknown>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
        evalCalls.push({ keys, args });
        const expected = args[0] as string;
        return (expected === identity ? 1 : 0) as unknown as T;
      },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10_100);

    // One SET (the NX-acquire), at least one EVAL (the renewal).
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]).toMatchObject({ nx: true });
    expect(evalCalls.length).toBeGreaterThanOrEqual(1);
    // EVAL was given our identity as the first arg and the TTL in ms as the second.
    expect(evalCalls[0]!.args[0]).toBe("test-id");
    expect(evalCalls[0]!.args[1]).toBe(30_000);
    // The key passed to EVAL is the lock key for the network.
    expect(evalCalls[0]!.keys[0]).toBe("keeper:leader:devnet");

    await lock.stop();
  });

  // ─── C2: split-brain prevention via fenced renewal ─────────────────────────

  it("C2: demotes immediately (no 2-strike) when external party overwrites lock identity", async () => {
    const { redis, store } = makeMockRedis();
    const lock = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("leader");
    expect(store.get("keeper:leader:devnet")).toBe("node-a");

    // Simulate the partition-heal scenario: while keeper-A was unreachable,
    // standby B legitimately took over and the Upstash key now reflects B's
    // identity. Without the C2 fix, A's next SET XX would blindly overwrite
    // B's identity. With the fix, the fenced EVAL returns 0 and A demotes.
    store.set("keeper:leader:devnet", "node-b");

    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-lock-lost");
    // Critical: A did NOT overwrite B's identity in the store.
    expect(store.get("keeper:leader:devnet")).toBe("node-b");
  });

  it("C2: transient EVAL error counts toward 2-strike, does not demote on first failure", async () => {
    const { redis, calls, failNext } = makeMockRedis();
    const lock = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    // First renew throws (transient transport error). 2-strike preserves the
    // existing M15 behaviour: keeper stays leader after a single failure.
    failNext.eval = true;
    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("leader");
    expect(onDemote).not.toHaveBeenCalled();
    expect(calls.eval).toBeGreaterThanOrEqual(1);

    await lock.stop();
  });

  it("C2: two consecutive thrown EVAL errors demote with redis-renew-failed", async () => {
    let evalThrows = 0;
    const mockRedis: RedisLike = {
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        return hasNx ? "OK" : null;
      },
      async eval<T = unknown>(): Promise<T> {
        evalThrows++;
        throw new Error("upstream transport failure");
      },
    };

    const lock = new LeaderLock(mockRedis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    // Two consecutive thrown errors.
    await vi.advanceTimersByTimeAsync(10_100);
    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-renew-failed");
    expect(evalThrows).toBeGreaterThanOrEqual(2);
  });

  it("C2: defensive — null EVAL return is treated as lease loss (immediate demote)", async () => {
    const mockRedis: RedisLike = {
      async get(_key: string): Promise<string | null> { return null; },
      async del(..._keys: string[]): Promise<number> { return 0; },
      async set(_key: string, _value: string, opts: SetOpts): Promise<"OK" | null> {
        const hasNx = "nx" in opts && opts.nx === true;
        return hasNx ? "OK" : null;
      },
      async eval<T = unknown>(): Promise<T> {
        return null as unknown as T;
      },
    };

    const lock = new LeaderLock(mockRedis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onDemote = vi.fn();
    lock.start({ network: "devnet", onPromote: vi.fn(), onDemote });
    await vi.advanceTimersByTimeAsync(100);

    await vi.advanceTimersByTimeAsync(10_100);

    expect(lock.role()).toBe("standby");
    expect(onDemote).toHaveBeenCalledWith("redis-lock-lost");
  });

  it("initial acquire error falls back to standby gracefully", async () => {
    const mockRedis: RedisLike = {
      async set(): Promise<"OK" | null> { throw new Error("connection refused"); },
      async get(): Promise<string | null> { return "other"; },
      async del(): Promise<number> { return 0; },
      async eval<T = unknown>(): Promise<T> { return 0 as unknown as T; },
    };

    const lock = new LeaderLock(mockRedis, "test-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const onPromote = vi.fn();
    const onDemote = vi.fn();

    lock.start({ network: "devnet", onPromote, onDemote });
    await vi.advanceTimersByTimeAsync(100);

    expect(lock.role()).toBe("standby");
    expect(onPromote).not.toHaveBeenCalled();

    await lock.stop();
  });
});

// ─── Chaos tests ─────────────────────────────────────────────────────────────

describe("LeaderLock chaos (STRESS=true)", { skip: process.env.STRESS !== "true" }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("failover completes in < 35s p99 when leader is killed", async () => {
    const { redis } = makeMockRedis();

    const leader = new LeaderLock(redis, "leader-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const standby = new LeaderLock(redis, "standby-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });

    const leaderPromote = vi.fn();
    const standbyPromote = vi.fn();

    leader.start({ network: "devnet", onPromote: leaderPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    standby.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");
    expect(standby.role()).toBe("standby");

    const killTime = Date.now();
    // Graceful kill: release lock immediately
    await leader.stop();

    // Standby should pick up within pollMs (5s) + processing time
    await vi.advanceTimersByTimeAsync(6_000);

    const elapsedMs = Date.now() - killTime;
    expect(standby.role()).toBe("leader");
    expect(standbyPromote).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeLessThan(35_000);
  });

  it("network partition: standby stays in standby (does not split-brain)", async () => {
    const { redis, store } = makeMockRedis();

    const leader = new LeaderLock(redis, "leader-id", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    leader.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");

    // Standby with partitioned network: get() always throws
    const partitioned: RedisLike = {
      set: redis.set.bind(redis),
      del: redis.del.bind(redis),
      eval: redis.eval.bind(redis),
      async get(): Promise<string | null> {
        throw new Error("network partition");
      },
    };

    const standbyPartitioned = new LeaderLock(partitioned, "standby-id", {
      ttlMs: 30_000,
      renewMs: 10_000,
      pollMs: 5_000,
    });
    const standbyPromote = vi.fn();
    standbyPartitioned.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    // Advance well past TTL — standby must NOT take over
    await vi.advanceTimersByTimeAsync(60_000);

    expect(standbyPartitioned.role()).toBe("standby");
    expect(standbyPromote).not.toHaveBeenCalled();
    expect(leader.role()).toBe("leader");

    await leader.stop();
    await standbyPartitioned.stop();
  });

  // A.6: SIGKILL / ungraceful death path — leader dies without calling stop(),
  // so the Redis lock is NOT explicitly DEL'd; standby must wait until the
  // TTL elapses for Redis to expire it, then promote on the next poll cycle.
  // The existing "failover < 35s" test simulates graceful kill; this one
  // simulates the real-world process-killed-by-OOM case.
  it("A.6: failover within ttlMs+pollMs when leader dies ungracefully (SIGKILL)", async () => {
    const { redis, store } = makeMockRedis();
    const TTL = 30_000;
    const POLL = 5_000;
    const KEY = "keeper:leader:devnet";

    const leader = new LeaderLock(redis, "leader-id", {
      ttlMs: TTL,
      renewMs: 10_000,
      pollMs: POLL,
    });
    const standby = new LeaderLock(redis, "standby-id", {
      ttlMs: TTL,
      renewMs: 10_000,
      pollMs: POLL,
    });

    const standbyPromote = vi.fn();
    leader.start({ network: "devnet", onPromote: vi.fn(), onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    standby.start({ network: "devnet", onPromote: standbyPromote, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    expect(leader.role()).toBe("leader");
    expect(standby.role()).toBe("standby");
    expect(store.has(KEY)).toBe(true);

    // Ungraceful death: kill the leader's timers without releasing the lock.
    // The lock entry stays in Redis until its TTL expires server-side.
    (leader as { _clearTimers(): void })._clearTimers();
    const deathTime = Date.now();

    // Mock store does not auto-expire on `ex`, so simulate the TTL by deleting
    // the key at the moment Redis would have expired it.
    await vi.advanceTimersByTimeAsync(TTL);
    store.delete(KEY);

    // Standby's next poll happens within pollMs; allow that window plus a
    // small tick for async settlement.
    await vi.advanceTimersByTimeAsync(POLL + 500);

    expect(standby.role()).toBe("leader");
    expect(standbyPromote).toHaveBeenCalledOnce();
    const elapsedMs = Date.now() - deathTime;
    expect(elapsedMs).toBeLessThanOrEqual(TTL + POLL + 1_000);

    await standby.stop();
  });

  it("split-brain: two instances starting concurrently, only one wins", async () => {
    const { redis } = makeMockRedis();

    const lockA = new LeaderLock(redis, "node-a", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });
    const lockB = new LeaderLock(redis, "node-b", { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 });

    const promoteA = vi.fn();
    const promoteB = vi.fn();

    lockA.start({ network: "devnet", onPromote: promoteA, onDemote: vi.fn() });
    lockB.start({ network: "devnet", onPromote: promoteB, onDemote: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);

    const leaders = [lockA, lockB].filter(l => l.role() === "leader");
    const standbys = [lockA, lockB].filter(l => l.role() === "standby");

    expect(leaders).toHaveLength(1);
    expect(standbys).toHaveLength(1);
    expect(promoteA.mock.calls.length + promoteB.mock.calls.length).toBe(1);

    await lockA.stop();
    await lockB.stop();
  });
});

// ─── Integration test (real Upstash) ─────────────────────────────────────────

describe("LeaderLock integration (INTEGRATION=true)", { skip: process.env.INTEGRATION !== "true" }, () => {
  it("acquires and releases real Upstash lock", async () => {
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    const redis = getRedisClient();
    if (!redis) throw new Error("KEEPER_REDIS_URL must be set for integration tests");

    const lock = new LeaderLock(redis, `integration-test-${Date.now()}`, {
      ttlMs: 10_000,
      renewMs: 4_000,
      pollMs: 2_000,
    });

    const promoted = await new Promise<boolean>((resolve) => {
      lock.start({
        network: "integration-test",
        onPromote: () => resolve(true),
        onDemote: () => {},
      });
      setTimeout(() => resolve(false), 5_000);
    });

    expect(promoted).toBe(true);
    expect(lock.role()).toBe("leader");

    await lock.stop();
    expect(lock.role()).toBe("standby");
  }, 15_000);
});
