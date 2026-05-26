/**
 * FraudDetectorService — periodic cross-validation of on-chain HYPERP mark price
 * versus off-chain DexScreener / Jupiter consensus.
 *
 * This service is PURELY OBSERVATIONAL. It never pauses cranks, halts sends, or
 * affects any other code path. A divergence above the threshold fires a Discord
 * warning via sendWarningAlert and increments Prometheus counters only.
 *
 * On-chain mark source: engine.markPriceE6 (parsed from slab data by
 * parseEngine). This field is updated on-chain by UpdateHyperpMark and
 * represents the EMA mark price in E6 format (i.e. USD * 1e6).
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
// engine.markPriceE6 is in USD * 1e6; OracleService.fetchPrice returns priceE6
// in the same units. No conversion required — just compare the raw bigint values
// after converting to Number for the floating-point division.
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
function getIntervalMs(): number {
  return parseInt(process.env.FRAUD_DETECT_INTERVAL_MS ?? "30000", 10);
}
function getDivergenceThresholdBps(): number {
  return parseInt(process.env.FRAUD_DETECT_DIVERGENCE_BPS ?? "500", 10);
}
function getPerMintCooldownMs(): number {
  return parseInt(process.env.FRAUD_DETECT_PER_MINT_COOLDOWN_MS ?? "1800000", 10);
}
function isEnabled(): boolean {
  return process.env.FRAUD_DETECT_ENABLED !== "false";
}

export class FraudDetectorService {
  private _timer: ReturnType<typeof setInterval> | null = null;
  /** Map<mint, timestamp-of-last-alert> for per-mint cooldown. */
  private readonly _lastAlertByMint = new Map<string, number>();

  constructor(
    private readonly _oracleService: OracleService,
    private readonly _getMarkets: () => Map<string, MarketCrankState>,
  ) {}

  start(): void {
    if (!isEnabled()) {
      logger.info("FraudDetectorService disabled via FRAUD_DETECT_ENABLED=false — no interval registered");
      return;
    }
    if (this._timer) return;

    const intervalMs = getIntervalMs();
    logger.info("FraudDetectorService starting", {
      intervalMs,
      divergenceThresholdBps: getDivergenceThresholdBps(),
      perMintCooldownMs: getPerMintCooldownMs(),
    });

    this._timer = setInterval(async () => {
      try {
        await this._runCheck();
      } catch (err) {
        logger.error("FraudDetectorService cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, intervalMs);

    // Do not block process exit on this observational loop.
    this._timer.unref();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.info("FraudDetectorService stopped");
    }
  }

  // Exposed for tests to invoke directly without waiting for the interval.
  async _runCheck(): Promise<void> {
    const markets = this._getMarkets();
    const thresholdBps = getDivergenceThresholdBps();
    const cooldownMs = getPerMintCooldownMs();
    const now = Date.now();

    for (const [slabAddress, state] of markets) {
      // Only HYPERP markets have engine.markPriceE6 set by UpdateHyperpMark.
      // Non-HYPERP markets use Pyth/Chainlink — no cross-validate needed here.
      // HYPERP detection: indexFeedId all-zeros AND oracleAuthority all-zeros.
      const feedBytes = state.market.config.indexFeedId.toBytes();
      const isZeroFeed = feedBytes.every((b: number) => b === 0);
      const isZeroAuthority = state.market.config.oracleAuthority.toBytes().every((b: number) => b === 0);
      if (!isZeroFeed || !isZeroAuthority) {
        // Not a true HYPERP market — no on-chain EMA to compare.
        continue;
      }

      // On-chain mark price: engine.markPriceE6 (E6 units, updated by UpdateHyperpMark).
      const onChainMarkE6 = state.market.engine.markPriceE6;
      if (onChainMarkE6 === undefined || onChainMarkE6 === 0n) {
        logger.debug("FraudDetector: on-chain markPriceE6 is zero — skipping market", {
          slabAddress: slabAddress.slice(0, 8),
        });
        continue;
      }

      // mint label: collateralMint from config (used as Prometheus label + Discord field).
      const mint = state.market.config.collateralMint.toBase58();

      // Off-chain consensus from OracleService (DexScreener + Jupiter median).
      // Use mainnetCA if set for devnet mirror markets.
      const priceMint = state.mainnetCA ?? mint;
      let offChainPriceE6: bigint;
      try {
        const entry = await this._oracleService.fetchPrice(priceMint, slabAddress);
        if (entry === null || entry.priceE6 === undefined || entry.priceE6 === 0n) {
          logger.debug("FraudDetector: off-chain price unavailable for market", {
            mint: mint.slice(0, 8),
            slabAddress: slabAddress.slice(0, 8),
          });
          fraudOffchainUnavailableTotal.inc({ mint });
          continue;
        }
        offChainPriceE6 = entry.priceE6;
      } catch (err) {
        logger.debug("FraudDetector: off-chain price fetch threw for market", {
          mint: mint.slice(0, 8),
          slabAddress: slabAddress.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
        fraudOffchainUnavailableTotal.inc({ mint });
        continue;
      }

      if (offChainPriceE6 === 0n) {
        logger.debug("FraudDetector: off-chain price is zero — skipping market (cannot divide)", {
          mint: mint.slice(0, 8),
        });
        fraudOffchainUnavailableTotal.inc({ mint });
        continue;
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

      // Alert: update cooldown timestamp, increment counter, fire Discord warning.
      this._lastAlertByMint.set(mint, now);
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
}
