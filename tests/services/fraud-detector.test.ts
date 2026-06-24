import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── Shared mocks ─────────────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factory — required for factory closures.

const { mockWarnAlertFn, mockFraudDivergenceBps, mockFraudAlertTotal, mockFraudOffchainUnavailableTotal } =
  vi.hoisted(() => ({
    mockWarnAlertFn: vi.fn(),
    mockFraudDivergenceBps: { set: vi.fn() },
    mockFraudAlertTotal: { inc: vi.fn() },
    mockFraudOffchainUnavailableTotal: { inc: vi.fn() },
  }));

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: mockWarnAlertFn,
}));

vi.mock("../../src/lib/metrics.js", () => ({
  fraudDivergenceBps: mockFraudDivergenceBps,
  fraudAlertTotal: mockFraudAlertTotal,
  fraudOffchainUnavailableTotal: mockFraudOffchainUnavailableTotal,
}));

import {
  FraudDetectorService,
  divergenceBps,
} from "../../src/services/fraud-detector.js";
import type { OracleService } from "../../src/services/oracle.js";
import type { MarketCrankState } from "../../src/services/crank-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal HYPERP MarketCrankState for tests. */
function makeHyperpState(opts: {
  markPriceE6?: bigint;
  collateralMint?: string;
  /** If true, make oracle authority non-zero (non-HYPERP market) */
  nonZeroAuthority?: boolean;
  /** If true, make indexFeedId non-zero (non-HYPERP market) */
  nonZeroFeed?: boolean;
  mainnetCA?: string;
  /** v17 oracle mode: 0=MANUAL, 2=EWMA_MARK, 3=AUTH_MARK. Omit for v12 market (no _rawV17Config). */
  v17OracleMode?: number;
}): MarketCrankState {
  const ZERO = new PublicKey("11111111111111111111111111111111");
  const NONZERO = new PublicKey("So11111111111111111111111111111111111111112");
  // Valid base58 mint address (44 chars, base58 alphabet only)
  const mint = opts.collateralMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  return {
    market: {
      slabAddress: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), // valid base58
      programId: new PublicKey("11111111111111111111111111111111"),
      header: {} as never,
      config: {
        collateralMint: new PublicKey(mint),
        indexFeedId: opts.nonZeroFeed ? NONZERO : ZERO,
        oracleAuthority: opts.nonZeroAuthority ? NONZERO : ZERO,
        // The on-chain HYPERP mark (program hyperp_mark_e6) is surfaced by the SDK
        // as config.authorityPriceE6 — this is what the fraud detector reads.
        authorityPriceE6: opts.markPriceE6 ?? 1_000_000n, // default $1.00 in E6
        dexPool: null,
      } as never,
      engine: {
        // v12.17+ dropped the engine mark field; parseEngine returns 0n.
        markPriceE6: 0n,
      } as never,
      params: {} as never,
      // #340: v17 oracle mode — only present for v17 markets. Omit for v12.
      ...(opts.v17OracleMode !== undefined
        ? { _rawV17Config: { oracleMode: opts.v17OracleMode } }
        : {}),
    },
    lastCrankTime: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    isActive: true,
    missingDiscoveryCount: 0,
    mainnetCA: opts.mainnetCA,
  };
}

/** Build a mock OracleService with controllable fetchPrice/peekPrice behavior. */
function makeMockOracle(
  resolveWith: Awaited<ReturnType<OracleService["fetchPrice"]>>,
): OracleService {
  return {
    fetchPrice: vi.fn().mockResolvedValue(resolveWith),
    peekPrice: vi.fn().mockResolvedValue(resolveWith),
  } as unknown as OracleService;
}

function makeThrowingOracle(err: Error): OracleService {
  return {
    fetchPrice: vi.fn().mockRejectedValue(err),
    peekPrice: vi.fn().mockRejectedValue(err),
  } as unknown as OracleService;
}

// ── divergenceBps pure function ───────────────────────────────────────────────

