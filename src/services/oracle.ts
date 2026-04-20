import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  type MarketConfig,
} from "@percolatorct/sdk";
import { eventBus, createLogger, getErrorMessage, sendWarningAlert } from "@percolatorct/shared";

const logger = createLogger("keeper:oracle");

interface PriceEntry {
  priceE6: bigint;
  source: string;
  timestamp: number;
}

// BL2: Extract magic numbers to named constants
const API_TIMEOUT_MS = 10_000; // 10 second timeout for external API calls
const PRICE_E6_MULTIPLIER = 1_000_000; // Price precision (6 decimals)
const CACHED_PRICE_MAX_AGE_MS = 60_000; // Reject cached prices older than 60s

// M-4: Maximum duration the on-chain fallback may be used before we stop pushing
// and let the oracle go stale. This prevents an infinite stale loop where the keeper
// re-pushes an old on-chain price indefinitely while all external sources are down.
const ON_CHAIN_FALLBACK_MAX_MS = 60_000; // 60 seconds

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
  pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
}

function sortPairsByLiquidity(pairs: DexScreenerResponse["pairs"]): DexScreenerResponse["pairs"] {
  if (!pairs) return pairs;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

interface JupiterResponse {
  data?: Record<string, { price?: string }>;
}

export class OracleService {
  private priceHistory = new Map<string, PriceEntry[]>();
  private lastPushTime = new Map<string, number>();
  private _nonAuthorityLogged = new Set<string>();
  private readonly rateLimitMs = parseInt(process.env.ORACLE_RATE_LIMIT_MS ?? "5000", 10);
  private readonly maxHistory = 100;
  private readonly maxTrackedMarkets = 500;
  // BM2: Deduplicate concurrent requests for the same mint
  private inFlightRequests = new Map<string, Promise<bigint | null>>();
  // Track consecutive single-source fetches to detect degraded cross-validation
  private _consecutiveSingleSource = 0;
  private _singleSourceAlertSent = false;
  private static readonly SINGLE_SOURCE_ALERT_THRESHOLD = 10;
  // M-4: Track when an external source (DexScreener or Jupiter) last returned a
  // valid price for each slab. Used to cap the on-chain fallback duration so that
  // a prolonged external outage causes the oracle to go stale rather than cycling
  // the same on-chain price forever.
  private lastExternalPriceMs = new Map<string, number>();

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
          const pair = sortPairsByLiquidity(cached.data.pairs)?.[0];
          if (!pair?.priceUsd) return null;
          if ((pair.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return null;
          const p = parseFloat(pair.priceUsd);
          if (!isFinite(p) || p <= 0) return null;
          return BigInt(Math.round(p * PRICE_E6_MULTIPLIER));
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

      if (!res.ok) return null;
      
      const json = (await res.json()) as DexScreenerResponse;
      // BH7: Use captured timestamp for atomicity.
      // Delete before set so refreshed entries move to the end of Map
      // iteration order — ensures eviction targets the least-recently-used
      // entry, not a frequently-refreshed one stuck at its insertion position.
      dexScreenerCache.delete(mint);
      dexScreenerCache.set(mint, { data: json, fetchedAt: now });
      // Evict oldest entry when cache exceeds size cap
      if (dexScreenerCache.size > DEX_SCREENER_CACHE_MAX_SIZE) {
        const oldestKey = dexScreenerCache.keys().next().value;
        if (oldestKey !== undefined) dexScreenerCache.delete(oldestKey);
      }

      const pair = sortPairsByLiquidity(json.pairs)?.[0];
      if (!pair?.priceUsd) return null;
      if ((pair.liquidity?.usd ?? 0) < MIN_LIQUIDITY_USD) return null;
      const parsed = parseFloat(pair.priceUsd);
      if (!isFinite(parsed) || parsed <= 0) return null;
      return BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
    } catch {
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

      if (!res.ok) return null;
      
      const json = (await res.json()) as JupiterResponse;
      const priceStr = json.data?.[mint]?.price;
      if (!priceStr) return null;
      const parsed = parseFloat(priceStr);
      if (!isFinite(parsed) || parsed <= 0) return null;
      return BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
    } catch {
      return null;
    }
  }

  /**
   * Fetch price with cross-source validation and fallback.
   *
   * Strategy:
   *   1. Fetch DexScreener and Jupiter in parallel
   *   2. If both respond, cross-validate (reject if divergence > CROSS_SOURCE_MAX_DEVIATION_PCT)
   *   3. Use the higher-confidence source (DexScreener preferred, Jupiter fallback)
   *   4. If both fail, use cached price (reject if stale >60s)
   *   5. Historical deviation check (reject if >30% change from last known price)
   */
  async fetchPrice(mint: string, slabAddress: string): Promise<PriceEntry | null> {
    // Fetch both sources in parallel for cross-validation
    const [dexPrice, jupPrice] = await Promise.all([
      this.fetchDexScreenerPrice(mint),
      this.fetchJupiterPrice(mint),
    ]);

    // Cross-source validation: if both sources respond, check agreement
    if (dexPrice !== null && jupPrice !== null && dexPrice > 0n && jupPrice > 0n) {
      const larger = dexPrice > jupPrice ? dexPrice : jupPrice;
      const smaller = dexPrice > jupPrice ? jupPrice : dexPrice;
      const divergenceBps = Number((larger - smaller) * 10_000n / smaller);

      if (divergenceBps > MAX_CROSS_SOURCE_DEVIATION_BPS) {
        logger.warn("Cross-source divergence detected", {
          mint,
          divergenceBps,
          maxAllowed: MAX_CROSS_SOURCE_DEVIATION_BPS,
          dexPrice: dexPrice.toString(),
          jupPrice: jupPrice.toString()
        });
        return null;
      }
    }

    // Track cross-validation coverage: alert when single-source mode persists
    const bothAvailable = dexPrice !== null && jupPrice !== null;
    if (bothAvailable) {
      if (this._consecutiveSingleSource > 0) {
        logger.info("Cross-source validation restored", {
          previousSingleSourceCount: this._consecutiveSingleSource,
        });
      }
      this._consecutiveSingleSource = 0;
      this._singleSourceAlertSent = false;
    } else if (dexPrice !== null || jupPrice !== null) {
      this._consecutiveSingleSource++;
      const degradedSource = dexPrice !== null ? "dexscreener" : "jupiter";
      const downSource = dexPrice !== null ? "jupiter" : "dexscreener";
      if (
        this._consecutiveSingleSource >= OracleService.SINGLE_SOURCE_ALERT_THRESHOLD &&
        !this._singleSourceAlertSent
      ) {
        this._singleSourceAlertSent = true;
        logger.warn("Cross-source validation degraded — operating on single source", {
          consecutiveSingleSource: this._consecutiveSingleSource,
          activeSource: degradedSource,
          downSource,
        });
        sendWarningAlert("Oracle cross-validation degraded", [
          { name: "Active Source", value: degradedSource, inline: true },
          { name: "Down Source", value: downSource, inline: true },
          { name: "Consecutive", value: String(this._consecutiveSingleSource), inline: true },
        ])?.catch(() => {});
      }
    }

    // Select best available price (DexScreener preferred)
    let priceE6: bigint | null = dexPrice;
    let source = "dexscreener";
    if (priceE6 === null) {
      priceE6 = jupPrice;
      source = "jupiter";
    }

    if (priceE6 === null) {
      const history = this.priceHistory.get(slabAddress);
      if (history && history.length > 0) {
        const last = history[history.length - 1];
        // Reject stale cached prices (>60s) to prevent bad liquidations
        if (Date.now() - last.timestamp > CACHED_PRICE_MAX_AGE_MS) {
          logger.warn("Cached price is stale", {
            mint,
            ageSeconds: Math.round((Date.now() - last.timestamp) / 1000),
            maxAgeSeconds: CACHED_PRICE_MAX_AGE_MS / 1000
          });
          return null;
        }
        return { ...last, source: "cached" };
      }
      return null;
    }

    // R2-S4: Historical deviation check — reject if >30% change from last known price
    const HISTORICAL_DEVIATION_MAX_BPS = 3000; // 30.00%
    const history = this.priceHistory.get(slabAddress);
    if (history && history.length > 0) {
      const lastPrice = history[history.length - 1].priceE6;
      if (lastPrice > 0n) {
        const deviationBps = priceE6 > lastPrice
          ? Number((priceE6 - lastPrice) * 10_000n / lastPrice)
          : Number((lastPrice - priceE6) * 10_000n / lastPrice);
        if (deviationBps > HISTORICAL_DEVIATION_MAX_BPS) {
          logger.warn("Price deviation exceeds threshold", {
            mint,
            deviationBps,
            thresholdBps: HISTORICAL_DEVIATION_MAX_BPS,
            lastPrice: lastPrice.toString(),
            newPrice: priceE6.toString(),
            source
          });
          return null;
        }
      }
    }

    const entry: PriceEntry = { priceE6, source, timestamp: Date.now() };
    this.recordPrice(slabAddress, entry);
    // M-4: Record that an external source produced a valid price. This resets the
    // fallback clock so the on-chain fallback cap counts from the last real fetch.
    this.lastExternalPriceMs.set(slabAddress, entry.timestamp);
    return entry;
  }

  private recordPrice(slabAddress: string, entry: PriceEntry): void {
    let history = this.priceHistory.get(slabAddress);
    if (!history) {
      history = [];
      this.priceHistory.set(slabAddress, history);
    }
    history.push(entry);
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
    // Evict least recently updated market if we exceed the global limit
    if (this.priceHistory.size > this.maxTrackedMarkets) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, hist] of this.priceHistory) {
        if (key === slabAddress) continue;
        const lastTs = hist.length > 0 ? hist[hist.length - 1].timestamp : 0;
        if (lastTs < oldestTime) {
          oldestTime = lastTs;
          oldestKey = key;
        }
      }
      if (oldestKey) this.priceHistory.delete(oldestKey);
    }
  }

  /** Get current price for a market */
  getCurrentPrice(slabAddress: string): PriceEntry | null {
    const history = this.priceHistory.get(slabAddress);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  /** Get price history for a market */
  getPriceHistory(slabAddress: string): PriceEntry[] {
    return this.priceHistory.get(slabAddress) ?? [];
  }

  /**
   * Returns slab addresses where the last successful price push
   * was more than `thresholdMs` ago (or never pushed).
   * Only considers markets that have at least one price history entry.
   */
  /**
   * Record a successful price push for a market. Called by CrankService when
   * a price push is bundled into a crank transaction (bypassing pushPrice()).
   * Without this, getStaleMarkets() would flag bundled-push markets as stale
   * because lastPushTime is never updated.
   */
  recordPushTime(slabAddress: string): void {
    this.lastPushTime.set(slabAddress, Date.now());
  }

  getStaleMarkets(thresholdMs: number): string[] {
    const now = Date.now();
    const stale: string[] = [];
    for (const [slabAddress] of this.priceHistory) {
      const lastPush = this.lastPushTime.get(slabAddress) ?? 0;
      if (lastPush === 0 || now - lastPush > thresholdMs) {
        stale.push(slabAddress);
      }
    }
    return stale;
  }
}
