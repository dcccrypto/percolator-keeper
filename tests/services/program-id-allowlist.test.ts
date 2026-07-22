/**
 * Regression test for the MARKETS_FILTER program-id allow-list.
 *
 * The MARKETS_FILTER discovery path builds a market from `programId: info.owner`
 * straight from the account owner. It must reject slabs owned by a program not
 * in config.allProgramIds (mirroring registerMarket), so the keeper never signs
 * crank/liquidate txs against an arbitrary program. (The boot guard
 * assertProgramIdAllowList — tested in tests/lib/boot-assertions.test.ts — pins
 * config.allProgramIds itself.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const C = vi.hoisted(() => ({
  KNOWN_PROGRAM: "11111111111111111111111111111111",
  FOREIGN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // not in allProgramIds
  SLAB: "So11111111111111111111111111111111111111112",
  ownerToReturn: "" as string, // set per test
}));

// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discoverMarkets: vi.fn(async () => []),
  // v17 SDK API (replaces encodeKeeperCrank / encodeUpdateHyperpMark)
  encodePermissionlessCrank: vi.fn(() => Buffer.from([5, 0, 0, 0, 0, 0])),
  encodeRestartAssetOracle: vi.fn(() => Buffer.from([6])),
  CrankAction: { Crank: 0, Liquidate: 1 },
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => C.KNOWN_PROGRAM }, 0]),
  fetchSlab: vi.fn(),
  // v17 account detection — return false so parseMarketFromAccountData uses legacy parse path
  isV17Account: vi.fn(() => false),
  parseWrapperConfigV17: vi.fn(() => ({})),
  parsePortfolioV17: vi.fn(),
  encodeInitUser: vi.fn(() => Buffer.from([2])),
  deriveLpVaultRegistry: vi.fn(() => [{ toBase58: () => C.KNOWN_PROGRAM }, 0]),
  deriveLpBackingLedger: vi.fn(() => [{ toBase58: () => C.KNOWN_PROGRAM }, 0]),
  parseLpVaultRegistry: vi.fn(() => null),
  encodeLpVaultCrankFees: vi.fn(() => Buffer.from([3])),
  // Legacy parse helpers used in parseMarketFromAccountData fallback path
  parseHeader: vi.fn(() => ({ admin: { toBase58: () => "Admin1" }, magic: 0n, version: 12, kind: 1, marketCreatedSlot: 0n, resolvedSlot: 0n })),
  parseConfig: vi.fn(() => ({
    collateralMint: { toBase58: () => "Mint1111111111111111111111111111111111" },
    indexFeedId: { toBytes: () => new Uint8Array(32), toBase58: () => C.KNOWN_PROGRAM, equals: () => true },
    oracleAuthority: { toBase58: () => C.KNOWN_PROGRAM, equals: () => true },
  })),
  parseEngine: vi.fn(() => ({ totalOpenInterest: 0n })),
  parseParams: vi.fn(() => ({ maintenanceMarginBps: 500n })),
}));
vi.mock("@percolatorct/shared", () => ({
  config: {
    crankIntervalMs: 30000, crankInactiveIntervalMs: 120000, discoveryIntervalMs: 300000,
    allProgramIds: [C.KNOWN_PROGRAM], crankKeypair: "mock",
  },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  getConnection: vi.fn(() => ({ getAccountInfo: vi.fn() })),
  getFallbackConnection: vi.fn(() => ({
    getMultipleAccountsInfo: vi.fn(async () => [
      { owner: { toBase58: () => C.ownerToReturn, equals: () => false }, data: new Uint8Array(1024) },
    ]),
  })),
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => C.KNOWN_PROGRAM, equals: () => false }, secretKey: new Uint8Array(64) })),
  sendWithRetryKeeper: vi.fn(), eventBus: { publish: vi.fn() },
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({ select: vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) })) })),
  })),
}));
vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(), sharedBudget: new KeeperBudget() };
});

import { CrankService } from "../../src/services/crank.js";

describe("MARKETS_FILTER program-id allow-list", () => {
  let crank: CrankService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MARKETS_FILTER = C.SLAB;
    crank = new CrankService({ pushPrice: vi.fn(), recordPushTime: vi.fn() } as any);
  });

  afterEach(() => {
    delete process.env.MARKETS_FILTER;
    crank.stop();
  });

  it("does NOT track a slab owned by a non-allow-listed program", async () => {
    C.ownerToReturn = C.FOREIGN_PROGRAM;
    await crank.discover();
    expect(crank.getMarkets().has(C.SLAB)).toBe(false);
  });

  it("DOES track a slab owned by an allow-listed program (no over-skip)", async () => {
    C.ownerToReturn = C.KNOWN_PROGRAM;
    await crank.discover();
    expect(crank.getMarkets().has(C.SLAB)).toBe(true);
  });
});