describe("divergenceBps", () => {
  it("returns 0 when values are equal", () => {
    expect(divergenceBps(1_000_000n, 1_000_000n)).toBe(0);
  });

  it("returns 0 when offchain is 0 (divide-by-zero guard)", () => {
    expect(divergenceBps(1_000_000n, 0n)).toBe(0);
    expect(divergenceBps(1_000_000n, 0)).toBe(0);
  });

  it("is always non-negative", () => {
    expect(divergenceBps(900_000n, 1_000_000n)).toBeGreaterThanOrEqual(0);
    expect(divergenceBps(1_100_000n, 1_000_000n)).toBeGreaterThanOrEqual(0);
  });

  it("computes 500 bps for 5% difference (onchain below offchain)", () => {
    // 950_000 / 1_000_000 = 0.95 → diff 5% → 500 bps
    expect(divergenceBps(950_000n, 1_000_000n)).toBe(500);
  });

  it("computes 500 bps for 5% difference (onchain above offchain)", () => {
    // 1_050_000 vs 1_000_000 → |50_000| / 1_000_000 * 10_000 = 500
    expect(divergenceBps(1_050_000n, 1_000_000n)).toBe(500);
  });

  it("accepts Number inputs as well as bigint", () => {
    expect(divergenceBps(950_000, 1_000_000)).toBe(500);
  });
});

// ── FraudDetectorService unit tests ─────────────────────────────────────────

