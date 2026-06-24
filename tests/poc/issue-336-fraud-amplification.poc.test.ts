/**
 * PoC for Finding #336 [MEDIUM] — fraud-detector amplification.
 *
 * ROOT CAUSE (pre-fix): the fraud cycle iterated EVERY discovered market every
 * 30s, awaiting 2 external HTTP calls per market; setInterval with no in-flight
 * guard allowed overlapping cycles; per-mint (not global) alert cooldown;
 * unbounded maps; classified HYPERP off a zero indexFeedId.
 *
 * FIX (#336): single-flight guard (recursive setTimeout + _inFlight),
 * per-cycle market cap with round-robin cursor, skip !isActive, dedupe by
 * priceMint, negative caching, global per-cycle alert budget, bounded maps.
 *
 * The reporter's PoC asserted the OLD (amplifying) behavior. The assertions
 * below are FLIPPED to the FIXED behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ sendWarningAlert: vi.fn(() => Promise.resolve()) }));

vi.mock("@percolatorct/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  sendWarningAlert: h.sendWarningAlert,
}));

import { FraudDetectorService } from "../../src/services/fraud-detector.js";

function zeroFeed(): { toBytes: () => Uint8Array } {
  return { toBytes: () => new Uint8Array(32) }; // all-zero → HYPERP
}

/**
 * Build a HYPERP market state with a unique collateral mint so each market is a
 * distinct priceMint (worst case for the amplification the fix bounds).
 */
function makeMarket(idx: number, configMark = 100_000_000n) {
  const mint = `Mint${idx.toString().padStart(36 - 4, "0")}`.slice(0, 44);
  return {
    market: {
      config: {
        indexFeedId: zeroFeed(),
        oracleAuthority: zeroFeed(),
        collateralMint: { toBase58: () => mint },
        authorityPriceE6: configMark,
      },
      engine: { markPriceE6: 0n },
    },
    isActive: true,
    mainnetCA: undefined,
  };
}

function makeMarkets(n: number): Map<string, any> {
  const m = new Map<string, any>();
  for (let i = 0; i < n; i++) m.set(`Slab${i.toString().padStart(40, "0")}`.slice(0, 44), makeMarket(i));
  return m;
}

