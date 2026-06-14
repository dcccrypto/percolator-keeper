/**
 * ADL Service — OBSERVABILITY ONLY.
 *
 * Alignment with dcccrypto/percolator-prog `main` (verified against src/percolator.rs):
 *   `ExecuteAdl` (tag 50) is ADMIN-GATED on-chain. `handle_execute_adl`:
 *     - percolator.rs:14537  require_admin(header.admin, accounts[0])     → signer MUST be the market admin (else EngineUnauthorized 0xf)
 *     - percolator.rs:14590  if insurance_fund.balance != 0 → InsuranceFundNotDepleted (0x2f)
 *     - percolator.rs:14604  if max_pnl_cap > 0 && pnl_pos_tot <= cap → InvalidArgument
 *
 *   The keeper's crank key is an unprivileged operational hot wallet, NOT the market
 *   admin — so the keeper MUST NOT send ExecuteAdl (every send would revert), and we
 *   will NOT put an admin key on the keeper (admin also controls pause / withdraw-insurance
 *   / resolve — unacceptable blast radius on an always-online process).
 *
 *   Routine, protective deleveraging already happens PERMISSIONLESSLY inside
 *   `KeeperCrank` (tag 5 → permissionless_progress_not_atomic) and `LiquidateAtOracle`
 *   (tag 7), both already sent by the keeper. Targeted ExecuteAdl is an admin / multisig
 *   governance action and is intentionally NOT automated here.
 *
 * Responsibilities (read-only):
 *  1. Per-market: fetch slab, evaluate whether the on-chain ADL preconditions are met
 *     (insurance fully depleted AND profit above the PnL cap).
 *  2. Expose that state + a PnL%-ranked deleverage list via getAdlState()/getStats()
 *     for the /api/adl/rankings endpoint and the MonitorService alert.
 *  This service sends NO transactions. Feature-flagged via `ADL_ENABLED=true`.
 *
 * Dependency surface:
 *  - @percolatorct/sdk:  fetchSlab, parseEngine, parseConfig, parseAllAccounts
 *  - @percolatorct/shared: getConnection, createLogger, sendWarningAlert
 */

import {
  fetchSlab,
  parseEngine,
  parseConfig,
  parseAllAccounts,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { getConnection, createLogger, sendWarningAlert } from "@percolatorct/shared";
import type { MarketCrankState } from "./crank-types.js";

const logger = createLogger("keeper:adl");

// ─── tunables ──────────────────────────────────────────────────────────────

function parseIntEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < min) {
    throw new Error(
      `Invalid ${name}=${raw} — must be an integer >= ${min} (default: ${fallback})`,
    );
  }
  return parsed;
}

function parseBigIntEnv(name: string, fallback: string): bigint {
  const raw = process.env[name] ?? fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(
      `Invalid ${name}=${raw} — must be a valid integer string (default: ${fallback})`,
    );
  }
}

/**
 * How often to run the ADL observation loop in milliseconds.
 * Default 10 s.
 */
const ADL_INTERVAL_MS = parseIntEnv("ADL_INTERVAL_MS", 10_000, 1000);

/**
 * Insurance fund utilization BPS threshold — INFORMATIONAL ONLY.
 *
 * utilization_bps = (fee_revenue - balance) * 10_000 / max(fee_revenue, 1)
 *
 * The on-chain ADL gate is `balance == 0` (full depletion), NOT a utilization
 * ratio, so this is exposed for dashboards/early-warning but is NOT part of the
 * adlNeeded decision. Default 8000 BPS = 80%.
 */
const ADL_INSURANCE_UTIL_THRESHOLD_BPS = parseBigIntEnv(
  "ADL_INSURANCE_UTIL_THRESHOLD_BPS", "8000"
);

/**
 * Minimum gap between repeated "ADL conditions met" warning alerts per market.
 * Avoids alert spam while conditions persist (admin/multisig action is manual).
 */
const ADL_ALERT_COOLDOWN_MS = parseIntEnv("ADL_ALERT_COOLDOWN_MS", 30 * 60_000, 1000);

// ─── types ─────────────────────────────────────────────────────────────────

