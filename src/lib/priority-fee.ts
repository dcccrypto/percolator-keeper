import { createHash } from "node:crypto";
import { createLogger } from "@percolatorct/shared";
import { priorityFeeMicrolamports, priorityFeeEstimateTotal } from "./metrics.js";

const logger = createLogger("keeper:priority-fee");

export type PriorityFeeTier = "crank" | "liquidation" | "oracle" | "adl";

const FALLBACK_MICROLAMPORTS = 1_000;
const DEFAULT_CACHE_MS = 5_000;

/** Default percentiles per tier (overridable via env). ADL is liquidation-priority. */
const DEFAULT_PERCENTILES: Record<PriorityFeeTier, number> = {
  liquidation: 75,
  adl: 75,
  crank: 50,
  oracle: 25,
};

export interface PriorityFeeEstimator {
  estimate(accountKeys: string[], tier: PriorityFeeTier): Promise<number>;
}

interface HeliusResponse {
  result?: {
    priorityFeeLevels?: {
      min?: number;
      low?: number;
      medium?: number;
      high?: number;
      veryHigh?: number;
      unsafeMax?: number;
      [key: string]: number | undefined;
    };
    priorityFeeEstimate?: number;
  };
}

/** Stable hash of an account-key set for cache keying and metric labels. */
function hashKeys(keys: string[]): string {
  return [...keys].sort().join(",");
}

/**
 * Compact 16-char hex prefix of SHA-256 over sorted account base58 keys.
 * Used as the `accountSet_hash` metric label — short enough to avoid label
 * cardinality explosion while still distinguishing distinct account sets.
 */
function accountSetHash(keys: string[]): string {
  return createHash("sha256")
    .update([...keys].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

function resolvePercentile(tier: PriorityFeeTier): number {
  const envMap: Record<PriorityFeeTier, string> = {
    liquidation: "KEEPER_PRIORITY_FEE_PERCENTILE_LIQUIDATION",
    adl: "KEEPER_PRIORITY_FEE_PERCENTILE_ADL",
    crank: "KEEPER_PRIORITY_FEE_PERCENTILE_CRANK",
    oracle: "KEEPER_PRIORITY_FEE_PERCENTILE_ORACLE",
  };
  const raw = process.env[envMap[tier]];
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return DEFAULT_PERCENTILES[tier];
}

/** Map a numeric percentile to the Helius API priority level string. */
function percentileToLevel(p: number): string {
  if (p >= 95) return "veryHigh";
  if (p >= 75) return "high";
  if (p >= 50) return "medium";
  if (p >= 25) return "low";
  return "min";
}

export class HeliusPriorityFeeEstimator implements PriorityFeeEstimator {
  private readonly _rpcUrl: string;
  private readonly _cacheMs: number;
  private readonly _cache = new Map<string, { value: number; expiresAt: number }>();

  constructor(rpcUrl?: string, opts?: { cacheMs?: number }) {
    this._rpcUrl =
      rpcUrl ??
      process.env.HELIUS_RPC_URL ??
      process.env.SOLANA_RPC_URL ??
      process.env.RPC_URL ??
      "";
    this._cacheMs =
      opts?.cacheMs ??
      parseInt(process.env.KEEPER_PRIORITY_FEE_CACHE_MS ?? String(DEFAULT_CACHE_MS), 10);
  }

  async estimate(accountKeys: string[], tier: PriorityFeeTier): Promise<number> {
    priorityFeeEstimateTotal.inc({ tier });

    const cacheKey = `${tier}:${hashKeys(accountKeys)}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      if (cached.value > 0) {
        priorityFeeMicrolamports.set({ accountSet_hash: accountSetHash(accountKeys), tier }, cached.value);
      }
      return cached.value;
    }

    const percentile = resolvePercentile(tier);
    const level = percentileToLevel(percentile);

    try {
      const response = await fetch(this._rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getPriorityFeeEstimate",
          params: [
            {
              accountKeys,
              options: {
                includeAllPriorityFeeLevels: true,
                priorityLevel: level,
              },
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as HeliusResponse;
      const levels = data.result?.priorityFeeLevels;
      const fee =
        levels?.[level] ??
        data.result?.priorityFeeEstimate;

      if (typeof fee !== "number" || fee < 0) {
        throw new Error(`Unexpected fee value from Helius: ${JSON.stringify(fee)}`);
      }

      const value = Math.round(fee);
      this._cache.set(cacheKey, { value, expiresAt: Date.now() + this._cacheMs });
      // Only emit the gauge for non-trivial fees to avoid label noise from zero-fee routes.
      if (value > 0) {
        priorityFeeMicrolamports.set({ accountSet_hash: accountSetHash(accountKeys), tier }, value);
      }
      return value;
    } catch (err) {
      logger.warn("Priority fee estimation failed — using fallback", {
        tier,
        error: err instanceof Error ? err.message : String(err),
        fallback: FALLBACK_MICROLAMPORTS,
      });
      return FALLBACK_MICROLAMPORTS;
    }
  }
}
