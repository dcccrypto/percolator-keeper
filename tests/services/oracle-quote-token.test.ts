/**
 * Regression tests for #380 — DexScreener quote-side price injection.
 *
 * DexScreener's /latest/dex/tokens/<mint> endpoint returns every pair the mint
 * appears in, including pairs where it is the QUOTE token. `priceUsd` always
 * describes the pair's BASE token, so accepting the highest-liquidity pair
 * without checking `baseToken.address` lets an unrelated asset's price be
 * attributed to the queried mint.
 *
 * NOTE: the DexScreener response cache is module-level and keyed by mint, so it
 * survives both `new OracleService()` and test boundaries. Each test therefore
 * uses its own unique mint to stay isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

global.fetch = vi.fn();

const hoisted = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  sendWarningAlert: vi.fn().mockResolvedValue(undefined),
  sendCriticalAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@percolatorct/sdk", () => ({
  encodePushOraclePrice: vi.fn(() => Buffer.from([1])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock("@percolatorct/shared", () => ({
  config: {
    programId: "11111111111111111111111111111111",
    crankKeypair: "mock-keypair-path",
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: hoisted.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({ getAccountInfo: vi.fn() })),
  loadKeypair: vi.fn(() => ({
    publicKey: new PublicKey("11111111111111111111111111111111"),
    secretKey: new Uint8Array(64),
  })),
  eventBus: { publish: vi.fn() },
  getErrorMessage: (err: unknown) => String(err),
  sendWarningAlert: hoisted.sendWarningAlert,
  sendCriticalAlert: hoisted.sendCriticalAlert,
  // #369: src/lib/service-monitors.ts calls this at import time, and oracle.ts
  // imports it — so every test file that mocks this module must supply it or
  // the suite fails at collection. Intermittent without this: it only throws
  // when this file is the first in its worker to load service-monitors.ts.
  createServiceMonitors: vi.fn(() => {
    const m = () => ({
      recordSuccess: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      getErrorRate: vi.fn(() => 0),
      getStatus: vi.fn(() => ({
        healthy: true,
        consecutiveFailures: 0,
        errorRate: 0,
        timeSinceSuccessMs: 0,
        alertActive: false,
      })),
    });
    return { rpc: m(), scan: m(), oracle: m(), db: m() };
  }),
}));

import { OracleService } from "../../src/services/oracle.js";

/** The unrelated high-liquidity asset whose price must never leak through. */
const OTHER_MINT = "So11111111111111111111111111111111111111112";

/** Unique per-test mint — the module-level response cache is keyed by mint. */
let mintCounter = 0;
function uniqueMint(): string {
  mintCounter += 1;
  return `Mint${String(mintCounter).padStart(40, "0")}`;
}

/** Reach the private DexScreener fetch without exercising the whole crank. */
function fetchDex(oracle: OracleService, mint: string): Promise<bigint | null> {
  return (
    oracle as unknown as {
      _fetchDexScreenerPriceInternal(m: string): Promise<bigint | null>;
    }
  )._fetchDexScreenerPriceInternal(mint);
}

function mockDexPairs(pairs: unknown[]): void {
  vi.mocked(global.fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ pairs }),
  } as Response);
}

describe("#380 DexScreener quote-token confusion", () => {
  let oracle: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    oracle = new OracleService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a high-liquidity pair where the queried mint is the quote token", async () => {
    const mint = uniqueMint();
    mockDexPairs([
      {
        // SOL/<mint>: priceUsd is SOL's price, not the queried mint's.
        baseToken: { address: OTHER_MINT },
        quoteToken: { address: mint },
        priceUsd: "200.00",
        liquidity: { usd: 50_000_000 },
      },
    ]);

    await expect(fetchDex(oracle, mint)).resolves.toBeNull();
  });

  it("prefers the queried mint's own pair over a higher-liquidity quote-side pair", async () => {
    const mint = uniqueMint();
    mockDexPairs([
      {
        baseToken: { address: OTHER_MINT },
        quoteToken: { address: mint },
        priceUsd: "200.00",
        liquidity: { usd: 50_000_000 },
      },
      {
        baseToken: { address: mint },
        quoteToken: { address: OTHER_MINT },
        priceUsd: "1.0001",
        liquidity: { usd: 250_000 },
      },
    ]);

    // 1.0001 * 1e6 — the queried mint's real price, not SOL's 200.
    await expect(fetchDex(oracle, mint)).resolves.toBe(1_000_100n);
  });

  it("still ranks base-token pairs by liquidity", async () => {
    const mint = uniqueMint();
    mockDexPairs([
      { baseToken: { address: mint }, priceUsd: "0.90", liquidity: { usd: 5_000 } },
      { baseToken: { address: mint }, priceUsd: "1.00", liquidity: { usd: 900_000 } },
    ]);

    await expect(fetchDex(oracle, mint)).resolves.toBe(1_000_000n);
  });

  it("rejects pairs that omit baseToken entirely", async () => {
    const mint = uniqueMint();
    mockDexPairs([{ priceUsd: "200.00", liquidity: { usd: 50_000_000 } }]);

    await expect(fetchDex(oracle, mint)).resolves.toBeNull();
  });

  it("does not match a mint that differs only by case", async () => {
    const mint = uniqueMint();
    mockDexPairs([
      {
        baseToken: { address: mint.toUpperCase() },
        priceUsd: "200.00",
        liquidity: { usd: 50_000_000 },
      },
    ]);

    await expect(fetchDex(oracle, mint)).resolves.toBeNull();
  });

  it("applies the base-token check on the cached path too", async () => {
    const mint = uniqueMint();
    // A response containing both a quote-side pair (higher liquidity) and a
    // legitimate base-side pair caches successfully on the fresh path...
    mockDexPairs([
      {
        baseToken: { address: OTHER_MINT },
        quoteToken: { address: mint },
        priceUsd: "200.00",
        liquidity: { usd: 50_000_000 },
      },
      {
        baseToken: { address: mint },
        quoteToken: { address: OTHER_MINT },
        priceUsd: "1.0001",
        liquidity: { usd: 250_000 },
      },
    ]);
    await expect(fetchDex(oracle, mint)).resolves.toBe(1_000_100n);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // ...and the subsequent cache hit must re-apply the same filter rather than
    // taking the highest-liquidity (quote-side) pair off the cached payload.
    await expect(fetchDex(oracle, mint)).resolves.toBe(1_000_100n);
    expect(global.fetch).toHaveBeenCalledTimes(1); // served from cache
  });
});
