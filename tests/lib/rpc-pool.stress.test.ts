import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  rpcRequestTotal: { inc: vi.fn() },
  rpcLatencyP50: { set: vi.fn() },
  rpcLatencyP99: { set: vi.fn() },
  rpcProviderHealthy: { set: vi.fn() },
  rpcFailoverTotal: { inc: vi.fn() },
  rpcSlotLag: { set: vi.fn() },
}));

import { RpcPool, _resetSharedRpcPool } from "../../src/lib/rpc-pool.js";
import type { RpcPoolConfig } from "../../src/config/rpc.js";
import { PublicKey } from "@solana/web3.js";

const STRESS = process.env.STRESS === "true";

function makeConfig(overrides: Partial<RpcPoolConfig> = {}): RpcPoolConfig {
  return {
    enabled: true,
    helius: { url: "https://helius.example.com", name: "helius" },
    alchemy: { url: "https://alchemy.example.com", name: "alchemy" },
    healthCheckIntervalMs: 5_000,
    unhealthyP99Ms: 2_000,
    unhealthySlotLag: 50,
    unhealthyConsecutiveFails: 5,
    recoveryWindowMs: 60_000,
    forceAlchemyGpa: true,
    ...overrides,
  };
}

let _heliusUp = true;

function makeHeliusConn() {
  return {
    getSlot: vi.fn(async () => {
      if (!_heliusUp) throw new Error("Helius 500");
      return 1000;
    }),
    getAccountInfo: vi.fn(async () => {
      if (!_heliusUp) throw new Error("Helius 500");
      return { owner: "helius" } as any;
    }),
    getMultipleAccountsInfo: vi.fn(async () => []),
    getSignatureStatuses: vi.fn(async () => ({ value: [] })),
    getProgramAccounts: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "helius-blockhash",
      lastValidBlockHeight: 9999,
    })),
  } as any;
}

function makeAlchemyConn() {
  return {
    getSlot: vi.fn(async () => 1001),
    getAccountInfo: vi.fn(async () => ({ owner: "alchemy" } as any)),
    getMultipleAccountsInfo: vi.fn(async () => []),
    getSignatureStatuses: vi.fn(async () => ({ value: [] })),
    getProgramAccounts: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "alchemy-blockhash",
      lastValidBlockHeight: 9999,
    })),
  } as any;
}

beforeEach(() => {
  _heliusUp = true;
  _resetSharedRpcPool();
  vi.clearAllMocks();
});

afterEach(() => {
  _heliusUp = true;
  _resetSharedRpcPool();
});

