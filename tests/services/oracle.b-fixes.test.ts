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
  sendWithRetry: vi.fn(async () => "mock-sig"),
  eventBus: { publish: vi.fn() },
  getErrorMessage: vi.fn((err: unknown) =>
    err instanceof Error ? err.message : String(err),
  ),
  sendWarningAlert: hoisted.sendWarningAlert,
}));

const loggerWarn = hoisted.loggerWarn;
const sendWarningAlert = hoisted.sendWarningAlert;

import { OracleService } from "../../src/services/oracle.js";

function mockDexResponse(priceUsd: string, liquidityUsd = 100_000) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      pairs: [{ priceUsd, liquidity: { usd: liquidityUsd } }],
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
    mockDexResponse("0.0000001"); // 0.0000001 * 1e6 = 0.1 → rounds to 0
    const p = await svc.fetchDexScreenerPrice("MINT_B8_1");
    expect(p).toBeNull();
  });

  it("DexScreener: cached-hit branch also rejects 0n prices", async () => {
    // first call fills cache (sub-precision)
    mockDexResponse("0.0000004");
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
    mockDexResponse("0.5"); // 500_000
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

describe("oracle B-fixes — B6 per-mint single-source state", () => {
  let svc: OracleService;
  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });

  // We bypass the fetch path here: the module-level DexScreener cache + mock-queue
  // ordering makes fetch-based test scaffolding brittle. Spying on the public
  // methods exercises the single-source state machine deterministically.
  function makeSvcWith(getDex: (mint: string) => bigint | null, getJup: (mint: string) => bigint | null) {
    const s = new OracleService();
    vi.spyOn(s, "fetchDexScreenerPrice").mockImplementation(async (mint: string) => getDex(mint));
    vi.spyOn(s, "fetchJupiterPrice").mockImplementation(async (mint: string) => getJup(mint));
    return s;
  }

  it("alert for mint A's degraded feed does not silence alerts for mint B", async () => {
    const s = makeSvcWith(
      () => 1_000_000n,
      (mint) => (mint === "MINT_A_B6" ? null : null), // jupiter always down in this test
    );

    // 10 single-source iterations for MINT_A
    for (let i = 0; i < 10; i++) await s.fetchPrice("MINT_A_B6", "slab-A");
    expect(sendWarningAlert).toHaveBeenCalledTimes(1);
    expect(sendWarningAlert.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Mint", value: expect.stringContaining("MINT_A_B6") }),
      ]),
    );

    // 10 more single-source iterations for MINT_B should fire its OWN alert
    sendWarningAlert.mockClear();
    for (let i = 0; i < 10; i++) await s.fetchPrice("MINT_B_B6", "slab-B");
    expect(sendWarningAlert).toHaveBeenCalledTimes(1);
    expect(sendWarningAlert.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Mint", value: expect.stringContaining("MINT_B_B6") }),
      ]),
    );
  });

  it("recovery on mint A does not reset counters for mint B", async () => {
    let mintAJupReturns: bigint | null = null; // jupiter down for X by default
    const s = makeSvcWith(
      () => 1_000_000n,
      (mint) => (mint === "MINT_X" ? mintAJupReturns : null),
    );

    // 5 single-source for mint A (jup down) and 5 for mint B (jup down)
    for (let i = 0; i < 5; i++) await s.fetchPrice("MINT_X", "slab-x");
    for (let i = 0; i < 5; i++) await s.fetchPrice("MINT_Y", "slab-y");
    expect(sendWarningAlert).toHaveBeenCalledTimes(0);

    // Recover mint A by flipping the jup mock
    mintAJupReturns = 1_000_000n;
    await s.fetchPrice("MINT_X", "slab-x");

    // 5 more single-source for mint B → its consecutive hits 10 → alert fires for mint B
    for (let i = 0; i < 5; i++) await s.fetchPrice("MINT_Y", "slab-y");
    expect(sendWarningAlert).toHaveBeenCalledTimes(1);
    expect(sendWarningAlert.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Mint", value: expect.stringContaining("MINT_Y") }),
      ]),
    );
  });
});