interface RankedPosition {
  idx: number;
  pnlPct: bigint;   // PnL as % of capital × 1_000_000 (fixed-point)
  pnlAbs: bigint;   // Absolute positive PnL (raw)
  capital: bigint;
}

/**
 * Result of the ADL trigger-check for a market.
 * Exposed on the /api/adl/rankings endpoint for observability.
 *
 * `adlNeeded` mirrors the program's ExecuteAdl preconditions: insurance fully
 * depleted (balance == 0) AND (cap disabled with profit to shed, or pnl > cap).
 */
export interface AdlTriggerState {
  slabAddress: string;
  pnlPosTot: string;
  maxPnlCap: string;
  insuranceFundBalance: string;
  insuranceFundFeeRevenue: string;
  insuranceUtilizationBps: number;
  capExceeded: boolean;
  /** True iff insurance_fund.balance == 0 (the program's hard ADL precondition). */
  insuranceDepleted: boolean;
  /** Informational only — utilization >= threshold. NOT part of adlNeeded. */
  utilizationTriggered: boolean;
  adlNeeded: boolean;
  rankings: Array<{
    rank: number;
    idx: number;
    pnlAbs: string;
    capital: string;
    pnlPctMillionths: string;
  }>;
}

interface AdlMarketState {
  lastScanTime: number;
  /** Whether the on-chain ADL preconditions were met at the last scan. */
  adlNeeded: boolean;
  /** Last time (ms) adlNeeded was observed true. */
  lastAdlNeededTime: number;
  /** Last time (ms) an "ADL conditions met" alert was emitted for this market. */
  lastAlertTime: number;
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Compute insurance fund utilization in BPS.
 *
 * utilization_bps = (fee_revenue - balance) * 10_000 / max(fee_revenue, 1)
 *
 * Clamped to [0, 10_000].  When fee_revenue == 0 (fresh market), returns 0.
 */
function computeInsuranceUtilizationBps(
  balance: bigint,
  feeRevenue: bigint
): bigint {
  if (feeRevenue === 0n) return 0n;
  const consumed = feeRevenue > balance ? feeRevenue - balance : 0n;
  const bps = (consumed * 10_000n) / feeRevenue;
  return bps > 10_000n ? 10_000n : bps;
}

/**
 * Evaluate the program's ExecuteAdl preconditions for a market.
 *
 * Mirrors handle_execute_adl (percolator.rs:14588-14612):
 *   adlNeeded ⇔ insurance_fund.balance == 0
 *               AND (max_pnl_cap == 0 ? pnl_pos_tot > 0 : pnl_pos_tot > max_pnl_cap)
 */
function checkAdlTrigger(
  pnlPosTot: bigint,
  maxPnlCap: bigint,
  insuranceFundBalance: bigint,
  insuranceFundFeeRevenue: bigint,
  slabAddress: string,
): Omit<AdlTriggerState, "rankings"> & { excess: bigint } {
  // Program gate (percolator.rs:14590): insurance must be FULLY depleted.
  const insuranceDepleted = insuranceFundBalance === 0n;
  // Program cap pre-check (percolator.rs:14604): with a cap set, pnl must exceed it.
  const capExceeded = maxPnlCap > 0n && pnlPosTot > maxPnlCap;

  const utilizationBps = computeInsuranceUtilizationBps(
    insuranceFundBalance,
    insuranceFundFeeRevenue
  );
  // Informational only — the program keys off balance == 0, not a ratio.
  const utilizationTriggered =
    ADL_INSURANCE_UTIL_THRESHOLD_BPS > 0n &&
    utilizationBps >= ADL_INSURANCE_UTIL_THRESHOLD_BPS;

  // ADL is admissible on-chain only when insurance is fully depleted AND either
  // the cap is disabled (any profit can be shed) or profit exceeds the cap.
  const adlNeeded =
    insuranceDepleted && (maxPnlCap === 0n ? pnlPosTot > 0n : capExceeded);

  const excess =
    maxPnlCap > 0n
      ? (pnlPosTot > maxPnlCap ? pnlPosTot - maxPnlCap : 0n)
      : pnlPosTot;

  return {
    slabAddress,
    pnlPosTot: pnlPosTot.toString(),
    maxPnlCap: maxPnlCap.toString(),
    insuranceFundBalance: insuranceFundBalance.toString(),
    insuranceFundFeeRevenue: insuranceFundFeeRevenue.toString(),
    insuranceUtilizationBps: Number(utilizationBps),
    capExceeded,
    insuranceDepleted,
    utilizationTriggered,
    adlNeeded,
    excess,
  };
}

/**
 * Rank all profitable positions by PnL% (descending) — the order an admin/multisig
 * would deleverage in. Read-only; exposed via getAdlState() for tooling.
 * Uses capital as denominator; positions with zero capital are excluded.
 */
function rankProfitablePositions(data: Uint8Array): RankedPosition[] {
  const allAccounts = parseAllAccounts(data);
  const profitable: RankedPosition[] = [];

  for (const { idx, account } of allAccounts) {
    if (account.positionSize === 0n) continue;
    if (account.pnl <= 0n) continue;

    const capital = account.capital > 0n ? account.capital : 1n; // guard div-by-zero
    const pnlAbs = account.pnl;
    // pnlPct = pnl * 1_000_000 / capital  (fixed-point, 6 decimal places)
    const pnlPct = (pnlAbs * 1_000_000n) / capital;

    profitable.push({ idx, pnlPct, pnlAbs, capital });
  }

  // Sort descending by PnL%: highest earner deleveraged first.
  // Tie-break by absolute PnL descending.
  profitable.sort((a, b) => {
    if (b.pnlPct !== a.pnlPct) return b.pnlPct > a.pnlPct ? 1 : -1;
    return b.pnlAbs > a.pnlAbs ? 1 : -1;
  });

  return profitable;
}

// ─── ADL service class (observe-only) ────────────────────────────────────────

export class AdlService {
  private markets = new Map<string, AdlMarketState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _getMarkets: (() => Map<string, MarketCrankState>) | null = null;
  private _isRunning = false;
  private _cycling = false;
  private _cycleStartedAt = 0;

