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

vi.mock("@percolatorct/sdk", () => ({
  discoverMarkets: vi.fn(async () => []),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1])),
  encodeUpdateHyperpMark: vi.fn(() => Buffer.from([7])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => C.KNOWN_PROGRAM }, 0]),
  parseHeader: vi.fn(() => ({ admin: { toBase58: () => "Admin1" } })),
  parseConfig: vi.fn(() => ({
    collateralMint: { toBase58: () => "Mint1111111111111111111111111111111111" },
    indexFeedId: { toBytes: () => new Uint8Array(32), toBase58: () => C.KNOWN_PROGRAM, equals: () => true },
    oracleAuthority: { toBase58: () => C.KNOWN_PROGRAM, equals: () => true },
  })),
  parseEngine: vi.fn(() => ({ totalOpenInterest: 0n })),
  parseParams: vi.fn(() => ({ maintenanceMarginBps: 500n })),
  detectDexType: vi.fn(() => "raydium-clmm"),
  parseDexPool: vi.fn(),
  ACCOUNTS_KEEPER_CRANK: {},
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
