/**
 * FraudDetectorService — periodic cross-validation of on-chain HYPERP mark price
 * versus off-chain DexScreener / Jupiter consensus.
 *
 * This service is PURELY OBSERVATIONAL. It never pauses cranks, halts sends, or
 * affects any other code path. A divergence above the threshold fires a Discord
 * warning via sendWarningAlert and increments Prometheus counters only.
 *
 * On-chain mark source: MarketConfig.hyperp_mark_e6, surfaced by the SDK as
 * config.authorityPriceE6 (config offset 176), written on-chain by
 * UpdateHyperpMark and represented in E6 format (i.e. USD * 1e6). The engine
 * mark field (engine.markPriceE6) was dropped in v12.17 and parses as 0.
 *
 * Off-chain consensus: OracleService.fetchPrice(mint, slabAddress), which
 * returns the DexScreener / Jupiter median as priceE6 (also E6 format).
 * Both values are therefore directly comparable after Number() conversion.
 *
 * Divergence formula (per brief): |onchain - offchain| / offchain * 10_000
 * This is slightly asymmetric (result depends on which is the denominator).
 * Using offchain as the denominator is intentional — we are assessing how far
 * the on-chain mark has drifted from the market's view. See divergenceBps().
 */

import { createLogger, sendWarningAlert } from "@percolatorct/shared";
import type { OracleService } from "./oracle.js";
import type { MarketCrankState } from "./crank-types.js";
import {
  fraudDivergenceBps,
  fraudAlertTotal,
  fraudOffchainUnavailableTotal,
} from "../lib/metrics.js";

const logger = createLogger("keeper:fraud-detector");

// Price scale used by both on-chain and off-chain price representations.
// config.authorityPriceE6 (the on-chain HYPERP mark) is in USD * 1e6;
// OracleService.fetchPrice returns priceE6 in the same units. No conversion
// required — just compare the raw bigint values after Number() for the division.
const PRICE_E6_SCALE = 1_000_000;

/**
 * Compute divergence in basis points between two E6-scaled prices.
 *
 * Returns |onchain - offchain| / |offchain| * 10_000.
 * The formula uses offchain as denominator (per brief), which means the result
 * is asymmetric: divergenceBps(A, B) != divergenceBps(B, A) in general.
 * callers must supply values in (onchain, offchain) order to get a meaningful
 * "how far has the chain drifted from the market" reading.
 *
 * Edge cases:
 *   offchain == 0 → return 0 (caller must check and skip the market).
 *   Result is always >= 0 (Math.abs on the numerator).
 */
export function divergenceBps(onchain: bigint | number, offchain: bigint | number): number {
  const b = Number(offchain);
  if (b === 0) return 0; // caller must treat 0 as "skip — cannot divide"
  const a = Number(onchain);
  return Math.round(Math.abs(a - b) / Math.abs(b) * 10_000);
}

// Config
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_DIVERGENCE_THRESHOLD_BPS = 500;
const DEFAULT_PER_MINT_COOLDOWN_MS = 1_800_000;
// #336: per-cycle market cap. The cycle iterated EVERY discovered market and
// awaited up to 2 external HTTP calls per market — permissionless market
// creation lets an attacker make a single cycle unbounded (and, with no
// in-flight guard, overlap cycles). Cap markets visited per cycle and walk a
// round-robin cursor so all admitted markets are covered over time.
const DEFAULT_MAX_MARKETS_PER_CYCLE = 200;
// #336: negative-cache TTL for unavailable/invalid off-chain prices, so a dead
// attacker mint isn't re-fetched (2 HTTP calls) every single cycle.
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 300_000; // 5 min
// #336: max alerts emitted per cycle (global budget on top of per-mint cooldown),
// so a correlated divergence across many attacker mints can't flood the channel
// in one cycle.
const DEFAULT_MAX_ALERTS_PER_CYCLE = 20;
// #336: cap on the per-mint cooldown map so it can't grow without bound.
const MAX_TRACKED_ALERT_MINTS = 1_000;

function parseBoundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

function getIntervalMs(): number {
  return parseBoundedIntEnv("FRAUD_DETECT_INTERVAL_MS", DEFAULT_INTERVAL_MS, 1_000);
}

function getDivergenceThresholdBps(): number {
  return parseBoundedIntEnv(
    "FRAUD_DETECT_DIVERGENCE_BPS",
    DEFAULT_DIVERGENCE_THRESHOLD_BPS,
    0,
  );
}

function getPerMintCooldownMs(): number {
  return parseBoundedIntEnv(
    "FRAUD_DETECT_PER_MINT_COOLDOWN_MS",
    DEFAULT_PER_MINT_COOLDOWN_MS,
    0,
  );
}

function getMaxMarketsPerCycle(): number {
  return parseBoundedIntEnv("FRAUD_DETECT_MAX_MARKETS_PER_CYCLE", DEFAULT_MAX_MARKETS_PER_CYCLE, 1);
}

function getNegativeCacheTtlMs(): number {
  return parseBoundedIntEnv("FRAUD_DETECT_NEGATIVE_CACHE_TTL_MS", DEFAULT_NEGATIVE_CACHE_TTL_MS, 0);
}

function getMaxAlertsPerCycle(): number {
  return parseBoundedIntEnv("FRAUD_DETECT_MAX_ALERTS_PER_CYCLE", DEFAULT_MAX_ALERTS_PER_CYCLE, 0);
}

function isEnabled(): boolean {
  return process.env.FRAUD_DETECT_ENABLED !== "false";
}

export class FraudDetectorService {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;
  // #336: single-flight guard. The cycle awaits external HTTP per market, so a
  // slow cycle could overlap the next tick under the old setInterval. We now
  // schedule the next cycle with setTimeout AFTER the previous one settles, and
  // this flag rejects any re-entrant _runCheck() (e.g. a test or manual call
  // landing while a cycle is mid-flight).
  private _inFlight = false;
  /** Map<mint, timestamp-of-last-alert> for per-mint cooldown. Bounded (#336). */
  private readonly _lastAlertByMint = new Map<string, number>();
  // #336: round-robin cursor into the discovered-market list so the per-cycle
  // market cap still covers every admitted market over successive cycles.
  private _marketCursor = 0;
  // #336: negative cache for mints whose off-chain price was unavailable/invalid,
  // so dead attacker mints aren't re-fetched (2 HTTP calls) every cycle.
  // Map<priceMint, expiry-timestamp-ms>. Bounded by the per-cycle market cap and
  // pruned on expiry.
  private readonly _negativePriceCache = new Map<string, number>();

  constructor(
    private readonly _oracleService: OracleService,
    private readonly _getMarkets: () => Map<string, MarketCrankState>,
  ) {}

  start(): void {
    if (!isEnabled()) {
      logger.info("FraudDetectorService disabled via FRAUD_DETECT_ENABLED=false — no interval registered");
      return;
    }
    if (this._timer || this._stopped) return;

    const intervalMs = getIntervalMs();
    logger.info("FraudDetectorService starting", {
      intervalMs,
      divergenceThresholdBps: getDivergenceThresholdBps(),
      perMintCooldownMs: getPerMintCooldownMs(),
      maxMarketsPerCycle: getMaxMarketsPerCycle(),
      maxAlertsPerCycle: getMaxAlertsPerCycle(),
    });

    // #336: recursive setTimeout — the next cycle is scheduled only AFTER the
    // current one settles, so cycles can NEVER overlap regardless of how long
    // the external HTTP fan-out takes. The single-flight _inFlight flag is a
    // defense-in-depth backstop for any direct _runCheck() invocation.
    const scheduleNext = (): void => {
      if (this._stopped) return;
      this._timer = setTimeout(async () => {
        try {
          await this._runCheck();
        } catch (err) {
          logger.error("FraudDetectorService cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          scheduleNext();
        }
      }, getIntervalMs());
      // Do not block process exit on this observational loop.
      this._timer.unref();
    };
    scheduleNext();
  }

  stop(): void {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      logger.info("FraudDetectorService stopped");
    }
  }