  /** Inject the crank service's market map so ADL can iterate tracked markets. */
  setMarketSource(fn: () => Map<string, MarketCrankState>): void {
    this._getMarkets = fn;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Fetch on-chain state and return ADL trigger info + position rankings for a
   * single market. Read-only — sends nothing. Used by /api/adl/rankings.
   */
  async getAdlState(slabAddress: string, market: DiscoveredMarket): Promise<AdlTriggerState> {
    const connection = getConnection();

    let data: Uint8Array;
    try {
      data = await fetchSlab(connection, market.slabAddress);
    } catch (err) {
      throw new Error(`fetchSlab failed for ${slabAddress}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const engine = parseEngine(data);
    const cfg = parseConfig(data);

    const trigger = checkAdlTrigger(
      engine.pnlPosTot,
      cfg.maxPnlCap,
      engine.insuranceFund.balance,
      engine.insuranceFund.feeRevenue,
      slabAddress,
    );

    let rankings: AdlTriggerState["rankings"] = [];
    if (trigger.adlNeeded) {
      const ranked = rankProfitablePositions(data);
      rankings = ranked.map((r, i) => ({
        rank: i + 1,
        idx: r.idx,
        pnlAbs: r.pnlAbs.toString(),
        capital: r.capital.toString(),
        pnlPctMillionths: r.pnlPct.toString(),
      }));
    }

    // Drop the internal-only `excess` field from the public shape.
    const { excess: _excess, ...publicTrigger } = trigger;
    return { ...publicTrigger, rankings };
  }

  /**
   * Observe one market: evaluate the on-chain ADL preconditions and record state.
   * Sends NO transactions (ExecuteAdl is admin/multisig-gated — see file header).
   * Returns 1 if the market currently meets ADL preconditions, else 0.
   */
  async scanMarket(slabAddress: string, market: DiscoveredMarket): Promise<number> {
    const state = this._getOrCreateState(slabAddress);
    state.lastScanTime = Date.now();

    const connection = getConnection();

    let data: Uint8Array;
    try {
      data = await fetchSlab(connection, market.slabAddress);
    } catch (err) {
      logger.warn("ADL: fetchSlab failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const engine = parseEngine(data);
    const cfg = parseConfig(data);

    const trigger = checkAdlTrigger(
      engine.pnlPosTot,
      cfg.maxPnlCap,
      engine.insuranceFund.balance,
      engine.insuranceFund.feeRevenue,
      slabAddress,
    );

    state.adlNeeded = trigger.adlNeeded;

    if (!trigger.adlNeeded) {
      return 0;
    }

    state.lastAdlNeededTime = Date.now();
    logger.info("ADL conditions met (observe-only — ExecuteAdl is admin/multisig-gated)", {
      slabAddress,
      pnlPosTot: trigger.pnlPosTot,
      maxPnlCap: trigger.maxPnlCap,
      excess: trigger.excess.toString(),
      insuranceFundBalance: trigger.insuranceFundBalance,
      insuranceUtilizationBps: trigger.insuranceUtilizationBps,
    });

    // Rate-limited operator alert — the actual ExecuteAdl is a manual admin/multisig action.
    const now = Date.now();
    if (now - state.lastAlertTime > ADL_ALERT_COOLDOWN_MS) {
      state.lastAlertTime = now;
      sendWarningAlert("ADL conditions met — admin/multisig action required", [
        { name: "Market", value: slabAddress.slice(0, 16) + "...", inline: false },
        { name: "pnl_pos_tot", value: trigger.pnlPosTot, inline: true },
        { name: "max_pnl_cap", value: trigger.maxPnlCap, inline: true },
        { name: "insurance_balance", value: trigger.insuranceFundBalance, inline: true },
      ])?.catch(() => {});
    }

    return 1;
  }

  /** Observe all tracked markets for ADL conditions. */
  async scanAll(): Promise<{ scanned: number; needingAdl: number }> {
    if (!this._getMarkets) return { scanned: 0, needingAdl: 0 };

    const markets = this._getMarkets();
    let scanned = 0;
    let needingAdl = 0;

    for (const [slabAddress, crankState] of markets) {
      // Skip permanently-skipped markets
      if (crankState.permanentlySkipped) continue;
      if (crankState.foreignOracleSkipped) continue;

      try {
        const r = await this.scanMarket(slabAddress, crankState.market);
        scanned++;
        if (r > 0) needingAdl++;
      } catch (err) {
        logger.error("ADL scanMarket threw unexpectedly", {
          slabAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned, needingAdl };
  }

  start(getMarkets: () => Map<string, MarketCrankState>): void {
    if (this.timer) return;
    this._getMarkets = getMarkets;
    this._isRunning = true;

    logger.info("ADL service starting (observe-only)", { intervalMs: ADL_INTERVAL_MS });

    const MAX_CYCLE_MS = ADL_INTERVAL_MS * 5;

    this.timer = setInterval(async () => {
      if (this._cycling) {
        const elapsed = Date.now() - this._cycleStartedAt;
        if (elapsed > MAX_CYCLE_MS) {
          logger.error("ADL cycle watchdog: cycle exceeded max duration, force-resetting", {
            elapsedMs: elapsed,
            maxCycleMs: MAX_CYCLE_MS,
          });
          sendWarningAlert("ADL cycle hung — watchdog reset", [
            { name: "Elapsed", value: `${Math.round(elapsed / 1000)}s`, inline: true },
            { name: "Max", value: `${Math.round(MAX_CYCLE_MS / 1000)}s`, inline: true },
          ])?.catch(() => {});
          this._cycling = false;
        }
        return;
      }
      this._cycling = true;
      this._cycleStartedAt = Date.now();
      try {
        const result = await this.scanAll();
        if (result.needingAdl > 0) {
          logger.info("ADL observation complete", result);
        }
      } catch (err) {
        logger.error("ADL scan cycle error", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this._cycling = false;
      }
    }, ADL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._isRunning = false;
      logger.info("ADL service stopped");
    }
  }

  private _getOrCreateState(slabAddress: string): AdlMarketState {
    if (!this.markets.has(slabAddress)) {
      this.markets.set(slabAddress, {
        lastScanTime: 0,
        adlNeeded: false,
        lastAdlNeededTime: 0,
        lastAlertTime: 0,
      });
    }
    return this.markets.get(slabAddress)!;
  }

  getStats(): Map<string, AdlMarketState> {
    return this.markets;
  }
}