describe.skipIf(!STRESS)("RpcPool — stress / chaos (STRESS=true)", () => {
  it(
    "1000 concurrent read() during simulated provider failure — all complete, no drops",
    async () => {
      const helius = makeHeliusConn();
      const alchemy = makeAlchemyConn();
      const pool = new RpcPool(helius, alchemy, { config: makeConfig() });

      // Force Helius unhealthy from the start.
      for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
      pool.heliusHealth.evaluate(null);
      expect(pool.heliusHealth.isHealthy).toBe(false);

      const N = 1_000;
      const results = await Promise.allSettled(
        Array.from({ length: N }, () => pool.getAccountInfo(PublicKey.default)),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // All should complete — Alchemy is healthy so no drops.
      expect(fulfilled.length).toBe(N);
      expect(rejected.length).toBe(0);
    },
    60_000,
  );

  it(
    "chaos: Helius 500s — all reads route to Alchemy within one health-check cycle",
    async () => {
      const helius = makeHeliusConn();
      const alchemy = makeAlchemyConn();
      const pool = new RpcPool(helius, alchemy, {
        config: makeConfig({ unhealthyConsecutiveFails: 5 }),
      });

      // Simulate Helius returning 500s.
      _heliusUp = false;

      // After 5 failures Helius should be unhealthy.
      for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
      pool.heliusHealth.evaluate(null);
      expect(pool.heliusHealth.isHealthy).toBe(false);

      // Now all reads should route to Alchemy.
      const N = 100;
      const results = await Promise.all(
        Array.from({ length: N }, () => pool.getAccountInfo(PublicKey.default)),
      );

      // Every call returned (even if alchemy returns null-ish).
      expect(results).toHaveLength(N);
      expect(alchemy.getAccountInfo).toHaveBeenCalledTimes(N);
      expect(helius.getAccountInfo).not.toHaveBeenCalled();
    },
    60_000,
  );

  it(
    "chaos: both providers unhealthy simultaneously — fail-safe routes to Helius, no exception thrown",
    async () => {
      // Override Helius to return a value even in degraded mode for this test.
      _heliusUp = true;
      const helius = makeHeliusConn();
      const alchemy = makeAlchemyConn();
      const pool = new RpcPool(helius, alchemy, { config: makeConfig() });

      // Mark both unhealthy.
      for (let i = 0; i < 5; i++) {
        pool.heliusHealth.recordFailure();
        pool.alchemyHealth.recordFailure();
      }
      pool.heliusHealth.evaluate(null);
      pool.alchemyHealth.evaluate(null);
      expect(pool.heliusHealth.isHealthy).toBe(false);
      expect(pool.alchemyHealth.isHealthy).toBe(false);

      // Verify fail-safe: no exception thrown, reads go to Helius.
      const N = 50;
      // Helius is actually up — just marked unhealthy by the tracker.
      const results = await Promise.allSettled(
        Array.from({ length: N }, () => pool.getAccountInfo(PublicKey.default)),
      );

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      // All went to Helius (fail-safe).
      expect(helius.getAccountInfo).toHaveBeenCalledTimes(N);
      expect(alchemy.getAccountInfo).not.toHaveBeenCalled();
    },
    60_000,
  );

  it(
    "chaos: Helius recovers after 30s of 500s — reads return to Helius",
    async () => {
      let now = 1_700_000_000_000;
      const mockNow = () => now;

      const helius = makeHeliusConn();
      const alchemy = makeAlchemyConn();
      const pool = new RpcPool(helius, alchemy, {
        config: makeConfig({ recoveryWindowMs: 60_000 }),
        now: mockNow,
      });

      // Phase 1: Helius fails.
      for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
      pool.heliusHealth.evaluate(null);
      expect(pool.heliusHealth.isHealthy).toBe(false);

      // Phase 2: Helius recovers — good samples then first clean evaluate starts clock.
      for (let i = 0; i < 20; i++) pool.heliusHealth.recordSuccess(300);
      pool.heliusHealth.recordSlot(2000);
      // First clean evaluate: starts recovery clock at `now`.
      pool.heliusHealth.evaluate(2005); // lag = 5 < 10
      expect(pool.heliusHealth.isHealthy).toBe(false); // window not elapsed yet

      // Advance past the recovery window; evaluate again.
      now += 61_000;
      pool.heliusHealth.evaluate(2005);
      expect(pool.heliusHealth.isHealthy).toBe(true);

      // Phase 3: reads go back to Helius.
      const result = await pool.getAccountInfo(PublicKey.default);
      void result;
      expect(helius.getAccountInfo).toHaveBeenCalled();
    },
    60_000,
  );
});

// Always-on lightweight version: avoids needing STRESS=true in CI.
describe("RpcPool — lightweight concurrency smoke (always on)", () => {
  it("100 concurrent reads all complete without exception", async () => {
    const helius = makeHeliusConn();
    const alchemy = makeAlchemyConn();
    const pool = new RpcPool(helius, alchemy, { config: makeConfig() });

    const N = 100;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => pool.getAccountInfo(PublicKey.default)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(N);
  });

  it("failover smoke: unhealthy Helius routes to Alchemy", async () => {
    const helius = makeHeliusConn();
    const alchemy = makeAlchemyConn();
    const pool = new RpcPool(helius, alchemy, { config: makeConfig() });

    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);

    const N = 20;
    await Promise.all(Array.from({ length: N }, () => pool.getAccountInfo(PublicKey.default)));
    expect(alchemy.getAccountInfo).toHaveBeenCalledTimes(N);
  });
});
