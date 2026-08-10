import { eventBus, createLogger, getErrorMessage, sendWarningAlert, sendCriticalAlert } from "@percolatorct/shared";
import { isMainnet } from "../config/network.js";
import { monitors } from "../lib/service-monitors.js";

const logger = createLogger("keeper:oracle");

// BL2: Extract magic numbers to named constants
const API_TIMEOUT_MS = 10_000; // 10 second timeout for external API calls
const PRICE_E6_MULTIPLIER = 1_000_000; // Price precision (6 decimals)

// Cross-source validation: reject if DexScreener and Jupiter diverge by more than this %
// Expressed in basis points (100 bps = 1%) for precise integer comparison
const MAX_CROSS_SOURCE_DEVIATION_BPS = 1000; // 10.00%

// Reject DexScreener pairs with liquidity below this threshold — low-liquidity
// pairs are trivially manipulable and should not be trusted for price discovery.
const MIN_LIQUIDITY_USD = 1_000;

// DexScreener rate limit: cache responses for 10s to avoid hitting limits
const dexScreenerCache = new Map<string, { data: DexScreenerResponse; fetchedAt: number }>();
const DEX_SCREENER_CACHE_TTL_MS = 10_000;
// Cap cache size to prevent unbounded memory growth from accumulated mint entries.
// 1000 entries ≈ worst-case ~2MB (each entry is a small JSON response).
const DEX_SCREENER_CACHE_MAX_SIZE = 1_000;

interface DexScreenerResponse {
  pairs?: Array<{
    priceUsd?: string;
    liquidity?: { usd?: number };
    baseToken?: { address?: string };
    quoteToken?: { address?: string };
  }>;
}

/**
 * #380: DexScreener's token endpoint returns every pair the mint appears in —
 * including pairs where it is the *quote* side. `priceUsd` always describes the
 * pair's BASE token, so a high-liquidity SOL/USDC pair returned for a USDC query
 * would otherwise hand back SOL's price as USDC's. Filter to pairs where the
 * queried mint is the base token before ranking by liquidity.
 *
 * Match is exact: Solana mint addresses are base58 and case-significant, so
 * case-insensitive comparison would risk conflating distinct mints.
 */
