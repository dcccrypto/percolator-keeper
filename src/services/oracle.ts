import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  type MarketConfig,
} from "@percolatorct/sdk";
import { eventBus, createLogger, getErrorMessage, sendWarningAlert, sendCriticalAlert } from "@percolatorct/shared";
import { isMainnet } from "../config/network.js";
import { oraclePushCountTotal, oracleStalenessSeconds } from "../lib/metrics.js";

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
  private _nonAuthorityLogged = new Set<string>();
  private readonly rateLimitMs = parseInt(process.env.ORACLE_RATE_LIMIT_MS ?? "5000", 10);
  private readonly maxHistory = 100;
  private readonly maxTrackedMarkets = 500;
  // BM2: Deduplicate concurrent requests for the same mint
  private inFlightRequests = new Map<string, Promise<bigint | null>>();
  // B6: per-mint single-source state. The previous shared counters meant that
  // any single-source fetch — even on a niche market — moved the same global
  // counter, so a misbehaving feed for one mint could mute or trigger alerts
  // for every other market.
  private _singleSourceState = new Map<
    string,
    { consecutive: number; alertSent: boolean }
  >();
  private static readonly SINGLE_SOURCE_ALERT_THRESHOLD = 10;
  // #336: bound the per-mint state maps. fetchPrice() is reachable per discovered
  // market, and permissionless market creation means an attacker can spray
  // distinct mints to grow these maps without limit. Cap them (mirrors the
  // priceHistory maxTrackedMarkets pattern) and evict the oldest-inserted entry
  // when full. Map insertion order is FIFO in JS, so the first key is the oldest.
  private static readonly MAX_TRACKED_MINT_STATE = 500;
  // M6: per-mint dual-null state. Both DexScreener and Jupiter can return null
  // simultaneously during an outage. Track consecutive observations and escalate
  // via sendCriticalAlert at threshold so ops sees the outage immediately rather
  // than waiting for the downstream stale-oracle cron.
  private _dualNullState = new Map<
    string,
    { consecutive: number; alertSent: boolean }
  >();
  private static readonly DUAL_NULL_ALERT_THRESHOLD = 5;
  // Track when an external source (DexScreener or Jupiter) last returned a valid
  // price for each slab. This is the single freshness signal read by
  // getStaleMarkets(): a prolonged external outage (only cached/on-chain fallback
  // prices, which never advance this clock) causes the market to age into
  // staleness rather than cranking on a frozen price forever.
  private lastExternalPriceMs = new Map<string, number>();
  // H1: Track consecutive deviation rejections per slab to avoid permanent anchor lock.
  // After DEVIATION_ACCEPT_AFTER consecutive rejections, accept the price as legitimate.
  private deviationRejections = new Map<string, number>();
  private static readonly DEVIATION_ACCEPT_AFTER = 5;

  /** Injectable clock — defaults to Date.now() in production; overridden in
   *  tests so price freshness / staleness is deterministic without faking the
   *  global Date around the async fetch path. */
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
          const pair = sortPairsByLiquidity(cached.data.pairs)?.[0];
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

      if (!res.ok) return null;
      
      const json = (await res.json()) as DexScreenerResponse;

      // M7: Validate BEFORE caching — don't cache bad responses that would
      // suppress fresh fetches for the full TTL window.
      const pair = sortPairsByLiquidity(json.pairs)?.[0];
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
   *
   * M5 (LOW, architectural): both DexScreener and Jupiter REST APIs return
   * prices with NO publisher signature and NO slot anchor — the keeper has
   * no cryptographic proof the price is real, only the TLS chain back to the
   * provider's CDN. The mitigations above (cross-source 10%, historical 30%,
   * min-liquidity $1000) catch single-source single-tick manipulation, but a
   * coordinated attack that controls BOTH sources (e.g. supply-chain
   * compromise of a shared CDN, or both endpoints under the same TLS root)
   * would slip through. The real fix is Pyth Pull (on-chain signed prices);
   * see the boot warn in this service's constructor. Until then, treat
   * `source: "dexscreener" | "jupiter"` returns as "best-effort price, not
   * provably the on-chain reality."
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

    // B6: per-mint single-source tracking. Each mint has independent counters
    // so a degraded feed for one market does not silence (or fire) alerts for
    // any other.
    const bothAvailable = dexPrice !== null && jupPrice !== null;
    const mintState = this._singleSourceState.get(mint) ?? {
      consecutive: 0,
      alertSent: false,
    };
    if (bothAvailable) {
      if (mintState.consecutive > 0) {
        logger.info("Cross-source validation restored", {
          mint,
          previousSingleSourceCount: mintState.consecutive,
        });
      }
      mintState.consecutive = 0;
      mintState.alertSent = false;
    } else if (dexPrice !== null || jupPrice !== null) {
      mintState.consecutive++;
      const degradedSource = dexPrice !== null ? "dexscreener" : "jupiter";
      const downSource = dexPrice !== null ? "jupiter" : "dexscreener";
      if (
        mintState.consecutive >= OracleService.SINGLE_SOURCE_ALERT_THRESHOLD &&
        !mintState.alertSent
      ) {
        mintState.alertSent = true;
        logger.warn("Cross-source validation degraded — operating on single source", {
          mint,
          consecutiveSingleSource: mintState.consecutive,
          activeSource: degradedSource,
          downSource,
        });
        sendWarningAlert("Oracle cross-validation degraded", [
          { name: "Mint", value: mint.slice(0, 12), inline: true },
          { name: "Active Source", value: degradedSource, inline: true },
          { name: "Down Source", value: downSource, inline: true },
          { name: "Consecutive", value: String(mintState.consecutive), inline: true },
        ])?.catch(() => {});
      }
    }
    // #336: bounded set — caps the per-mint state map so an attacker spraying
    // distinct mints can't grow it without limit.
    OracleService._setBounded(this._singleSourceState, mint, mintState, OracleService.MAX_TRACKED_MINT_STATE);

    // Select best available price (DexScreener preferred)
    let priceE6: bigint | null = dexPrice;
    let source = "dexscreener";
    if (priceE6 === null) {
      priceE6 = jupPrice;
      source = "jupiter";
    }

    if (priceE6 === null) {
      // M6: dual-source outage. Both DexScreener and Jupiter returned null.
      // Track consecutive observations so a sustained outage escalates to
      // sendCriticalAlert rather than degrading silently into the cached
      // path (or null) cycle after cycle.
      const dualState = this._dualNullState.get(mint) ?? {
        consecutive: 0,
        alertSent: false,
      };
      dualState.consecutive++;

      const history = this.priceHistory.get(slabAddress);
      const hasFreshCache =
        history !== undefined &&
        history.length > 0 &&
        this.now() - history[history.length - 1].timestamp <= CACHED_PRICE_MAX_AGE_MS;

      // Critical alert: dual-null AND we cannot fall back to a fresh cache.
      // The keeper has no usable price for this mint, period. Fire ONCE per
      // outage and rearm on any successful fetch in the success path below.
      if (
        !hasFreshCache &&
        dualState.consecutive >= OracleService.DUAL_NULL_ALERT_THRESHOLD &&
        !dualState.alertSent
      ) {
        dualState.alertSent = true;
        logger.error("Oracle dual-source outage: no usable price for mint", {
          mint,
          slabAddress,
          consecutive: dualState.consecutive,
          threshold: OracleService.DUAL_NULL_ALERT_THRESHOLD,
        });
        sendCriticalAlert("Oracle dual-source outage", [
          { name: "Mint", value: mint.slice(0, 12), inline: true },
          { name: "Slab", value: slabAddress.slice(0, 12), inline: true },
          { name: "Consecutive", value: String(dualState.consecutive), inline: true },
          { name: "Sources Down", value: "DexScreener + Jupiter", inline: false },
        ])?.catch(() => {});
      }
      // #336: bounded set — see _singleSourceState above.
      OracleService._setBounded(this._dualNullState, mint, dualState, OracleService.MAX_TRACKED_MINT_STATE);

      if (history && history.length > 0) {
        const last = history[history.length - 1];
        // Reject stale cached prices (>60s) to prevent bad liquidations
        if (this.now() - last.timestamp > CACHED_PRICE_MAX_AGE_MS) {
          logger.warn("Cached price is stale", {
            mint,
            ageSeconds: Math.round((this.now() - last.timestamp) / 1000),
            maxAgeSeconds: CACHED_PRICE_MAX_AGE_MS / 1000
          });
          return null;
        }
        return { ...last, source: "cached" };
      }
      return null;
    }

    // M6: at least one source succeeded — reset dual-null state for this mint.
    {
      const dualState = this._dualNullState.get(mint);
      if (dualState && (dualState.consecutive > 0 || dualState.alertSent)) {
        logger.info("Oracle dual-source outage recovered", {
          mint,
          previousConsecutive: dualState.consecutive,
        });
        dualState.consecutive = 0;
        dualState.alertSent = false;
        // #336: bounded set (no-op for size since this re-sets an existing key).
        OracleService._setBounded(this._dualNullState, mint, dualState, OracleService.MAX_TRACKED_MINT_STATE);
      }
    }

    // R2-S4: Historical deviation check — reject if >30% change from last known price
    // H1: After DEVIATION_ACCEPT_AFTER consecutive rejections for the same market,
    // accept the price as a legitimate move. Cross-validation (DexScreener + Jupiter
    // within 10%) already guards against bad data, so consecutive cross-validated
    // prices at the new level are almost certainly legitimate.
    const HISTORICAL_DEVIATION_MAX_BPS = 3000; // 30.00%
    const history = this.priceHistory.get(slabAddress);
    if (history && history.length > 0) {
      const lastPrice = history[history.length - 1].priceE6;
      if (lastPrice > 0n) {
        const deviationBps = priceE6 > lastPrice
          ? Number((priceE6 - lastPrice) * 10_000n / lastPrice)
          : Number((lastPrice - priceE6) * 10_000n / lastPrice);
        if (deviationBps > HISTORICAL_DEVIATION_MAX_BPS) {
          const consecutiveCount = (this.deviationRejections.get(slabAddress) ?? 0) + 1;
          this.deviationRejections.set(slabAddress, consecutiveCount);
          if (consecutiveCount < OracleService.DEVIATION_ACCEPT_AFTER) {
            logger.warn("Price deviation exceeds threshold", {
              mint,
              deviationBps,
              thresholdBps: HISTORICAL_DEVIATION_MAX_BPS,
              lastPrice: lastPrice.toString(),
              newPrice: priceE6.toString(),
              source,
              consecutiveRejections: consecutiveCount,
              acceptAfter: OracleService.DEVIATION_ACCEPT_AFTER,
            });
            return null;
          }
          logger.warn("Accepting deviated price after consecutive rejections (H1)", {
            mint,
            deviationBps,
            consecutiveRejections: consecutiveCount,
            lastPrice: lastPrice.toString(),
            newPrice: priceE6.toString(),
            source,
          });
        }
      }
    }
    // H1: Price accepted — reset consecutive rejection counter
    this.deviationRejections.delete(slabAddress);

    const entry: PriceEntry = { priceE6, source, timestamp: this.now() };
    this.recordPrice(slabAddress, entry);
    oraclePushCountTotal.inc({ mint, source });
    // Single freshness signal for getStaleMarkets(): record that an external
    // source produced a valid price now. Cached/fallback returns above bail out
    // before this line, so they never refresh the staleness clock.
    this.lastExternalPriceMs.set(slabAddress, entry.timestamp);
    return entry;
  }

  /**
   * Read-only price probe used by FraudDetectorService for cross-validation.
   *
   * Identical external fetch logic to fetchPrice() but does NOT update:
   *   - lastExternalPriceMs (the staleness clock read by getStaleMarkets)
   *   - priceHistory / deviationRejections
   *   - _singleSourceState / _dualNullState
   *
   * This ensures fraud-detector checks are purely observational: a successful
   * or failed probe cannot advance or break the authoritative freshness state
   * that drives stalePausedMarkets → crank gating.
   *
   * Callers MUST NOT use this for crank decisions — it has no history or
   * deviation-cap guard. Use fetchPrice() for anything that feeds into cranks.
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

  /**
   * #336: set a value into a per-mint state map, evicting the oldest-inserted
   * entry first when the map is at capacity. JS Map preserves insertion order,
   * so the first key returned by keys() is the oldest. Re-setting an existing
   * key does NOT change its position, so a hot mint won't be evicted while it's
   * being updated every cycle — only genuinely idle (oldest) mints are dropped.
   */
  private static _setBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    if (!map.has(key) && map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
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
      if (oldestKey) {
        this.priceHistory.delete(oldestKey);
        // Keep lastExternalPriceMs lifetime identical to priceHistory so the
        // freshness map can't leak entries for markets we no longer track.
        this.lastExternalPriceMs.delete(oldestKey);
      }
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
   * Returns slab addresses whose last successful EXTERNAL price fetch was more
   * than `thresholdMs` ago (or which have never had one). Freshness is sourced
   * exclusively from lastExternalPriceMs, set in fetchPrice() on — and only on —
   * a successful external fetch, so a market surviving on a cached/on-chain
   * fallback price never advances the clock and correctly ages into staleness.
   * This is the single source of truth; there is no separate push-time to drift.
   * Only considers markets that have at least one price history entry.
   */
  getStaleMarkets(thresholdMs: number): string[] {
    const now = this.now();
    const stale: string[] = [];
    for (const [slabAddress] of this.priceHistory) {
      const lastFresh = this.lastExternalPriceMs.get(slabAddress) ?? 0;
      const stalenessMs = lastFresh === 0 ? Infinity : now - lastFresh;
      if (stalenessMs > thresholdMs) {
        stale.push(slabAddress);
      }
      if (isFinite(stalenessMs)) {
        oracleStalenessSeconds.set({ mint: slabAddress }, stalenessMs / 1000);
      }
    }
    return stale;
  }
}
