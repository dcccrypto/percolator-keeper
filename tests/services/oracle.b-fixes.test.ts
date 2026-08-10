/**
 * Regression tests for Phase 1 Workstream B′ oracle.ts fixes.
 *
 * - B6: single-source state is per-mint; a degraded feed for mint A must not
 *   trigger or silence alerts for mint B
 * - B8: parseFloat → BigInt conversions that round to 0n short-circuit to null
 * - B9: DexScreener / Jupiter fetch errors are logged (not silently swallowed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

global.fetch = vi.fn();

// vi.mock factory is hoisted above plain top-level `const` declarations and
// would TDZ-crash if it tried to capture them — vi.hoisted lifts the spies
// alongside the mocks so both run in the right order.
const hoisted = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  sendWarningAlert: vi.fn().mockResolvedValue(undefined),
}));

// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  sendWithRetry: vi.fn(async () => "mock-sig"),
  eventBus: { publish: vi.fn() },
  getErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err),
  ),
  sendWarningAlert: hoisted.sendWarningAlert,
  // BUG-110: src/lib/service-monitors.ts calls this at import time.
  createServiceMonitors: vi.fn(() => {
    const m = () => ({ recordSuccess: vi.fn(async () => {}), recordFailure: vi.fn(async () => {}), getErrorRate: vi.fn(() => 0), getStatus: vi.fn(() => ({ healthy: true, consecutiveFailures: 0, errorRate: 0, timeSinceSuccessMs: 0, alertActive: false })) });
    return { rpc: m(), scan: m(), oracle: m(), db: m() };
  }),
}));

const loggerWarn = hoisted.loggerWarn;
const sendWarningAlert = hoisted.sendWarningAlert;

import { OracleService } from "../../src/services/oracle.js";

function mockDexResponse(priceUsd: string, mint: string, liquidityUsd = 100_000) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      pairs: [{ priceUsd, liquidity: { usd: liquidityUsd }, baseToken: { address: mint } }],
    }),
  } as any);
}

function mockJupResponse(price: string | null, mint: string) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () =>
      price === null
        ? { data: {} }
        : { data: { [mint]: { price } } },
  } as any);
}

describe("oracle B-fixes — B8 priceE6===0n short-circuit", () => {
  let svc: OracleService;
  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });
  afterEach(() => vi.restoreAllMocks());

  it("DexScreener: rejects sub-precision prices that would round to 0n", async () => {
    mockDexResponse("0.0000001", "MINT_B8_1"); // 0.0000001 * 1e6 = 0.1 → rounds to 0
    const p = await svc.fetchDexScreenerPrice("MINT_B8_1");
    expect(p).toBeNull();
  });

  it("DexScreener: cached-hit branch also rejects 0n prices", async () => {
    // first call fills cache (sub-precision)
    mockDexResponse("0.0000004", "MINT_B8_2");
    const first = await svc.fetchDexScreenerPrice("MINT_B8_2");
    expect(first).toBeNull();

    // second call hits cache → also returns null (not a 0n bigint)
    const second = await svc.fetchDexScreenerPrice("MINT_B8_2");
    expect(second).toBeNull();
  });

  it("Jupiter: rejects sub-precision prices that would round to 0n", async () => {
    mockJupResponse("0.0000003", "MINT_B8_3");
    const p = await svc.fetchJupiterPrice("MINT_B8_3");
    expect(p).toBeNull();
  });

  it("DexScreener: still returns the price for legit values", async () => {
    mockDexResponse("0.5", "MINT_B8_4"); // 500_000
    const p = await svc.fetchDexScreenerPrice("MINT_B8_4");
    expect(p).toBe(500_000n);
  });
});

describe("oracle B-fixes — B9 fetch error logging", () => {
  let svc: OracleService;
  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });

  it("logs DexScreener fetch failures via logger.warn", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET"));
    await svc.fetchDexScreenerPrice("MINT_B9_1");
    expect(loggerWarn).toHaveBeenCalledWith(
      "fetchDexScreenerPrice failed",
      expect.objectContaining({ mint: "MINT_B9_1", error: "ECONNRESET" }),
    );
  });

  it("logs Jupiter fetch failures via logger.warn", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("HTTP/2 stream reset"));
    await svc.fetchJupiterPrice("MINT_B9_2");
    expect(loggerWarn).toHaveBeenCalledWith(
      "fetchJupiterPrice failed",
      expect.objectContaining({ mint: "MINT_B9_2", error: "HTTP/2 stream reset" }),
    );
  });
});
