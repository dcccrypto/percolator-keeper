/**
 * PoC — proves the HYPERP-detection divergence (MEDIUM).
 *
 * Program ground truth (dcccrypto/percolator-prog, src/percolator.rs):
 *   is_hyperp_mode(config) = (config.index_feed_id == [0u8;32])   // line 4156-4158
 *   handle_update_hyperp_mark gates ONLY on is_hyperp_mode (16213) — NO hyperp_authority check.
 *   A HYPERP market is intended to carry a non-zero hyperp_authority (UpdateAuthority
 *   HYPERP_MARK bootstrap, percolator.rs:7949-8044). The SDK surfaces that field as
 *   config.oracleAuthority (config offset 144 == hyperp_authority).
 *
 * Keeper bug: CrankService.isHyperpOracle requires index_feed_id==0 AND oracleAuthority==0
 * (crank.ts:563-567). So a HYPERP market with a bootstrapped non-zero hyperp_authority is
 * misclassified as NOT hyperp → the UpdateHyperpMark branch (crank.ts:691) is skipped → the
 * on-chain DEX-EMA mark goes stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return { ...actual };
});
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
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  getConnection: vi.fn(() => ({})),
  getFallbackConnection: vi.fn(() => ({})),
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => false } })),
  sendWithRetryKeeper: vi.fn(),
  eventBus: { publish: vi.fn() },
  getSupabase: vi.fn(),
}));
vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(), sharedBudget: new KeeperBudget() };
});

import { PublicKey } from "@solana/web3.js";
import { CrankService } from "../../src/services/crank.js";

const ZERO_FEED = { toBytes: () => new Uint8Array(32) };
function nonZeroFeed() { const a = new Uint8Array(32); a[0] = 0xab; return { toBytes: () => a }; }

// oracleAuthority.equals(PublicKey.default): zero → true (not admin); non-zero → false (admin).
const ZERO_AUTH = { equals: (_o: PublicKey) => true, toBase58: () => "11111111111111111111111111111111" };
const NONZERO_AUTH = { equals: (_o: PublicKey) => false, toBase58: () => "Auth1111111111111111111111111111111111111111" };

/** The program's actual rule. */
function programIsHyperp(market: any): boolean {
  return market.config.indexFeedId.toBytes().every((b: number) => b === 0);
}

describe("PoC: keeper HYPERP detection diverges from the program", () => {
  let crank: CrankService;
  beforeEach(() => {
    vi.clearAllMocks();
    crank = new CrankService({ pushPrice: vi.fn(), recordPushTime: vi.fn() } as any);
  });
  afterEach(() => crank.stop());

  it("FIXED: a HYPERP market with a non-zero hyperp_authority is now classified as hyperp", () => {
    const market = { slabAddress: { toBase58: () => "Slab" }, config: { indexFeedId: ZERO_FEED, oracleAuthority: NONZERO_AUTH } };

    // Program: this IS a hyperp market (index_feed_id == 0) and needs UpdateHyperpMark.
    expect(programIsHyperp(market)).toBe(true);
    // Keeper now agrees (no longer gated on oracleAuthority) → UpdateHyperpMark is sent.
    expect((crank as any).isHyperpOracle(market)).toBe(true);
  });

  it("a fresh HYPERP market (zero authority) is classified correctly", () => {
    const market = { slabAddress: { toBase58: () => "Slab" }, config: { indexFeedId: ZERO_FEED, oracleAuthority: ZERO_AUTH } };
    expect(programIsHyperp(market)).toBe(true);
    expect((crank as any).isHyperpOracle(market)).toBe(true);
  });

  it("a real external-feed (Pyth) market is not hyperp on either side", () => {
    const market = { slabAddress: { toBase58: () => "Slab" }, config: { indexFeedId: nonZeroFeed(), oracleAuthority: ZERO_AUTH } };
    expect(programIsHyperp(market)).toBe(false);
    expect((crank as any).isHyperpOracle(market)).toBe(false);
  });
});
