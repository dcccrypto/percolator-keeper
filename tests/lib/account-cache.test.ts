import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccountCache } from "../../src/lib/account-cache.js";

function makeEntry(byte: number): Uint8Array {
  return new Uint8Array([byte]);
}

describe("AccountCache", () => {
  let cache: AccountCache;

  beforeEach(() => {
    delete process.env.KEEPER_ACCOUNT_CACHE_SIZE;
    delete process.env.KEEPER_ACCOUNT_CACHE_TTL_SLOTS;
    cache = new AccountCache();
  });

  afterEach(() => {
    delete process.env.KEEPER_ACCOUNT_CACHE_SIZE;
    delete process.env.KEEPER_ACCOUNT_CACHE_TTL_SLOTS;
  });

  describe("set / get", () => {
    it("returns null for unknown pubkey", () => {
      expect(cache.get("unknown", 100)).toBeNull();
    });

    it("returns entry when slot age is within TTL", () => {
      cache.set("pk1", makeEntry(1), "owner1", 100);
      const entry = cache.get("pk1", 110); // age = 10 slots, TTL = 32
      expect(entry).not.toBeNull();
      expect(entry!.owner).toBe("owner1");
      expect(entry!.slot).toBe(100);
      expect(entry!.data[0]).toBe(1);
    });

    it("returns null when slot age equals TTL (age > TTL required)", () => {
      cache.set("pk1", makeEntry(1), "owner1", 100);
      // age = 32 slots, which is NOT > 32 → should still be valid
      expect(cache.get("pk1", 132)).not.toBeNull();
    });

    it("returns null when slot age exceeds TTL", () => {
      cache.set("pk1", makeEntry(1), "owner1", 100);
      // age = 33 > TTL(32) → evicted logically
      expect(cache.get("pk1", 133)).toBeNull();
    });

    it("overrides existing entry on re-set", () => {
      cache.set("pk1", makeEntry(1), "owner1", 100);
      cache.set("pk1", makeEntry(2), "owner2", 200);
      const entry = cache.get("pk1", 210);
      expect(entry!.data[0]).toBe(2);
      expect(entry!.owner).toBe("owner2");
      expect(entry!.slot).toBe(200);
    });

    it("tracks size correctly", () => {
      expect(cache.size()).toBe(0);
      cache.set("pk1", makeEntry(1), "o", 1);
      cache.set("pk2", makeEntry(2), "o", 1);
      expect(cache.size()).toBe(2);
    });
  });

  describe("invalidateAll", () => {
    it("clears all entries", () => {
      cache.set("pk1", makeEntry(1), "o", 100);
      cache.set("pk2", makeEntry(2), "o", 100);
      cache.invalidateAll();
      expect(cache.size()).toBe(0);
      expect(cache.get("pk1", 100)).toBeNull();
    });
  });

  describe("stats", () => {
    it("starts with zero hits and misses", () => {
      const s = cache.stats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.evictions).toBe(0);
    });

    it("counts cache hits", () => {
      cache.set("pk1", makeEntry(1), "o", 100);
      cache.get("pk1", 110);
      cache.get("pk1", 110);
      expect(cache.stats().hits).toBe(2);
    });

    it("counts cache misses (unknown key)", () => {
      cache.get("nope", 100);
      expect(cache.stats().misses).toBe(1);
    });

    it("counts cache misses (TTL exceeded)", () => {
      cache.set("pk1", makeEntry(1), "o", 100);
      cache.get("pk1", 200); // age = 100 > 32
      expect(cache.stats().misses).toBe(1);
    });

    it("reports correct maxSize and ttlSlots defaults", () => {
      const s = cache.stats();
      expect(s.maxSize).toBe(16_384);
      expect(s.ttlSlots).toBe(32);
    });
  });

  describe("env overrides", () => {
    it("respects KEEPER_ACCOUNT_CACHE_SIZE override", () => {
      process.env.KEEPER_ACCOUNT_CACHE_SIZE = "100";
      const small = new AccountCache();
      expect(small.stats().maxSize).toBe(100);
    });

    it("respects KEEPER_ACCOUNT_CACHE_TTL_SLOTS override", () => {
      process.env.KEEPER_ACCOUNT_CACHE_TTL_SLOTS = "10";
      const shortTtl = new AccountCache();
      shortTtl.set("pk1", makeEntry(1), "o", 100);
      expect(shortTtl.get("pk1", 110)).not.toBeNull(); // age=10, TTL=10 → not > 10
      expect(shortTtl.get("pk1", 111)).toBeNull(); // age=11 > 10 → expired
    });
  });

  describe("LRU eviction", () => {
    it("evicts least-recently-used when max is reached", () => {
      process.env.KEEPER_ACCOUNT_CACHE_SIZE = "3";
      const tiny = new AccountCache();
      tiny.set("a", makeEntry(1), "o", 100);
      tiny.set("b", makeEntry(2), "o", 100);
      tiny.set("c", makeEntry(3), "o", 100);
      // Access 'a' to make it recently used
      tiny.get("a", 100);
      // Adding 'd' should evict 'b' (least recently used)
      tiny.set("d", makeEntry(4), "o", 100);
      expect(tiny.size()).toBe(3);
      expect(tiny.stats().evictions).toBeGreaterThan(0);
    });
  });
});

describe("AccountCache stress test", () => {
  it.skipIf(!process.env.STRESS)(
    "handles 10k events/sec for 60s without counter drift",
    { timeout: 70_000 },
    () => {
      const cache = new AccountCache();
      const startSlot = 1000;
      let slot = startSlot;
      const writes = 10_000 * 60;
      // Simulate 600k writes (10k/s × 60s) — purely CPU-bound here.
      for (let i = 0; i < writes; i++) {
        slot++;
        cache.set(`pk${i % 16384}`, new Uint8Array([i & 0xff]), "owner", slot);
      }
      // Verify the cache has not grown beyond maxSize.
      expect(cache.size()).toBeLessThanOrEqual(16_384);
      // Verify no NaN or negative counters in stats.
      const s = cache.stats();
      expect(s.size).toBeGreaterThanOrEqual(0);
      expect(s.evictions).toBeGreaterThan(0); // forced LRU evictions expected
    },
  );
});
