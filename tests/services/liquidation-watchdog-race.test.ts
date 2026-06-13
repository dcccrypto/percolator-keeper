/**
 * Regression test for the liquidation watchdog overlap race.
 *
 * runCycle() previously used a boolean `_scanning` guard with a watchdog that
 * force-cleared it after MAX_SCAN_MS. Since a JS promise can't be cancelled,
 * clearing the flag while a scan was still awaiting its RPCs let the next tick
 * start a SECOND concurrent scanAndLiquidateAll — concurrent scans have their
 * own per-cycle dedup, so the same account got duplicate liquidation txs.
 *
 * The fix tracks the in-flight scan as a Promise (`_inFlight`): a new cycle
 * starts only when the previous scan has SETTLED, and the watchdog only WARNs
 * (never force-clears). A genuinely hung cycle therefore stops new scans and
 * lastScanTime stalls, which the index.ts stall alert / health-down path acts on.
 *
 * These tests drive the real start()/runCycle with fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@solana/web3.js", async () => ({ ...(await vi.importActual("@solana/web3.js")) }));
vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(), parseConfig: vi.fn(), parseEngine: vi.fn(), parseParams: vi.fn(),
  parseAccount: vi.fn(), parseUsedIndices: vi.fn(), detectLayout: vi.fn(),
  buildAccountMetas: vi.fn(() => []), buildIx: vi.fn(() => ({})),
  encodeLiquidateAtOracle: vi.fn(() => Buffer.from([1])), encodeKeeperCrank: vi.fn(() => Buffer.from([2])),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => "Oracle1" }, 0]),
  ACCOUNTS_LIQUIDATE_AT_ORACLE: {}, ACCOUNTS_KEEPER_CRANK: {},
}));
vi.mock("@percolatorct/shared", () => ({
  config: { crankKeypair: "mock" },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWarningAlert: vi.fn(), getConnection: vi.fn(() => ({})), getFallbackConnection: vi.fn(() => ({})),
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => false }, secretKey: new Uint8Array(64) })),
  sendWithRetry: vi.fn(), sendWithRetryKeeper: vi.fn(), pollSignatureStatus: vi.fn(),
  getRecentPriorityFees: vi.fn(async () => ({ priorityFeeMicroLamports: 5000, computeUnitLimit: 200000 })),
  checkTransactionSize: vi.fn(), eventBus: { publish: vi.fn() }, acquireToken: vi.fn(async () => {}),
  backoffMs: vi.fn(() => 100), getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));
vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(), sharedBudget: new KeeperBudget() };
});

import { LiquidationService } from "../../src/services/liquidation.js";

describe("liquidation watchdog single-flight guard", () => {
  let svc: LiquidationService;
  let release: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new LiquidationService({ fetchPrice: vi.fn() } as any, 1000); // intervalMs=1000 → MAX_SCAN_MS=5000
  });

  afterEach(() => {
    if (release) release();
    svc.stop();
    vi.useRealTimers();
  });

  it("never runs two scans concurrently, even past the watchdog window", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const blocker = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(svc, "scanAndLiquidateAll").mockImplementation(async () => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight);
      await blocker; inFlight--;
      return { scanned: 0, candidates: 0, liquidated: 0 };
    });

    svc.start(() => new Map());
    await vi.advanceTimersByTimeAsync(8000); // many ticks, well past MAX_SCAN_MS=5000

    expect(maxConcurrent).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1); // the stuck scan blocks all later ticks
  });

  it("a hung cycle stalls lastScanTime (so the stall alert / health-down fires) instead of overlapping", async () => {
    const blocker = new Promise<void>((r) => { release = r; });
    vi.spyOn(svc, "scanAndLiquidateAll").mockImplementation(async () => {
      await blocker;
      return { scanned: 0, candidates: 0, liquidated: 0 };
    });

    svc.start(() => new Map());
    await vi.advanceTimersByTimeAsync(8000);

    // lastScanTime is only set when a scan COMPLETES; a hung scan never advances
    // it, so index.ts (timeSinceLastScanMs) detects the stall and restarts.
    expect(svc.getStatus().lastScanTime).toBe(0);
  });

  it("releases the guard between completed cycles (one scan per interval tick)", async () => {
    const spy = vi.spyOn(svc, "scanAndLiquidateAll").mockResolvedValue({ scanned: 0, candidates: 0, liquidated: 0 });

    svc.start(() => new Map());
    await vi.advanceTimersByTimeAsync(3000); // 3 ticks; each scan completes immediately

    expect(spy).toHaveBeenCalledTimes(3); // guard released after each settle → next tick runs
  });
});