describe("FraudDetectorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults
    delete process.env.FRAUD_DETECT_ENABLED;
    delete process.env.FRAUD_DETECT_DIVERGENCE_BPS;
    delete process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS;
    delete process.env.FRAUD_DETECT_INTERVAL_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── FRAUD_DETECT_ENABLED=false ─────────────────────────────────────────────

  it("start() is a no-op when FRAUD_DETECT_ENABLED=false", () => {
    process.env.FRAUD_DETECT_ENABLED = "false";
    vi.useFakeTimers();
    const oracle = makeMockOracle(null);
    const svc = new FraudDetectorService(oracle, () => new Map());
    svc.start();
    // Advance time by 60 seconds — no check cycle should fire
    vi.advanceTimersByTime(60_000);
    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
    svc.stop();
  });

  // ── stop() clears interval ─────────────────────────────────────────────────

  it("stop() clears the interval so no further checks run", async () => {
    process.env.FRAUD_DETECT_INTERVAL_MS = "100";
    vi.useFakeTimers();
    const oracle = makeMockOracle(null);
    const svc = new FraudDetectorService(oracle, () => new Map());
    svc.start();
    vi.advanceTimersByTime(50);
    svc.stop();
    vi.advanceTimersByTime(300);
    // peekPrice/fetchPrice never called (no HYPERP markets in empty map)
    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
  });

  // ── small divergence: no alert ────────────────────────────────────────────

  it("does not alert when divergence is below threshold", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    // on-chain: $1.01, off-chain: $1.00 → 100 bps (below 500)
    const onChain = 1_010_000n; // E6
    const offChain = 1_000_000n; // E6

    const state = makeHyperpState({ markPriceE6: onChain });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: offChain, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(mockWarnAlertFn).not.toHaveBeenCalled();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
    // Gauge is still updated
    expect(mockFraudDivergenceBps.set).toHaveBeenCalledWith(
      { mint: state.market.config.collateralMint.toBase58() },
      expect.any(Number),
    );
  });

  // ── large divergence: alert fires ────────────────────────────────────────

  it("sends alert and increments counter when divergence exceeds threshold", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    // on-chain: $2.00, off-chain: $1.00 → 10_000 bps (way above 500)
    const onChain = 2_000_000n;
    const offChain = 1_000_000n;

    const state = makeHyperpState({ markPriceE6: onChain });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: offChain, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(mockFraudAlertTotal.inc).toHaveBeenCalledOnce();
    expect(mockWarnAlertFn).toHaveBeenCalledOnce();
    expect(mockFraudDivergenceBps.set).toHaveBeenCalledWith(
      { mint: state.market.config.collateralMint.toBase58() },
      10_000,
    );
  });

  // ── cooldown: second call within window suppresses alert ─────────────────

  it("suppresses second alert within the cooldown window for the same mint", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS = "1800000"; // 30 min
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const onChain = 2_000_000n;
    const offChain = 1_000_000n;

    const state = makeHyperpState({ markPriceE6: onChain });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: offChain, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);

    // First call — alert should fire
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(1);

    // Advance by 5 minutes (well within 30min cooldown)
    vi.advanceTimersByTime(5 * 60_000);

    // Second call — should be suppressed
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(1); // still only 1
    expect(mockWarnAlertFn).toHaveBeenCalledTimes(1); // still only 1
  });

  // ── cooldown expiry: alert re-fires ──────────────────────────────────────

  it("re-fires alert after the cooldown window has expired", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS = "60000"; // 60 seconds for test speed
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const onChain = 2_000_000n;
    const offChain = 1_000_000n;

    const state = makeHyperpState({ markPriceE6: onChain });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: offChain, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);

    // First alert
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(1);

    // Advance past the 60s cooldown window
    vi.advanceTimersByTime(61_000);

    // Second alert — cooldown has expired
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(2);
    expect(mockWarnAlertFn).toHaveBeenCalledTimes(2);
  });

  // ── missing off-chain price: skip + increment unavailable counter ─────────

  it("skips market and increments unavailable counter when fetchPrice returns null", async () => {
    const state = makeHyperpState({ markPriceE6: 1_000_000n });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle(null);

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(mockFraudOffchainUnavailableTotal.inc).toHaveBeenCalledOnce();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
    expect(mockWarnAlertFn).not.toHaveBeenCalled();
  });

  it("skips market and increments unavailable counter when fetchPrice throws", async () => {
    const state = makeHyperpState({ markPriceE6: 1_000_000n });
    const markets = new Map([["slab1", state]]);
    const oracle = makeThrowingOracle(new Error("network error"));

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(mockFraudOffchainUnavailableTotal.inc).toHaveBeenCalledOnce();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
    expect(mockWarnAlertFn).not.toHaveBeenCalled();
  });

  // ── non-HYPERP markets are skipped ──────────────────────────────────────

  it("STILL checks a HYPERP market that carries a non-zero oracle authority (program: hyperp iff index_feed_id==0)", async () => {
    // Post-Phase-G a bootstrapped HYPERP market carries a non-zero hyperp_authority;
    // it must still be cross-validated, so the detector must NOT skip it.
    const state = makeHyperpState({ nonZeroAuthority: true });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(oracle.peekPrice).toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
  });

  it("skips non-HYPERP market where indexFeedId is non-zero", async () => {
    const state = makeHyperpState({ nonZeroFeed: true });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
  });

  // ── on-chain mark price is zero: skip market ─────────────────────────────

  it("skips market when the on-chain mark (config.authorityPriceE6) is zero", async () => {
    const state = makeHyperpState({ markPriceE6: 0n });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
    expect(mockFraudOffchainUnavailableTotal.inc).not.toHaveBeenCalled();
  });

  // ── multiple markets: independent per-mint cooldowns ─────────────────────

  it("applies independent cooldowns per mint — alert for one mint does not suppress the other", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS = "1800000";
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    vi.useFakeTimers();

    // Valid base58 mint addresses
    const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const mint2 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; // USDT

    const stateA = makeHyperpState({ markPriceE6: 2_000_000n, collateralMint: mint1 });
    const stateB = makeHyperpState({ markPriceE6: 2_000_000n, collateralMint: mint2 });
    const markets = new Map([["slabA", stateA], ["slabB", stateB]]);

    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });

    const svc = new FraudDetectorService(oracle, () => markets);

    // Both markets should alert on first run
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(2);

    // Second run within cooldown — both suppressed
    await svc._runCheck();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(2); // unchanged
  });

  // ── mainnetCA is used for price lookup when set ───────────────────────────

  it("uses mainnetCA for price lookup when set on the market state", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";

    // Valid base58 mainnet CA (SOL mint)
    const mainnetCA = "So11111111111111111111111111111111111111112";
    const state = makeHyperpState({ markPriceE6: 1_000_000n, mainnetCA });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({
      priceE6: 1_000_000n,
      source: "dexscreener",
      timestamp: Date.now(),
    });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    // peekPrice should be called with mainnetCA (no slabAddress — peekPrice is read-only)
    expect(oracle.peekPrice).toHaveBeenCalledWith(mainnetCA);
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
  });

  // ── malformed env config PoC ───────────────────────────────────────────────

  it("falls back to the default divergence threshold when FRAUD_DETECT_DIVERGENCE_BPS is malformed", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "abc";
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    // on-chain: $1.01, off-chain: $1.00 → 100 bps.
    // With the default 500 bps threshold, this should NOT alert.
    const onChain = 1_010_000n;
    const offChain = 1_000_000n;

    const state = makeHyperpState({ markPriceE6: onChain });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({
      priceE6: offChain,
      source: "dexscreener",
      timestamp: Date.now(),
    });

    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();

    expect(mockWarnAlertFn).not.toHaveBeenCalled();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
  });

  it("falls back to the default cooldown when FRAUD_DETECT_PER_MINT_COOLDOWN_MS is negative", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS = "-1";
    mockWarnAlertFn.mockReturnValue(Promise.resolve());

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const state = makeHyperpState({ markPriceE6: 2_000_000n });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({
      priceE6: 1_000_000n,
      source: "dexscreener",
      timestamp: Date.now(),
    });

    const svc = new FraudDetectorService(oracle, () => markets);

    await svc._runCheck();
    await svc._runCheck();

    expect(mockWarnAlertFn).toHaveBeenCalledTimes(1);
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledTimes(1);
  });

  // ── #340: v17 oracle mode enrollment ──────────────────────────────────────

  it("#340: v17 MANUAL(0) market with zero indexFeedId is NOT fraud-enrolled", async () => {
    const state = makeHyperpState({ markPriceE6: 2_000_000n, v17OracleMode: 0 });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });
    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();
    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
  });

  it("#340: v17 EWMA_MARK(2) market with zero indexFeedId is NOT fraud-enrolled", async () => {
    const state = makeHyperpState({ markPriceE6: 2_000_000n, v17OracleMode: 2 });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });
    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();
    expect(oracle.peekPrice).not.toHaveBeenCalled();
    expect(mockFraudAlertTotal.inc).not.toHaveBeenCalled();
  });

  it("#340: v17 AUTH_MARK(3) market IS fraud-enrolled and alerts on divergence", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    mockWarnAlertFn.mockReturnValue(Promise.resolve());
    const state = makeHyperpState({ markPriceE6: 2_000_000n, v17OracleMode: 3 });
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });
    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();
    expect(oracle.peekPrice).toHaveBeenCalled();
    expect(mockFraudAlertTotal.inc).toHaveBeenCalledOnce();
  });

  it("#340: fraud-detector uses peekPrice not fetchPrice, so fetchPrice freshness state is NOT mutated", async () => {
    process.env.FRAUD_DETECT_DIVERGENCE_BPS = "500";
    const state = makeHyperpState({ markPriceE6: 1_000_000n }); // v12 HYPERP (no _rawV17Config)
    const markets = new Map([["slab1", state]]);
    const oracle = makeMockOracle({ priceE6: 1_000_000n, source: "dexscreener", timestamp: Date.now() });
    const svc = new FraudDetectorService(oracle, () => markets);
    await svc._runCheck();
    expect(oracle.peekPrice).toHaveBeenCalled();
    expect(oracle.fetchPrice).not.toHaveBeenCalled();
  });
});
