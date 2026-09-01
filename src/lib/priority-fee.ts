import { createHash } from "node:crypto";
import { createLogger } from "@percolatorct/shared";
import { priorityFeeMicrolamports, priorityFeeEstimateTotal } from "./metrics.js";

const logger = createLogger("keeper:priority-fee");

export type PriorityFeeTier = "crank" | "liquidation" | "oracle" | "adl";

/**
 * Per-tier fallback bids, used when the fee RPC is unreachable or malformed.
 *
 * The success path resolves a per-tier percentile (`DEFAULT_PERCENTILES` ->
 * `percentileToLevel`: p75 -> `high`, p50 -> `medium`, p25 -> `low`), so a
 * single flat fallback silently cancels the tier system at exactly the moment
 * it matters — a degraded fee RPC during congestion, when a liquidation would
 * otherwise be bidding p75.
 *
 * Two rules fix these numbers:
 *
 *  1. NO LANE REGRESSES. Every tier is floored at the historical flat 1_000.
 *     `oracle` is p25 on the success path, but `budget.ts` counts it a
 *     CRITICAL_LANE alongside liquidation and adl, so giving it the lowest bid
 *     in the fleet on the degraded path would be strictly worse than the flat
 *     constant it replaces. It therefore stays at 1_000 rather than dropping,
 *     and coincides with `crank` by design.
 *  2. THE URGENT LANES RISE. liquidation/adl bid 5x the base, restoring the
 *     differentiation the success path guarantees.
 *
 * The magnitudes are a judgment call, not an API constant — Helius computes
 * `priorityFeeLevels` dynamically per account-key set, so there is no fixed
 * ladder to mirror. Only the ORDERING is derived from the percentile mapping.
 *
 * On overspend: `keeper-send` couples the broadcast fee to the value
 * `budget.canSpend` gated on (#396). Note that the budget caps LATCH a
 * manual-resume, keeper-wide halt (`budget.ts` `_halt("cycle-spend-cap")`)
 * rather than refusing a single send — so the relevant safety property here is
 * that these values stay far below the cycle cap, not that the gate is
 * forgiving. At the 1.4M-CU ceiling, 5_000 uL costs ~12_000 lamports against a
 * 50_000_000 default cycle cap. See #350 for the cap's own hazard.
 */
const DEFAULT_FALLBACK_MICROLAMPORTS: Record<PriorityFeeTier, number> = {
  liquidation: 5_000,
  adl: 5_000,
  crank: 1_000,
  oracle: 1_000,
};

/**
 * Hard ceiling on an operator-supplied fallback override.
 *
 * Without a max, `parseBoundedIntEnv` admits anything up to
 * `Number.MAX_SAFE_INTEGER`, and a fat-fingered value would sit dormant until
 * the fee RPC degraded and then trip the LATCHING cycle-spend halt — bricking
 * every lane, not just the one send. 1_000_000 uL is ~1.4M lamports at the
 * 1.4M-CU ceiling: generous headroom for real congestion, ~35x below the
 * 50_000_000 default cycle cap.
 */
export const PRIORITY_FEE_FALLBACK_MAX = 1_000_000;

/** Floor: the historical flat fallback. No lane may bid below it. */
export const PRIORITY_FEE_FALLBACK_MIN = 1_000;
const DEFAULT_CACHE_MS = 5_000;
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;
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

/**
 * Fallback bid for `tier`, overridable per tier via
 * `KEEPER_PRIORITY_FEE_FALLBACK_{LIQUIDATION,ADL,CRANK,ORACLE}`.
 */
function resolveFallback(tier: PriorityFeeTier): number {
  const envMap: Record<PriorityFeeTier, string> = {
    liquidation: "KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION",
    adl: "KEEPER_PRIORITY_FEE_FALLBACK_ADL",
    crank: "KEEPER_PRIORITY_FEE_FALLBACK_CRANK",
    oracle: "KEEPER_PRIORITY_FEE_FALLBACK_ORACLE",
  };
  // Floored at the historical flat fallback rather than at 1: `keeper-send`
  // forwards the bid with `??`, which does not coalesce 0, so a zero override
  // would reach `setComputeUnitPrice` and silently disable priority fees on
  // the urgent lanes during an outage — passing the budget gate cleanly, with
  // no metric and only one log line. Any value below the old flat constant is
  // a regression on that lane, so the floor rejects the whole range, not just 0.
  return parseBoundedIntEnv(
    envMap[tier],
    DEFAULT_FALLBACK_MICROLAMPORTS[tier],
    PRIORITY_FEE_FALLBACK_MIN,
    PRIORITY_FEE_FALLBACK_MAX,
  );
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
  private readonly _cacheMaxEntries: number;
  private readonly _cache = new Map<string, { value: number; expiresAt: number }>();

  constructor(rpcUrl?: string, opts?: { cacheMs?: number; cacheMaxEntries?: number }) {
    this._rpcUrl =
      rpcUrl ??
      process.env.HELIUS_RPC_URL ??
      process.env.SOLANA_RPC_URL ??
      process.env.RPC_URL ??
      "";
    this._cacheMs =
      opts?.cacheMs ??
      parseBoundedIntEnv("KEEPER_PRIORITY_FEE_CACHE_MS", DEFAULT_CACHE_MS, 0);
    this._cacheMaxEntries =
      opts?.cacheMaxEntries ??
      parseBoundedIntEnv(
        "KEEPER_PRIORITY_FEE_CACHE_MAX_ENTRIES",
        DEFAULT_CACHE_MAX_ENTRIES,
        1,
      );
  }

  /**
   * The cache key is derived from the full account-key set, which varies
   * per market/instruction shape and grows without bound over the life of
   * a long-running keeper as markets are added/removed and discovery
   * cycles touch new account combinations. Without this, entries for
   * stale/never-repeated key sets would accumulate in `_cache` forever
   * (Map.set never overwrites a *different* key, and nothing else ever
   * deletes from it).
   */
  private _evictStaleEntries(now: number): void {
    for (const [key, entry] of this._cache) {
      if (now >= entry.expiresAt) {
        this._cache.delete(key);
      }
    }
    while (this._cache.size >= this._cacheMaxEntries) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey === undefined) break;
      this._cache.delete(oldestKey);
    }
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
      const now = Date.now();
      this._evictStaleEntries(now);
      this._cache.set(cacheKey, { value, expiresAt: now + this._cacheMs });
      // Only emit the gauge for non-trivial fees to avoid label noise from zero-fee routes.
      if (value > 0) {
        priorityFeeMicrolamports.set({ accountSet_hash: accountSetHash(accountKeys), tier }, value);
      }
      return value;
    } catch (err) {
      const fallback = resolveFallback(tier);
      logger.warn("Priority fee estimation failed — using fallback", {
        tier,
        error: err instanceof Error ? err.message : String(err),
        fallback,
      });
      return fallback;
    }
  }
}
