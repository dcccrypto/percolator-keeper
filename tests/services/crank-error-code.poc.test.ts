/**
 * PoC — proves the stale InsufficientDexLiquidity error-code (MEDIUM).
 *
 * Program ground truth: PercolatorError::InsufficientDexLiquidity has ordinal 51
 * (0x33); the program emits it via `Custom(e as u32)` when UpdateHyperpMark hits
 * MIN_DEX_QUOTE_LIQUIDITY. Ordinal 37 (0x25) is now `LpVaultNoNewFees`.
 *
 * Keeper bug: crank.ts matches `Custom":37` / `0x25`, so the dedicated
 * InsufficientDexLiquidity operator diagnostic NEVER fires for the real 0x33
 * error, and would mislabel an unrelated 0x25 (LpVaultNoNewFees) if it occurred.
 *
 * These tests assert the CORRECT behavior: they FAIL on the unfixed code (0x33
 * not recognized; 0x25 wrongly recognized) and PASS after the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@solana/web3.js", async () => ({ ...(await vi.importActual("@solana/web3.js")) }));
vi.mock("@percolatorct/sdk", () => ({
  discoverMarkets: vi.fn(),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1])),
  encodeUpdateHyperpMark: vi.fn(() => Buffer.from([7])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => "11111111111111111111111111111111" }, 0]),
  ACCOUNTS_KEEPER_CRANK: {},
}));
vi.mock("@percolatorct/shared", () => ({
  config: { crankIntervalMs: 30000, crankInactiveIntervalMs: 120000, discoveryIntervalMs: 300000, allProgramIds: ["11111111111111111111111111111111"], crankKeypair: "mock" },
  createLogger: () => h.logger, // singleton so we can assert on the module logger
  getConnection: () => ({}),
  getFallbackConnection: () => ({}),
  loadKeypair: () => ({ publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => false } }),
  sendWithRetryKeeper: vi.fn(),
  eventBus: { publish: vi.fn() },
  getSupabase: vi.fn(),
}));
vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(), sharedBudget: new KeeperBudget() };
});

import * as sdk from "@percolatorct/sdk";
import { CrankService } from "../../src/services/crank.js";
import * as keeperSendModule from "../../src/lib/keeper-send.js";

// Non-HYPERP market (index_feed_id != 0) → crankMarket takes the plain KeeperCrank
// path and calls keeperSend, whose rejection reaches the error classifier.
function nonHyperpMarket(slab: string) {
  const feed = new Uint8Array(32); feed[0] = 1;
  return {
    slabAddress: { toBase58: () => slab, equals: () => false },
    programId: { toBase58: () => "11111111111111111111111111111111" },
    config: {
      collateralMint: { toBase58: () => "Mint1111111111111111111111111111111111" },
      indexFeedId: { toBytes: () => feed, equals: () => false },
      oracleAuthority: { toBase58: () => "11111111111111111111111111111111", equals: () => true },
    },
    params: { maintenanceMarginBps: 500n },
    header: { admin: { toBase58: () => "Admin1" } },
  };
}

async function crankWithSendError(crank: CrankService, slab: string, errMsg: string): Promise<void> {
  vi.mocked(sdk.discoverMarkets).mockResolvedValue([nonHyperpMarket(slab)] as any);
  await crank.discover();
  vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error(errMsg));
  await crank.crankMarket(slab);
}

function insufficientDexLiqLogged(): boolean {
  return h.logger.error.mock.calls.some((c) => String(c[0]).includes("InsufficientDexLiquidity"));
}

describe("PoC: InsufficientDexLiquidity error-code classification", () => {
  let crank: CrankService;
  beforeEach(() => {
    vi.clearAllMocks();
    crank = new CrankService({ pushPrice: vi.fn(), recordPushTime: vi.fn() } as any);
  });
  afterEach(() => crank.stop());

  it("fires the InsufficientDexLiquidity diagnostic for the program's real code 0x33 (51)", async () => {
    await crankWithSendError(crank, "Slab33", 'Transaction failed: custom program error: 0x33');
    expect(insufficientDexLiqLogged()).toBe(true);
  });

  it("does NOT fire the diagnostic for 0x25 (37), which is now LpVaultNoNewFees", async () => {
    await crankWithSendError(crank, "Slab25", 'Transaction failed: custom program error: 0x25');
    expect(insufficientDexLiqLogged()).toBe(false);
  });
});