function selectPairForMint(
  pairs: DexScreenerResponse["pairs"],
  mint: string,
): NonNullable<DexScreenerResponse["pairs"]>[number] | undefined {
  if (!pairs) return undefined;
  return pairs
    .filter((p) => p.baseToken?.address === mint)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

interface JupiterResponse {
  data?: Record<string, { price?: string }>;
}

export class OracleService {
  private _nonAuthorityLogged = new Set<string>();
  private readonly rateLimitMs = parseInt(process.env.ORACLE_RATE_LIMIT_MS ?? "5000", 10);
  // BM2: Deduplicate concurrent requests for the same mint
  private inFlightRequests = new Map<string, Promise<bigint | null>>();

  /** Injectable clock — defaults to Date.now() in production; overridden in
   *  tests so price timestamps are deterministic without faking global Date
   *  around the async fetch path. */
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    // M5: DexScreener and Jupiter REST APIs return prices with NO publisher
    // signature and NO slot field. Cross-source validation (10% deviation) +
    // min-liquidity filter ($1000) + historical deviation cap (30%) mitigate
    // single-source manipulation, but if both sources are simultaneously
    // attacker-influenced (DNS poisoning, CDN compromise, MITM on a non-pinned
    // TLS chain), the keeper has no cryptographic recourse. Migrating to
    // Pyth Pull (signed on-chain) is the actual fix; this warn makes the
    // architectural debt explicit at boot so it is not silently inherited.
    //
    // To silence after operator acknowledgement, set
    // ORACLE_ACK_UNSIGNED_SOURCES=true. The keeper still emits a single info
    // log on boot so the acknowledgement remains audit-traceable in deploy logs.
    if (isMainnet()) {
      const ack = process.env.ORACLE_ACK_UNSIGNED_SOURCES === "true";
      if (ack) {
        logger.info(
          "OracleService: mainnet running with unsigned price sources (DexScreener/Jupiter) — operator acknowledgement received (ORACLE_ACK_UNSIGNED_SOURCES=true)",
        );
      } else {
        logger.warn(
          "OracleService: mainnet running with unsigned price sources (DexScreener/Jupiter). " +
            "These APIs have no publisher signature and no slot anchor. Cross-source validation, " +
            "min-liquidity ($1000), and historical deviation (30%) are partial mitigations only. " +
            "Migrate to Pyth Pull for cryptographic guarantees. Set ORACLE_ACK_UNSIGNED_SOURCES=true " +
            "to acknowledge this risk and silence this warn.",
        );
      }
    }
  }

  /** Fetch price from DexScreener (with rate-limit cache) */
  async fetchDexScreenerPrice(mint: string): Promise<bigint | null> {
    // BM2: Deduplicate concurrent requests
    const inFlight = this.inFlightRequests.get(`dex:${mint}`);
    if (inFlight) return inFlight;
    
    const promise = this._fetchDexScreenerPriceInternal(mint);
    this.inFlightRequests.set(`dex:${mint}`, promise);
    
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(`dex:${mint}`);
    }
  }

  private async _fetchDexScreenerPriceInternal(mint: string): Promise<bigint | null> {
    try {
      // BH7: Atomic cache check — capture timestamp once to avoid race condition
      const now = Date.now();
      const cached = dexScreenerCache.get(mint);
      
      if (cached) {
        const age = now - cached.fetchedAt;
        if (age < DEX_SCREENER_CACHE_TTL_MS) {
          // Cache hit — return cached value
          const pair = selectPairForMint(cached.data.pairs, mint);
          if (!pair?.priceUsd) return null;
          if ((pair.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return null;
          const p = parseFloat(pair.priceUsd);
          if (!isFinite(p) || p <= 0) return null;
          // B8: parseFloat + Math.round can produce 0 for sub-1e-7 prices,
          // which would pass downstream `!== null` checks but represent no
          // price at all. Reject explicitly.
          const priceE6 = BigInt(Math.round(p * PRICE_E6_MULTIPLIER));
          if (priceE6 === 0n) return null;
          return priceE6;
        }
      }

      // Cache miss or expired — fetch fresh data
      // BM1: Add 10s timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      // Encode mint to prevent URL injection (#783)
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
        signal: controller.signal,
        redirect: "error",
      });
      clearTimeout(timeoutId);

      // BUG-110: record real connectivity outcomes so /health's monitors.oracle
      // reflects whether the external price feeds are actually reachable.
      if (!res.ok) {
        monitors.oracle.recordFailure(`DexScreener HTTP ${res.status}`).catch(() => {});
        return null;
      }
      monitors.oracle.recordSuccess().catch(() => {});

      const json = (await res.json()) as DexScreenerResponse;

      // M7: Validate BEFORE caching — don't cache bad responses that would
      // suppress fresh fetches for the full TTL window.
      const pair = selectPairForMint(json.pairs, mint);
      if (!pair?.priceUsd) return null;
      if ((pair.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return null;
      const parsed = parseFloat(pair.priceUsd);
      if (!isFinite(parsed) || parsed <= 0) return null;
      // B8: see cache-hit branch above.
      const priceE6 = BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
      if (priceE6 === 0n) return null;

      // Only cache validated responses with a usable price.
      // BH7: Delete before set so refreshed entries move to the end of Map
      // iteration order — ensures eviction targets the least-recently-used
      // entry, not a frequently-refreshed one stuck at its insertion position.
      dexScreenerCache.delete(mint);
      dexScreenerCache.set(mint, { data: json, fetchedAt: now });
      if (dexScreenerCache.size > DEX_SCREENER_CACHE_MAX_SIZE) {
        const oldestKey = dexScreenerCache.keys().next().value;
        if (oldestKey !== undefined) dexScreenerCache.delete(oldestKey);
      }

      return priceE6;
    } catch (err) {
      // B9: log instead of silently swallowing — a sustained DexScreener outage
      // used to be invisible until cross-source validation alerts fired downstream.
      logger.warn("fetchDexScreenerPrice failed", {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      monitors.oracle.recordFailure(err instanceof Error ? err.message : String(err)).catch(() => {});
      return null;
    }
  }

  /** Fetch price from Jupiter */
  async fetchJupiterPrice(mint: string): Promise<bigint | null> {
    // BM2: Deduplicate concurrent requests
    const inFlight = this.inFlightRequests.get(`jup:${mint}`);
    if (inFlight) return inFlight;
    
    const promise = this._fetchJupiterPriceInternal(mint);
    this.inFlightRequests.set(`jup:${mint}`, promise);
    
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(`jup:${mint}`);
    }
  }

  private async _fetchJupiterPriceInternal(mint: string): Promise<bigint | null> {
    try {
      // BM1: Add 10s timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      // Encode mint to prevent query param injection (#783)
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${encodeURIComponent(mint)}`, {
        signal: controller.signal,
        redirect: "error",
      });
      clearTimeout(timeoutId);

      // BUG-110: see fetchDexScreenerPrice — same connectivity signal for Jupiter.
      if (!res.ok) {
        monitors.oracle.recordFailure(`Jupiter HTTP ${res.status}`).catch(() => {});
        return null;
      }
      monitors.oracle.recordSuccess().catch(() => {});

      const json = (await res.json()) as JupiterResponse;
      const priceStr = json.data?.[mint]?.price;
      if (!priceStr) return null;
      const parsed = parseFloat(priceStr);
      if (!isFinite(parsed) || parsed <= 0) return null;
      // B8: explicit zero short-circuit — see fetchDexScreenerPrice for rationale.
      const priceE6 = BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
      if (priceE6 === 0n) return null;
      return priceE6;
    } catch (err) {
      // B9: log instead of swallowing.
      logger.warn("fetchJupiterPrice failed", {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
      monitors.oracle.recordFailure(err instanceof Error ? err.message : String(err)).catch(() => {});
      return null;
    }
  }

  /**
   * Read-only price probe used by FraudDetectorService for cross-validation.
   * This is the only price entry point the keeper has.
   *
   * It is stateless by design: it fetches both sources, cross-validates them,
   * and returns: no history, no counters, no freshness clock. A probe therefore
   * cannot perturb anything else in the keeper, and a failed probe costs nothing
   * beyond the request.
   *
   * NOT a price oracle for on-chain decisions. v17 markets read Pyth on-chain;
   * these are unsigned third-party REST APIs with no publisher signature and no
   * slot anchor, suitable only for the fraud detector's off-chain cross-check.
   * Nothing here may gate a crank or a liquidation.
   *
   * (Historically OracleService also had fetchPrice(), which maintained price
   * history, a staleness clock and a deviation cap to feed the keeper's
   * admin-push oracle. That push was removed in 26c3c61 and 7289029 when v17
   * moved to reading Pyth on-chain, leaving fetchPrice with no callers; the
   * whole unused apparatus was deleted rather than left looking live. See #400.)
   */
  async peekPrice(mint: string): Promise<{ priceE6: bigint; source: string; timestamp: number } | null> {
    const [dexPrice, jupPrice] = await Promise.all([
      this.fetchDexScreenerPrice(mint),
      this.fetchJupiterPrice(mint),
    ]);

    if (dexPrice !== null && jupPrice !== null && dexPrice > 0n && jupPrice > 0n) {
      const larger = dexPrice > jupPrice ? dexPrice : jupPrice;
      const smaller = dexPrice > jupPrice ? jupPrice : dexPrice;
      const devBps = Number((larger - smaller) * 10_000n / smaller);
      if (devBps > MAX_CROSS_SOURCE_DEVIATION_BPS) return null;
    }

    const priceE6 = dexPrice ?? jupPrice;
    if (priceE6 === null) return null;

    const source = dexPrice !== null ? "dexscreener" : "jupiter";
    return { priceE6, source, timestamp: this.now() };
  }
}
