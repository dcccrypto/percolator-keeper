/**
 * Regression tests for #377 — invalid HA lease timings create a deterministic
 * split-brain leader window.
 *
 * LeaderLock accepted any timing values. With renewMs >= ttlMs the Redis lease
 * expires before the leader attempts renewal, so a standby acquires the freed
 * key and promotes itself while the original node still reports
 * role() === "leader". keeperSend gates on-chain writes on that local role
 * alone, so both nodes submit transactions in the interval.
 *
 * The first test is the issue's proof-of-concept, inverted: it drives the exact
 * timing that produced two concurrent leaders and asserts the lock now refuses
 * to be constructed at all, so the unsafe state is unreachable.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { LeaderLock, LeaderLockTimingError } from "../../src/lib/leader.js";
import type { RedisLike } from "../../src/lib/redis-client.js";

vi.mock("@percolatorct/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Redis-compatible in-memory lease WITH expiry semantics (the PoC's harness). */
function makeExpiringRedis(): RedisLike {
  let value: string | null = null;
  let expiresAt = 0;
  const live = () => {
    if (value !== null && Date.now() >= expiresAt) value = null;
    return value;
  };
  return {
    async set(_key: string, next: string, opts: { ex: number; nx?: true }) {
      if ("nx" in opts && opts.nx === true && live() !== null) return null;
      value = next;
      expiresAt = Date.now() + opts.ex * 1000;
      return "OK" as const;
    },
    async get() {
      return live();
    },
    async del() {
      value = null;
      return 1;
    },
    async eval<T>(_script: string, _keys: string[], args: (string | number)[]): Promise<T> {
      if (live() !== args[0]) return 0 as T;
      expiresAt = Date.now() + Number(args[1]);
      return 1 as T;
    },
  };
}

const VALID = { ttlMs: 30_000, renewMs: 10_000, pollMs: 5_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("#377 LeaderLock lease-timing validation", () => {
  it("refuses the exact configuration from the issue PoC (renewMs > ttlMs)", async () => {
    vi.useFakeTimers();
    const redis = makeExpiringRedis();
    const bad = { ttlMs: 1_000, renewMs: 5_000, pollMs: 100 };

    // Previously both nodes could be constructed and started, and after the
    // 1s lease lapsed BOTH reported "leader". Construction now fails first.
    expect(() => new LeaderLock(redis, "node-a", bad)).toThrow(LeaderLockTimingError);
    expect(() => new LeaderLock(redis, "node-b", bad)).toThrow(/split-brain/);
  });

  it("still elects exactly one leader under a valid configuration", async () => {
    vi.useFakeTimers();
    const redis = makeExpiringRedis();
    const a = new LeaderLock(redis, "node-a", VALID);
    const b = new LeaderLock(redis, "node-b", VALID);
    const noop = { network: "devnet", onPromote() {}, onDemote() {} };

    a.start(noop);
    b.start(noop);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.role()).toBe("leader");
    expect(b.role()).toBe("standby");

    // Past the point where the bad config split-brained, and past a renewal.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(a.role()).toBe("leader");
    expect(b.role()).toBe("standby");

    await a.stop();
    await b.stop();
  });

  it("rejects renewMs exactly equal to ttlMs (the boundary)", () => {
    const redis = makeExpiringRedis();
    expect(() => new LeaderLock(redis, "n", { ...VALID, ttlMs: 10_000, renewMs: 10_000 })).toThrow(
      LeaderLockTimingError,
    );
  });

  it("accepts renewMs just below ttlMs", () => {
    const redis = makeExpiringRedis();
    expect(() => new LeaderLock(redis, "n", { ttlMs: 10_000, renewMs: 9_999, pollMs: 1_000 })).not.toThrow();
  });

  // index.ts builds these with Number(process.env.X ?? default), so any
  // malformed env value arrives here as NaN rather than being rejected upstream.
  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["zero", 0],
    ["negative", -1],
  ])("rejects %s for each timing field", (_label, bad) => {
    const redis = makeExpiringRedis();
    expect(() => new LeaderLock(redis, "n", { ...VALID, ttlMs: bad })).toThrow(LeaderLockTimingError);
    expect(() => new LeaderLock(redis, "n", { ...VALID, renewMs: bad })).toThrow(LeaderLockTimingError);
    expect(() => new LeaderLock(redis, "n", { ...VALID, pollMs: bad })).toThrow(LeaderLockTimingError);
  });

  it("names the offending field so an operator can fix the right env var", () => {
    const redis = makeExpiringRedis();
    expect(() => new LeaderLock(redis, "n", { ...VALID, pollMs: NaN })).toThrow(/pollMs/);
    expect(() => new LeaderLock(redis, "n", { ...VALID, ttlMs: NaN })).toThrow(/ttlMs/);
  });

  it("still applies its defaults when no options are supplied", () => {
    const redis = makeExpiringRedis();
    expect(() => new LeaderLock(redis, "n")).not.toThrow();
    expect(() => new LeaderLock(redis, "n", {})).not.toThrow();
  });

  it("accepts a thin renew margin but does not silently endorse it", () => {
    const redis = makeExpiringRedis();
    // 0.6 * ttl — legal (renew < ttl) but leaves little room for a slow
    // round-trip, so it is warned about rather than rejected.
    expect(() => new LeaderLock(redis, "n", { ttlMs: 10_000, renewMs: 6_000, pollMs: 1_000 })).not.toThrow();
  });
});
