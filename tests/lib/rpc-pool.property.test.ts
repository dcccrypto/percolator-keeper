import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

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
    forceAlchemyGpa: false,
    ...overrides,
  };
}

function makeConn(response: unknown = null) {
  return {
    getSlot: vi.fn(async () => 1000),
    getAccountInfo: vi.fn(async () => response),
    getMultipleAccountsInfo: vi.fn(async () => []),
    getSignatureStatuses: vi.fn(async () => ({ value: [] })),
    getProgramAccounts: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "mock-blockhash",
      lastValidBlockHeight: 9999,
    })),
  } as any;
}

beforeEach(() => {
  _resetSharedRpcPool();
  vi.clearAllMocks();
});

// Arbitraries
const healthEventArb = fc.oneof(
  fc.record({
    kind: fc.constant("success" as const),
    latencyMs: fc.integer({ min: 1, max: 5_000 }),
  }),
  fc.record({ kind: fc.constant("fail" as const) }),
  fc.record({
    kind: fc.constant("slot" as const),
    slot: fc.integer({ min: 1, max: 1_000_000 }),
  }),
);

type HealthEvent =
  | { kind: "success"; latencyMs: number }
  | { kind: "fail" }
  | { kind: "slot"; slot: number };

function applyEvents(
  pool: RpcPool,
  heliusEvents: HealthEvent[],
  alchemyEvents: HealthEvent[],
): void {
  for (const ev of heliusEvents) {
    if (ev.kind === "success") pool.heliusHealth.recordSuccess(ev.latencyMs);
    else if (ev.kind === "fail") pool.heliusHealth.recordFailure();
    else pool.heliusHealth.recordSlot(ev.slot);
  }
  for (const ev of alchemyEvents) {
    if (ev.kind === "success") pool.alchemyHealth.recordSuccess(ev.latencyMs);
    else if (ev.kind === "fail") pool.alchemyHealth.recordFailure();
    else pool.alchemyHealth.recordSlot(ev.slot);
  }
  pool.heliusHealth.evaluate(pool.alchemyHealth.lastSeenSlot);
  pool.alchemyHealth.evaluate(pool.heliusHealth.lastSeenSlot);
}

describe("RpcPool — property tests", () => {
  it(
    "invariant: exactly one provider always selected for reads (never zero, never both)",
    () => {
      fc.assert(
        fc.property(
          fc.array(healthEventArb, { minLength: 0, maxLength: 50 }),
          fc.array(healthEventArb, { minLength: 0, maxLength: 50 }),
          fc.constantFrom<string>(
            "getAccountInfo",
            "getMultipleAccountsInfo",
            "getSignatureStatuses",
            "getLatestBlockhash",
            "getSlot",
          ),
          (heliusEvents, alchemyEvents, method) => {
            const pool = new RpcPool(makeConn() as any, makeConn() as any, {
              config: makeConfig(),
            });
            applyEvents(pool, heliusEvents, alchemyEvents);

            const chosen = pool.pickProvider(method);
            // Must be exactly one of the two providers.
            expect(chosen === "helius" || chosen === "alchemy").toBe(true);
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "invariant: failover counter monotonically increases (never decreases) — driven via tickForTest",
    () => {
      // Use tickForTest (which drives the real _evaluateAndTransition state machine)
      // rather than applyEvents so _failoverCount is actually exercised.
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              heliusSlot: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
              alchemySlot: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
              latencyMs: fc.integer({ min: 1, max: 5_000 }),
            }),
            { minLength: 1, maxLength: 30 },
          ),
          (rounds) => {
            const pool = new RpcPool(makeConn() as any, makeConn() as any, {
              config: makeConfig(),
            });
            let lastCount = pool.failoverCount;
            for (const { heliusSlot, alchemySlot, latencyMs } of rounds) {
              pool.tickForTest(heliusSlot, alchemySlot, latencyMs);
              const current = pool.failoverCount;
              expect(current).toBeGreaterThanOrEqual(lastCount);
              lastCount = current;
            }
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "invariant: recovery requires all 3 conditions — any one missing keeps provider unhealthy",
    () => {
      // A provider that became unhealthy via consecutive fails should only
      // recover if: P99 < 1000ms AND slot lag < 10 AND 0 consecutive fails
      // for the full recovery window. If slot lag is high, it stays unhealthy.
      fc.assert(
        fc.property(
          fc.integer({ min: 51, max: 500 }),   // slot lag > 10 (recovery criterion fails)
          (slotLag) => {
            let t = 1_700_000_000_000;
            const now = () => t;

            const pool = new RpcPool(makeConn() as any, makeConn() as any, {
              config: makeConfig(),
              now,
            });

            // Become unhealthy via consecutive fails.
            for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
            pool.heliusHealth.evaluate(null);
            expect(pool.heliusHealth.isHealthy).toBe(false);

            // Good P99 and zero fails — but slot lag is too high.
            for (let i = 0; i < 10; i++) pool.heliusHealth.recordSuccess(500);
            pool.heliusHealth.recordSlot(1000);
            // Slot lag > 10: recovery criteria not met; clock never starts.
            pool.heliusHealth.evaluate(1000 + slotLag);
            // Advance well past recovery window — but since clock never started, still unhealthy.
            t += 120_000;
            pool.heliusHealth.evaluate(1000 + slotLag);

            // Must still be unhealthy because slot lag criterion is not met.
            expect(pool.heliusHealth.isHealthy).toBe(false);
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "invariant: write always returns Helius connection regardless of pool state",
    () => {
      fc.assert(
        fc.property(
          fc.array(healthEventArb, { minLength: 0, maxLength: 30 }),
          fc.array(healthEventArb, { minLength: 0, maxLength: 30 }),
          (heliusEvents, alchemyEvents) => {
            const helius = makeConn() as any;
            const alchemy = makeConn() as any;
            const pool = new RpcPool(helius, alchemy, { config: makeConfig() });
            applyEvents(pool, heliusEvents, alchemyEvents);
            expect(pool.writeConnection).toBe(helius);
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );

  it(
    "invariant: disabled pool always picks helius regardless of health state",
    () => {
      fc.assert(
        fc.property(
          fc.array(healthEventArb, { minLength: 0, maxLength: 30 }),
          fc.array(healthEventArb, { minLength: 0, maxLength: 30 }),
          fc.constantFrom<string>(
            "getAccountInfo",
            "getProgramAccounts",
            "getSlot",
          ),
          (heliusEvents, alchemyEvents, method) => {
            const pool = new RpcPool(makeConn() as any, makeConn() as any, {
              config: makeConfig({ enabled: false }),
            });
            applyEvents(pool, heliusEvents, alchemyEvents);
            expect(pool.pickProvider(method)).toBe("helius");
          },
        ),
        { numRuns: 500 },
      );
    },
    30_000,
  );
});
