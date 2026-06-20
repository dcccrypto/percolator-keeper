/**
 * MonitorService — periodic invariant and staleness checks.
 *
 * 6.1  Conservation invariant: vault token balance >= engine.vault
 *       (engine.vault = c_tot + insurance_fund + net LP + unrealised PnL accounting)
 *       If the on-chain SPL token balance falls below what the program thinks is
 *       in the vault, funds have leaked and we need a critical alert immediately.
 *
 * 6.3  ADL staleness: if ADL is needed (pnl_pos_tot > max_pnl_cap OR utilization
 *       trigger) but no ADL tx has been sent in the last N crank cycles, fire a
 *       warning so ops can investigate whether the ADL service is stuck.
 *
 * Results are exposed via getStatus() for inclusion in the health endpoint.
 */

import { PublicKey } from "@solana/web3.js";
import {
  fetchSlab,
  isV17Account,
  parseEngine,
  parseConfig,
} from "@percolatorct/sdk";
import {
  getConnection,
  createLogger,
  sendCriticalAlert,
  sendWarningAlert,
} from "@percolatorct/shared";
import { cycleDurationSeconds } from "../lib/metrics.js";
import type { MarketCrankState } from "./crank-types.js";

const logger = createLogger("keeper:monitor");

/** B12: Per-RPC-call timeout so one slow node can't stall the whole monitor cycle. */
const MONITOR_RPC_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// How often to run the conservation invariant check (default 5 minutes)
const INVARIANT_CHECK_INTERVAL_MS = Number(process.env.INVARIANT_CHECK_INTERVAL_MS ?? 5 * 60_000);

// How many consecutive crank cycles without an ADL tx before we warn
// (default 20 — at 30s per crank cycle, 20 cycles ≈ 10 minutes)
const ADL_STALENESS_CYCLE_THRESHOLD = Number(process.env.ADL_STALENESS_CYCLE_THRESHOLD ?? 20);

// Rate-limit alerts to at most once per 5 minutes per market
const ALERT_COOLDOWN_MS = 5 * 60_000;

export interface MarketInvariantResult {
  slabAddress: string;
  ok: boolean;
  /** Actual SPL token balance in the vault token account */
  vaultTokenBalance: string;
  /** engine.vault — what the program believes is in the vault */
  engineVault: string;
  /** Shortfall: engineVault - vaultTokenBalance (0n when ok) */
  shortfall: string;
  checkedAt: number;
  skippedReason?: string;
}

export interface AdlStalenessResult {
  slabAddress: string;
  adlNeeded: boolean;
  cycleSinceLastAdl: number;
  stale: boolean;
  checkedAt: number;
  skippedReason?: string;
}

interface PerMarketState {
  lastInvariantAlert: number;
  lastAdlStalenessAlert: number;
  /** Crank cycle count sampled at last ADL tx (or 0 if never sent) */
  cycleCountAtLastAdl: number;
}

export class MonitorService {
  private _getMarkets: (() => Map<string, MarketCrankState>) | null = null;
  /** Total crank cycles completed — incremented by CrankService via notifyCrankCycle() */
  private _totalCrankCycles = 0;
  /** Last ADL tx counts per market — updated by notifyAdlTx() */
  private _adlTxCounts = new Map<string, number>();

  private _perMarket = new Map<string, PerMarketState>();
  private _invariantResults = new Map<string, MarketInvariantResult>();
  private _adlStalenessResults = new Map<string, AdlStalenessResult>();

  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Wire in the crank service market map after construction. */
  setMarketSource(fn: () => Map<string, MarketCrankState>): void {
    this._getMarkets = fn;
  }

  /** Called by CrankService after each completed crank cycle. */
  notifyCrankCycle(): void {
    this._totalCrankCycles++;
  }

  /** Called by AdlService after each successful ExecuteAdl tx for a market. */
  notifyAdlTx(slabAddress: string): void {
    const prev = this._adlTxCounts.get(slabAddress) ?? 0;
    this._adlTxCounts.set(slabAddress, prev + 1);
    const mState = this._getOrCreatePerMarket(slabAddress);
    mState.cycleCountAtLastAdl = this._totalCrankCycles;
  }