describe("#336 PoC — fraud-detector amplification is bounded", () => {
  let oracle: { fetchPrice: ReturnType<typeof vi.fn>; peekPrice: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    oracle = { fetchPrice: vi.fn(), peekPrice: vi.fn() };
    // Reasonable test bounds via env (well under production defaults).
    process.env.FRAUD_DETECT_MAX_MARKETS_PER_CYCLE = "50";
    process.env.FRAUD_DETECT_MAX_ALERTS_PER_CYCLE = "10";
    process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS = "1800000";
    delete process.env.FRAUD_DETECT_NEGATIVE_CACHE_TTL_MS; // use default
  });

  afterEach(() => {
    delete process.env.FRAUD_DETECT_MAX_MARKETS_PER_CYCLE;
    delete process.env.FRAUD_DETECT_MAX_ALERTS_PER_CYCLE;
    delete process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS;
  });

  it("per-cycle MARKET cap is respected: at most N markets fetched per cycle (attacker flood)", async () => {
    // 1_000 attacker markets, cap 50 → only 50 fetches this cycle (not 1_000).
    const markets = makeMarkets(1_000);
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n }); // 100% divergence
    const svc = new FraudDetectorService(oracle as any, () => markets);

    await svc._runCheck();

    expect(oracle.peekPrice.mock.calls.length).toBeLessThanOrEqual(50);
    expect(oracle.peekPrice.mock.calls.length).toBeGreaterThan(0);
  });

  it("the round-robin cursor advances so every market is eventually covered", async () => {
    const markets = makeMarkets(120); // cap 50 → 3 cycles cover all 120
    oracle.peekPrice.mockResolvedValue({ priceE6: 100_000_000n }); // no divergence (avoid alert budget)
    const svc = new FraudDetectorService(oracle as any, () => markets);

    const seen = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle++) {
      oracle.peekPrice.mockClear();
      await svc._runCheck();
      for (const call of oracle.peekPrice.mock.calls) seen.add(call[0] as string);
    }
    // All 120 unique priceMints scanned across the 3 cycles.
    expect(seen.size).toBe(120);
  });

  it("a second CONCURRENT cycle is skipped by the single-flight guard", async () => {
    const markets = makeMarkets(3);
    let resolveFirst: (v: any) => void;
    let firstHung = false;
    // Hang ONLY the first fetch so the second _runCheck() lands mid-cycle;
    // resolve every later fetch immediately so the first cycle can complete.
    oracle.peekPrice.mockImplementation(() => {
      if (!firstHung) {
        firstHung = true;
        return new Promise((res) => { resolveFirst = res; });
      }
      return Promise.resolve({ priceE6: 100_000_000n });
    });
    const svc = new FraudDetectorService(oracle as any, () => markets);

    // async fns run synchronously up to their first await, so by the time
    // _runCheck() returns the first peekPrice() is already pending.
    const first = svc._runCheck();
    const callsAfterFirstStarted = oracle.peekPrice.mock.calls.length;
    expect(callsAfterFirstStarted).toBe(1); // exactly one fetch in flight

    const second = svc._runCheck();   // re-entrant → skipped by single-flight
    await second;

    // The second call did NOT start a new round of fetches.
    expect(oracle.peekPrice.mock.calls.length).toBe(callsAfterFirstStarted);

    resolveFirst!({ priceE6: 100_000_000n });
    await first; // first cycle finishes its remaining markets
  });

  it("global per-cycle ALERT budget bounds alerts even with many diverging mints", async () => {
    // 100 distinct mints all diverging; cap markets/cycle 50, alert budget 10.
    const markets = makeMarkets(100);
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n }); // 100% divergence on every mint
    const svc = new FraudDetectorService(oracle as any, () => markets);

    await svc._runCheck();

    // At most 10 alerts this cycle despite 50 diverging markets being scanned.
    expect(h.sendWarningAlert.mock.calls.length).toBeLessThanOrEqual(10);
    expect(h.sendWarningAlert.mock.calls.length).toBeGreaterThan(0);
  });

  it("negative cache: an unavailable mint is not re-fetched on the next cycle", async () => {
    const markets = makeMarkets(1); // single mint
    oracle.peekPrice.mockResolvedValue(null); // off-chain unavailable
    const svc = new FraudDetectorService(oracle as any, () => markets);

    await svc._runCheck();
    const callsAfterCycle1 = oracle.peekPrice.mock.calls.length;
    expect(callsAfterCycle1).toBe(1);

    // Next cycle within the TTL: the mint is negative-cached → no re-fetch.
    await svc._runCheck();
    expect(oracle.peekPrice.mock.calls.length).toBe(callsAfterCycle1); // unchanged
  });

  it("inactive markets are skipped (no HTTP fan-out)", async () => {
    const markets = makeMarkets(5);
    for (const [, st] of markets) st.isActive = false;
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n });
    const svc = new FraudDetectorService(oracle as any, () => markets);

    await svc._runCheck();
    expect(oracle.peekPrice).not.toHaveBeenCalled();
  });

  it("dedupe by priceMint: N markets sharing one mint cost ONE fetch", async () => {
    // 5 markets all with the same collateral mint (same priceMint).
    const markets = new Map<string, any>();
    for (let i = 0; i < 5; i++) {
      const st = makeMarket(0); // identical mint
      markets.set(`Slab${i.toString().padStart(40, "0")}`.slice(0, 44), st);
    }
    oracle.peekPrice.mockResolvedValue({ priceE6: 100_000_000n });
    const svc = new FraudDetectorService(oracle as any, () => markets);

    await svc._runCheck();
    expect(oracle.peekPrice).toHaveBeenCalledTimes(1); // one fetch, not 5
  });
});