  // Exposed for tests to invoke directly without waiting for the interval.
  async _runCheck(): Promise<void> {
    // #336: single-flight — never run two cycles concurrently. The recursive
    // setTimeout already serializes the scheduled path; this also covers any
    // direct/manual _runCheck() that lands mid-cycle.
    if (this._inFlight) {
      logger.debug("FraudDetector: a cycle is already in flight — skipping this tick");
      return;
    }
    this._inFlight = true;
    try {
      await this._runCheckInner();
    } finally {
      this._inFlight = false;
    }
  }

  private async _runCheckInner(): Promise<void> {
    const markets = this._getMarkets();
    const thresholdBps = getDivergenceThresholdBps();
    const cooldownMs = getPerMintCooldownMs();
    const maxMarketsPerCycle = getMaxMarketsPerCycle();
    const negativeTtlMs = getNegativeCacheTtlMs();
    const maxAlertsPerCycle = getMaxAlertsPerCycle();
    const now = Date.now();

    // #336: prune expired negative-cache entries so the map can't grow unbounded.
    for (const [k, expiry] of this._negativePriceCache) {
      if (expiry <= now) this._negativePriceCache.delete(k);
    }

    // #336: select at most maxMarketsPerCycle markets, advancing a round-robin
    // cursor so the cap still covers every admitted market over successive
    // cycles. An attacker who creates thousands of markets can no longer make a
    // single cycle iterate (and HTTP-fan-out over) all of them.
    const entries = Array.from(markets.entries());
    const totalMarkets = entries.length;
    let selected: Array<[string, MarketCrankState]>;
    if (totalMarkets <= maxMarketsPerCycle) {
      selected = entries;
      this._marketCursor = 0;
    } else {
      const start = ((this._marketCursor % totalMarkets) + totalMarkets) % totalMarkets;
      selected = [];
      for (let k = 0; k < maxMarketsPerCycle; k++) {
        selected.push(entries[(start + k) % totalMarkets]!);
      }
      this._marketCursor = (start + maxMarketsPerCycle) % totalMarkets;
      logger.debug("FraudDetector: per-cycle market cap reached — remaining markets deferred to later cycles", {
        totalMarkets,
        processedThisCycle: maxMarketsPerCycle,
        cursorNext: this._marketCursor,
      });
    }

    // #336: dedupe off-chain price fetches by priceMint WITHIN this cycle, so N
    // markets sharing one mint cost one fetch (2 HTTP calls), not 2N. Maps
    // priceMint → resolved off-chain price (or null when unavailable/invalid).
    const cyclefetched = new Map<string, bigint | null>();
    let alertsThisCycle = 0;

    for (const [slabAddress, state] of selected) {
      // #336: skip inactive markets — no point spending HTTP calls validating a
      // market the keeper isn't cranking.
      if (!state.isActive) {
        continue;
      }

      // HYPERP / external-authority oracle detection.
      //
      // v12 markets: a zero index_feed_id IS the HYPERP signal (the program's
      // oracle::is_hyperp_mode gates on this). Non-zero means an external Pyth/
      // Chainlink feed — nothing for the fraud detector to cross-validate.
      //
      // v17 markets: wrapperConfigV17ToMarketConfig() maps ALL of MANUAL(0),
      // EWMA_MARK(2), and AUTH_MARK(3) to indexFeedId=PublicKey.default (zero) as
      // a bridge artifact — so the zero-feed test alone would falsely enroll these
      // modes. We must consult _rawV17Config.oracleMode directly:
      //   MANUAL(0)             — no external mark; skip.
      //   HYBRID_AFTER_HOURS(1) — uses Pyth leg feeds; indexFeedId is non-zero, so
      //                           the non-zero skip above already handles it.
      //   EWMA_MARK(2)          — keeper-authority EWMA; no external mark; skip.
      //   AUTH_MARK(3)          — admin pushes authorityPriceE6 on-chain; this IS
      //                           the mode the fraud detector was designed to guard.
      //                           Enroll: cross-validate authorityPriceE6 vs DEX.
      //
      // For v17 AUTH_MARK(3) and all v12 zero-feed markets, fall through to the
      // off-chain cross-validation below.
      const rawV17Cfg = (state.market as { _rawV17Config?: { oracleMode?: number } })._rawV17Config;
      if (rawV17Cfg !== undefined) {
        // v17 market — gate on explicit oracle mode.
        const oracleMode = rawV17Cfg.oracleMode ?? -1;
        // Only AUTH_MARK(3) has an on-chain authority price worth cross-validating.
        // MANUAL(0) and EWMA_MARK(2) produce a zero indexFeedId as a bridge artifact
        // but have no external mark for us to compare against.
        if (oracleMode !== 3) {
          continue;
        }
        // AUTH_MARK: fall through — authorityPriceE6 is set on-chain, cross-validate below.
      } else {
        // v12 market — use the legacy zero-feed heuristic.
        const feedBytes = state.market.config.indexFeedId.toBytes();
        const isZeroFeed = feedBytes.every((b: number) => b === 0);
        if (!isZeroFeed) {
          continue;
        }
      }

      // On-chain HYPERP mark (E6). v12.17+ dropped the engine mark field
      // (parseEngine returns 0n), so the live mark is MarketConfig.hyperp_mark_e6,
      // which the SDK surfaces as config.authorityPriceE6 (config offset 176) and
      // UpdateHyperpMark writes.
      const onChainMarkE6 = state.market.config.authorityPriceE6;
      if (onChainMarkE6 === undefined || onChainMarkE6 === 0n) {
        logger.debug("FraudDetector: on-chain HYPERP mark is zero — skipping market", {
          slabAddress: slabAddress.slice(0, 8),
        });
        continue;
      }

      // mint label: collateralMint from config (used as Prometheus label + Discord field).
      const mint = state.market.config.collateralMint.toBase58();

      // Off-chain consensus from OracleService (DexScreener + Jupiter median).
      // Use mainnetCA if set for devnet mirror markets.
      const priceMint = state.mainnetCA ?? mint;

      // #336: negative cache — skip mints whose off-chain price was recently
      // unavailable/invalid so dead attacker mints don't cost 2 HTTP calls every
      // cycle.
      const negExpiry = this._negativePriceCache.get(priceMint);
      if (negExpiry !== undefined && negExpiry > now) {
        logger.debug("FraudDetector: priceMint in negative cache — skipping fetch", {
          mint: mint.slice(0, 8),
        });
        fraudOffchainUnavailableTotal.inc({ mint });
        continue;
      }

      // #336: dedupe fetch by priceMint within this cycle.
      let offChainPriceE6: bigint;
      if (cyclefetched.has(priceMint)) {
        const cached = cyclefetched.get(priceMint)!;
        if (cached === null) {
          // Already known unavailable this cycle — no re-fetch, no re-log.
          fraudOffchainUnavailableTotal.inc({ mint });
          continue;
        }
        offChainPriceE6 = cached;
      } else {
        let resolved: bigint | null = null;
        try {
          const entry = await this._oracleService.peekPrice(priceMint);
          if (entry === null || entry.priceE6 === undefined || entry.priceE6 === 0n) {
            logger.debug("FraudDetector: off-chain price unavailable for market", {
              mint: mint.slice(0, 8),
              slabAddress: slabAddress.slice(0, 8),
            });
            resolved = null;
          } else {
            resolved = entry.priceE6;
          }
        } catch (err) {
          logger.debug("FraudDetector: off-chain price fetch threw for market", {
            mint: mint.slice(0, 8),
            slabAddress: slabAddress.slice(0, 8),
            error: err instanceof Error ? err.message : String(err),
          });
          resolved = null;
        }
        cyclefetched.set(priceMint, resolved);
        if (resolved === null) {
          // #336: cache the negative result with a bounded TTL.
          if (negativeTtlMs > 0) this._negativePriceCache.set(priceMint, now + negativeTtlMs);
          fraudOffchainUnavailableTotal.inc({ mint });
          continue;
        }
        offChainPriceE6 = resolved;
      }

      const bps = divergenceBps(onChainMarkE6, offChainPriceE6);

      // Update Prometheus gauge (always, regardless of threshold).
      fraudDivergenceBps.set({ mint }, bps);

      if (bps <= thresholdBps) {
        logger.debug("FraudDetector: divergence within threshold", {
          mint: mint.slice(0, 8),
          divergenceBps: bps,
          thresholdBps,
          onChainMarkE6: onChainMarkE6.toString(),
          offChainPriceE6: offChainPriceE6.toString(),
        });
        continue;
      }

      // Divergence exceeds threshold — apply per-mint cooldown before alerting.
      const lastAlert = this._lastAlertByMint.get(mint) ?? 0;
      if (now - lastAlert < cooldownMs) {
        logger.debug("FraudDetector: divergence high but in cooldown window — suppressing alert", {
          mint: mint.slice(0, 8),
          divergenceBps: bps,
          cooldownRemainingMs: cooldownMs - (now - lastAlert),
        });
        continue;
      }

      // #336: global per-cycle alert budget on top of the per-mint cooldown. A
      // correlated divergence across many (attacker) mints can't flood the
      // channel in a single cycle. Logged once so a sustained breach is visible.
      if (alertsThisCycle >= maxAlertsPerCycle) {
        logger.warn("FraudDetector: per-cycle alert budget exhausted — suppressing further alerts this cycle", {
          maxAlertsPerCycle,
        });
        break;
      }

      // Alert: update cooldown timestamp, increment counter, fire Discord warning.
      // #336: bounded cooldown map so it can't grow without limit.
      this._setLastAlert(mint, now);
      alertsThisCycle++;
      fraudAlertTotal.inc({ mint });

      const onChainUsd = (Number(onChainMarkE6) / PRICE_E6_SCALE).toFixed(6);
      const offChainUsd = (Number(offChainPriceE6) / PRICE_E6_SCALE).toFixed(6);

      logger.warn("FraudDetector: on-chain/off-chain price divergence ALERT", {
        mint: mint.slice(0, 8),
        divergenceBps: bps,
        thresholdBps,
        onChainMarkUsd: onChainUsd,
        offChainConsensusUsd: offChainUsd,
        slabAddress: slabAddress.slice(0, 8),
      });

      sendWarningAlert("HYPERP price divergence detected", [
        { name: "Mint", value: mint.slice(0, 16) + "...", inline: true },
        { name: "On-chain mark", value: `$${onChainUsd}`, inline: true },
        { name: "Off-chain consensus", value: `$${offChainUsd}`, inline: true },
        { name: "Divergence", value: `${bps} bps (${(bps / 100).toFixed(2)}%)`, inline: true },
        { name: "Threshold", value: `${thresholdBps} bps`, inline: true },
        { name: "Market", value: slabAddress.slice(0, 16) + "...", inline: false },
      ])?.catch(() => {});
    }
  }

  /**
   * #336: set the per-mint last-alert timestamp, evicting the oldest-inserted
   * entry first when the map is at capacity (FIFO; JS Map preserves insertion
   * order). Re-setting an existing mint keeps its position, so a repeatedly-
   * alerting mint won't evict itself.
   */
  private _setLastAlert(mint: string, ts: number): void {
    if (!this._lastAlertByMint.has(mint) && this._lastAlertByMint.size >= MAX_TRACKED_ALERT_MINTS) {
      const oldest = this._lastAlertByMint.keys().next().value;
      if (oldest !== undefined) this._lastAlertByMint.delete(oldest);
    }
    this._lastAlertByMint.set(mint, ts);
  }
}
