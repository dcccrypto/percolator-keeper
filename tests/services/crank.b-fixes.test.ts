/**
 * Regression tests for Phase 1 Workstream B′ crank.ts fixes.
 *
 * - B1: alert at >=5 consecutive failures fires once per streak, resets on success
 * - B10: lifetime failureCount is never reset on success — only consecutiveFailures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => "SysvarC1ock11111111111111111111111111111111",
      equals: () => false,
    },
  };
});

// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discoverMarkets: vi.fn(),
  encodePermissionlessCrank: vi.fn(() => Buffer.from([5, 0, 0, 0, 0, 0])),
  CrankAction: { FeeSweep: 0, Liquidate: 1 },
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [
    { toBase58: () => "Oracle111111111111111111111111111111111" },
    0,
  ]),
  parseHeader: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  fetchSlab: vi.fn(),
}));

vi.mock("@percolatorct/shared", () => ({
  config: {
    crankIntervalMs: 30000,
    crankInactiveIntervalMs: 120000,
    discoveryIntervalMs: 300000,
    allProgramIds: ["11111111111111111111111111111111"],
    crankKeypair: "mock-keypair-path",
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getSlot: vi.fn().mockResolvedValue(200),
  })),
  getFallbackConnection: vi.fn(() => ({
    getProgramAccounts: vi.fn(),
    getAccountInfo: vi.fn(),
    getMultipleAccountsInfo: vi.fn(),
  })),
  loadKeypair: vi.fn(() => ({
    publicKey: {
      toBase58: () => "11111111111111111111111111111111",
      equals: (o: any) => o?.toBase58?.() === "11111111111111111111111111111111",
    },
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => "mock-sig"),
  sendWithRetryKeeper: vi.fn(),
  rateLimitedCall: vi.fn((fn) => fn()),
  sendCriticalAlert: vi.fn().mockResolvedValue(undefined),
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(() => ({ data: [], error: null })),
      })),
    })),
  })),
  eventBus: { publish: vi.fn() },
  // BUG-110: src/lib/service-monitors.ts calls this at import time.
  createServiceMonitors: vi.fn(() => {
    const m = () => ({ recordSuccess: vi.fn(async () => {}), recordFailure: vi.fn(async () => {}), getErrorRate: vi.fn(() => 0), getStatus: vi.fn(() => ({ healthy: true, consecutiveFailures: 0, errorRate: 0, timeSinceSuccessMs: 0, alertActive: false })) });
    return { rpc: m(), scan: m(), oracle: m(), db: m() };
  }),
}));

// After the #119 merge, crank.ts routes sends through keeperSend (not shared.sendWithRetryKeeper
// directly), so success/failure determinism for these tests must be enforced at the keeperSend
// layer. Without this mock, keeperSend's priority-fee + CU-sim path rejects before reaching
// sendWithRetryKeeper, which silently turns success-path tests into failure-path tests.
vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return {
    keeperSend: vi.fn(async () => ({ signature: "mock-keeper-sig", estimatedCost: 5000 })),
    sharedBudget: new KeeperBudget(),
  };
});

import { PublicKey } from "@solana/web3.js";
import { CrankService } from "../../src/services/crank.js";
import * as shared from "@percolatorct/shared";
import * as keeperSendModule from "../../src/lib/keeper-send.js";

const MOCK_PORTFOLIO = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");

function makeMarketState(opts: Partial<{
  consecutiveFailures: number;
  failureCount: number;
  successCount: number;
  alertedAt5: boolean;
  keeperPortfolio: PublicKey | null;
}> = {}) {
  return {
    market: {
      slabAddress: new PublicKey("11111111111111111111111111111112"),
      programId: new PublicKey("11111111111111111111111111111111"),
      header: {},
      config: {
        oracleAuthority: PublicKey.default,
        indexFeedId: { toBytes: () => new Uint8Array(32) },
        authorityPriceE6: 0n,
        dexPool: null,
      },
      engine: {},
      params: {},
    } as any,
    lastCrankTime: 0,
    successCount: opts.successCount ?? 0,
    failureCount: opts.failureCount ?? 0,
    consecutiveFailures: opts.consecutiveFailures ?? 0,
    isActive: true,
    missingDiscoveryCount: 0,
    alertedAt5: opts.alertedAt5 ?? false,
    // v17: keeperPortfolio must be set for crankMarket() to attempt a transaction.
    keeperPortfolio: opts.keeperPortfolio !== undefined ? opts.keeperPortfolio : MOCK_PORTFOLIO,
  };
}

describe("crank B-fixes — B1 alert latch", () => {
  let crank: CrankService;
  let alertSpy: ReturnType<typeof vi.fn>;
  const slab = "11111111111111111111111111111112";

  beforeEach(() => {
    vi.clearAllMocks();
    alertSpy = vi.mocked(shared.sendCriticalAlert);
    const oracleService = {
      pushPrice: vi.fn(),
      recordPushTime: vi.fn(),
    } as any;
    crank = new CrankService(oracleService);
    (crank as any).markets.set(slab, makeMarketState());
  });

  afterEach(() => crank.stop());

  it("does not fire while consecutiveFailures < 5", async () => {
    vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error("boom"));
    for (let i = 0; i < 4; i++) await crank.crankMarket(slab);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("fires exactly once when consecutiveFailures crosses 5 (5,6,7,8 → 1 alert)", async () => {
    vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error("boom"));
    for (let i = 0; i < 8; i++) await crank.crankMarket(slab);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect((crank as any).markets.get(slab).alertedAt5).toBe(true);
  });

  it("still fires when failures jump 4 → 6 (skip 5) — B1 fix vs old `=== 5`", async () => {
    // Pre-load consecutiveFailures = 5 (simulating jump). The fix uses `>= 5 && !alertedAt5`.
    const state = (crank as any).markets.get(slab);
    state.consecutiveFailures = 5;
    vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error("boom"));
    await crank.crankMarket(slab); // bumps to 6, should still fire
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it("latch resets on success so a second streak can alert again", async () => {
    vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error("boom"));
    for (let i = 0; i < 6; i++) await crank.crankMarket(slab);
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // success path
    vi.mocked(keeperSendModule.keeperSend).mockResolvedValueOnce({ signature: "ok-sig", estimatedCost: 5000 } as any);
    await crank.crankMarket(slab);
    expect((crank as any).markets.get(slab).consecutiveFailures).toBe(0);
    expect((crank as any).markets.get(slab).alertedAt5).toBe(false);

    // second streak should fire again
    vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error("boom2"));
    for (let i = 0; i < 6; i++) await crank.crankMarket(slab);
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });
});

describe("crank B-fixes — B10 lifetime failureCount preservation", () => {
  let crank: CrankService;
  const slab = "11111111111111111111111111111112";

  beforeEach(() => {
    vi.clearAllMocks();
    const oracleService = { pushPrice: vi.fn(), recordPushTime: vi.fn() } as any;
    crank = new CrankService(oracleService);
    (crank as any).markets.set(slab, makeMarketState({ failureCount: 42, consecutiveFailures: 3 }));
  });

  afterEach(() => crank.stop());

  it("success resets consecutiveFailures but preserves lifetime failureCount", async () => {
    vi.mocked(keeperSendModule.keeperSend).mockResolvedValueOnce({ signature: "ok-sig", estimatedCost: 5000 } as any);
    await crank.crankMarket(slab);
    const state = (crank as any).markets.get(slab);
    expect(state.consecutiveFailures).toBe(0);
    // B10: lifetime counter must NOT be reset
    expect(state.failureCount).toBe(42);
    expect(state.successCount).toBe(1);
  });
});