  start(getMarkets: () => Map<string, MarketCrankState>): void {
    if (this._timer) return;
    this._getMarkets = getMarkets;

    logger.info("MonitorService starting", {
      invariantIntervalMs: INVARIANT_CHECK_INTERVAL_MS,
      adlStalenessCycleThreshold: ADL_STALENESS_CYCLE_THRESHOLD,
    });

    this._timer = setInterval(async () => {
      const _t0 = Date.now();
      try {
        await this._runChecks();
      } catch (err) {
        logger.error("MonitorService check cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        cycleDurationSeconds.observe({ service: "monitor" }, (Date.now() - _t0) / 1000);
      }
    }, INVARIANT_CHECK_INTERVAL_MS);

    // Don't block process exit on this interval
    this._timer.unref();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.info("MonitorService stopped");
    }
  }

  /** Returns current invariant + ADL staleness results for all markets. */
  getStatus(): {
    invariants: MarketInvariantResult[];
    adlStaleness: AdlStalenessResult[];
    totalCrankCycles: number;
  } {
    return {
      invariants: [...this._invariantResults.values()],
      adlStaleness: [...this._adlStalenessResults.values()],
      totalCrankCycles: this._totalCrankCycles,
    };
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private async _runChecks(): Promise<void> {
    if (!this._getMarkets) return;
    const markets = this._getMarkets();

    const conn = getConnection();
    const now = Date.now();

    // B12: parallel-fan-out per market with allSettled + per-call timeout.
    // The previous sequential loop meant one slow node delayed every market's
    // invariant check; one timeout would also abort the whole pass.
    const entries = Array.from(markets.entries()).filter(
      ([_, s]) => !s.permanentlySkipped && !s.foreignOracleSkipped,
    );
    await Promise.allSettled(
      entries.map(([slabAddress, crankState]) =>
        this._checkOneMarket(slabAddress, crankState, conn, now),
      ),
    );
  }

  private async _checkOneMarket(
    slabAddress: string,
    crankState: MarketCrankState,
    conn: ReturnType<typeof getConnection>,
    now: number,
  ): Promise<void> {
    {
      // ── 6.1: Conservation invariant ───────────────────────────────────────
      try {
        const data = await withTimeout(
          fetchSlab(conn, crankState.market.slabAddress, crankState.market.programId),
          MONITOR_RPC_TIMEOUT_MS,
          `fetchSlab(${slabAddress.slice(0, 8)})`,
        );
        if (isV17Account(data)) {
          this._invariantResults.set(slabAddress, {
            slabAddress,
            ok: true,
            vaultTokenBalance: "0",
            engineVault: "0",
            shortfall: "0",
            checkedAt: now,
            skippedReason: "v17 market account: legacy engine.vault invariant is not applicable",
          });
          this._adlStalenessResults.set(slabAddress, {
            slabAddress,
            adlNeeded: false,
            cycleSinceLastAdl: 0,
            stale: false,
            checkedAt: now,
            skippedReason: "v17 removed ExecuteAdl; legacy ADL staleness check is not applicable",
          });
          logger.debug("MonitorService skipped legacy v12 checks for v17 market", {
            slabAddress: slabAddress.slice(0, 8),
          });
          return;
        }
        const engine = parseEngine(data);
        const cfg = parseConfig(data);

        // Fetch the actual SPL token balance from the vault token account.
        // parseConfig returns vaultPubkey — the token account that holds collateral.
        const tokenBalanceResp = await withTimeout(
          conn.getTokenAccountBalance(cfg.vaultPubkey),
          MONITOR_RPC_TIMEOUT_MS,
          `getTokenAccountBalance(${slabAddress.slice(0, 8)})`,
        );
        // amount is a string in the token's raw units (no decimals)
        const vaultTokenBalance = BigInt(tokenBalanceResp.value.amount);

        // engine.vault is what the program accounts for as collateral.
        // It should always be <= actual SPL balance (the program can never spend
        // tokens it hasn't accounted for, and rounding can create a tiny surplus).
        const engineVault = engine.vault;
        const ok = vaultTokenBalance >= engineVault;
        const shortfall = ok ? 0n : engineVault - vaultTokenBalance;

        const result: MarketInvariantResult = {
          slabAddress,
          ok,
          vaultTokenBalance: vaultTokenBalance.toString(),
          engineVault: engineVault.toString(),
          shortfall: shortfall.toString(),
          checkedAt: now,
        };
        this._invariantResults.set(slabAddress, result);

        if (!ok) {
          logger.error("Conservation invariant VIOLATED", {
            slabAddress,
            vaultTokenBalance: vaultTokenBalance.toString(),
            engineVault: engineVault.toString(),
            shortfall: shortfall.toString(),
          });

          const mState = this._getOrCreatePerMarket(slabAddress);
          if (now - mState.lastInvariantAlert > ALERT_COOLDOWN_MS) {
            mState.lastInvariantAlert = now;
            sendCriticalAlert("Conservation invariant violated — vault underfunded", [
              { name: "Market", value: slabAddress.slice(0, 16) + "...", inline: false },
              { name: "SPL Balance (actual)", value: vaultTokenBalance.toString(), inline: true },
              { name: "Engine Vault (expected)", value: engineVault.toString(), inline: true },
              { name: "Shortfall", value: shortfall.toString(), inline: true },
            ]).catch(() => {});
          }
        } else {
          logger.debug("Conservation invariant OK", {
            slabAddress: slabAddress.slice(0, 8),
            vaultTokenBalance: vaultTokenBalance.toString(),
            engineVault: engineVault.toString(),
          });
        }

        // ── 6.3: ADL staleness ─────────────────────────────────────────────
        // Check if ADL is needed by comparing pnl_pos_tot against max_pnl_cap.
        // We reuse the data already fetched above.
        // ADL preconditions must match on-chain require checks in handle_execute_adl:
        // 1. Insurance fund must be fully depleted (balance == 0n)
        // 2. PnL above the cap (pnl_pos_tot > max_pnl_cap, cap > 0)
        // ExecuteAdl is admin/multisig-gated — this is an alert path only.
        const { pnlPosTot } = engine;
        // maxPnlCap lives on MarketConfig (parseConfig), already parsed above.
        const maxPnlCap = cfg.maxPnlCap;
        const insuranceDepleted = engine.insuranceFund.balance === 0n;
        const adlNeeded = insuranceDepleted && maxPnlCap > 0n && pnlPosTot > maxPnlCap;

        const mState = this._getOrCreatePerMarket(slabAddress);
        const cyclesSinceLastAdl = adlNeeded
          ? this._totalCrankCycles - mState.cycleCountAtLastAdl
          : 0;

        const stale =
          adlNeeded && cyclesSinceLastAdl >= ADL_STALENESS_CYCLE_THRESHOLD;

        const adlResult: AdlStalenessResult = {
          slabAddress,
          adlNeeded,
          cycleSinceLastAdl: cyclesSinceLastAdl,
          stale,
          checkedAt: now,
        };
        this._adlStalenessResults.set(slabAddress, adlResult);

        if (stale) {
          logger.warn("ADL conditions met — admin/multisig action required", {
            slabAddress,
            pnlPosTot: pnlPosTot.toString(),
            maxPnlCap: maxPnlCap.toString(),
            cyclesSinceLastAdl,
            threshold: ADL_STALENESS_CYCLE_THRESHOLD,
          });

          if (now - mState.lastAdlStalenessAlert > ALERT_COOLDOWN_MS) {
            mState.lastAdlStalenessAlert = now;
            sendWarningAlert("ADL needed but keeper has not executed it recently", [
              { name: "Market", value: slabAddress.slice(0, 16) + "...", inline: false },
              { name: "pnl_pos_tot", value: pnlPosTot.toString(), inline: true },
              { name: "max_pnl_cap", value: maxPnlCap.toString(), inline: true },
              { name: "Cycles without ADL tx", value: cyclesSinceLastAdl.toString(), inline: true },
            ]).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn("MonitorService check failed for market", {
          slabAddress: slabAddress.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private _getOrCreatePerMarket(slabAddress: string): PerMarketState {
    if (!this._perMarket.has(slabAddress)) {
      this._perMarket.set(slabAddress, {
        lastInvariantAlert: 0,
        lastAdlStalenessAlert: 0,
        cycleCountAtLastAdl: 0,
      });
    }
    return this._perMarket.get(slabAddress)!;
  }
}
