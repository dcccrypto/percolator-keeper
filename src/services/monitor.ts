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
  parseWrapperConfigV17,
  deriveCanonicalVault,
} from "@percolatorct/sdk";
import { readMarketGroupState, readU64LE } from "../lib/v17-fee-state.js";
import {
  getConnection,
  createLogger,
  sendCriticalAlert,
  sendWarningAlert,
} from "@percolatorct/shared";
import { cycleDurationSeconds, conservationInvariantState } from "../lib/metrics.js";
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
  /**
   * true  = invariant evaluated and holds
   * false = invariant evaluated and VIOLATED (funds may have leaked)
   * null  = NOT EVALUATED — no conclusion available
   *
   * #347: `null` exists because this used to report `true` for v17 markets
   * without checking anything. Since the v17 cutover that is every production
   * market, so the only fund-conservation tripwire in the codebase was emitting
   * a green signal it had never computed. An unevaluated check must never be
   * indistinguishable from a passing one.
   */
  ok: boolean | null;
  /** Actual SPL token balance in the vault token account. null when unevaluated. */
  vaultTokenBalance: string | null;
  /** engine.vault — what the program believes is in the vault. null when unevaluated. */
  engineVault: string | null;
  /** Shortfall: engineVault - vaultTokenBalance (0n when ok). null when unevaluated. */
  shortfall: string | null;
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

  /**
   * #347: v17 conservation invariant — the program's accounted vault balance
   * must never exceed the vault token account's real SPL balance.
   *
   * Identical in meaning to the v12 check; only the source of the accounted
   * figure differs (`MarketGroupV16HeaderAccount.vault`, via MG_VAULT_OFF,
   * rather than the v12 `engine.vault`).
   *
   * Every failure to EVALUATE reports `ok: null` with a reason — never `ok:
   * true`, and never fabricated zeroes. That was the original defect: a
   * dashboard showing `shortfall: "0"` reads as "checked, nothing missing".
   *
   * WHAT THIS ACTUALLY DETECTS. Tokens leaving the vault ATA without the wrapper
 * debiting `header.vault` — realistically a program bug or a malicious upgrade,
 * since the ATA authority is the `["vault", market]` PDA and delegate/close
 * authority are rejected on every use. It does NOT detect a drain that goes
 * THROUGH the wrapper's accounting: an attacker exploiting an inflated
 * entitlement reduces `vault` and the balance in lockstep and this holds
 * throughout. So it is a token-account-level leak detector, not a solvency
 * check — green here is not assurance that the market is solvent.
 *
 * COVERAGE LIMIT — secondary collateral. Withdrawals may be denominated in a
   * market's SECONDARY mint (`is_withdrawable_collateral_mint`), while the
   * engine debits the single `header.vault`. On such a market `vault` can fall
   * without the PRIMARY vault balance moving, so this check reads a growing
   * surplus and would not notice a drained secondary vault. Latent today —
   * `handle_set_collateral_mints` requires `vault == c_tot == insurance == 0`
   * to configure a secondary, and live markets have none — but this control
   * does not cover that case and should not be read as if it does.
   *
   * A surplus is deliberately `ok`: it is legitimate, e.g.
   * `handle_swap_secondary_for_primary` moves primary tokens in without
   * crediting `header.vault`.
   */
  /**
   * Record an invariant result as UNEVALUATED.
   *
   * #347: the original defect was reporting a check that never ran as healthy.
   * Every path that cannot evaluate must land here — including the outer
   * per-market catch, because leaving the PREVIOUS cycle's result in place is
   * the same false green with a stale `checkedAt`.
   */
  private _recordUnchecked(slabAddress: string, now: number, reason: string): void {
    conservationInvariantState.set({ market: slabAddress.slice(0, 8) }, -1);
    this._invariantResults.set(slabAddress, {
      slabAddress,
      ok: null,
      vaultTokenBalance: null,
      engineVault: null,
      shortfall: null,
      checkedAt: now,
      skippedReason: `UNCHECKED — ${reason}. This is NOT a passing check.`,
    });
  }

  private async _checkV17Conservation(
    slabAddress: string,
    data: Uint8Array,
    marketPubkey: PublicKey,
    programId: PublicKey,
    now: number,
    conn: ReturnType<typeof getConnection>,
  ): Promise<void> {
    const unchecked = (reason: string): void =>
      this._recordUnchecked(slabAddress, now, reason);

    // Derive the vault from the slab we already have. This read is only used
    // to find the ADDRESS — the numbers compared below come from a second,
    // single-slot read, never from here.
    let vaultToken: PublicKey;
    try {
      const cfg = parseWrapperConfigV17(data);
      [vaultToken] = deriveCanonicalVault(programId, marketPubkey, cfg.collateralMint);
    } catch (err) {
      unchecked(
        `could not derive the v17 vault: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // ATOMIC SNAPSHOT. Reading the slab and the token account separately would
    // compare numbers from two different slots: every outflow debits
    // `header.vault` and transfers in ONE transaction, so if a withdrawal lands
    // between the reads the monitor sees a pre-withdrawal `vault` against a
    // post-withdrawal balance and computes a shortfall exactly equal to the
    // withdrawal — a spurious CRITICAL page. getMultipleAccountsInfo resolves
    // both at a single slot context, so that skew cannot exist.
    let accountedVault: bigint;
    let vaultTokenBalance: bigint;
    try {
      const [slabInfo, vaultInfo] = await withTimeout(
        conn.getMultipleAccountsInfo([marketPubkey, vaultToken]),
        MONITOR_RPC_TIMEOUT_MS,
        `getMultipleAccountsInfo(v17 ${slabAddress.slice(0, 8)})`,
      );
      if (!slabInfo) {
        unchecked("market account not found in the snapshot read");
        return;
      }
      if (!vaultInfo) {
        // A market whose vault ATA does not exist yet is UNCHECKED, not healthy.
        unchecked("vault token account does not exist");
        return;
      }
      const vaultData = new Uint8Array(vaultInfo.data);
      if (vaultData.length < 72) {
        unchecked(`vault token account too short: ${vaultData.length} bytes`);
        return;
      }
      accountedVault = readMarketGroupState(new Uint8Array(slabInfo.data)).vault;
      // SPL token account: mint[32] owner[32] amount:u64 — amount at byte 64.
      vaultTokenBalance = readU64LE(vaultData, 64);
    } catch (err) {
      // An RPC or parse failure is not evidence the vault is healthy.
      unchecked(
        `snapshot read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const ok = vaultTokenBalance >= accountedVault;
    const shortfall = ok ? 0n : accountedVault - vaultTokenBalance;

    conservationInvariantState.set({ market: slabAddress.slice(0, 8) }, ok ? 1 : 0);
    this._invariantResults.set(slabAddress, {
      slabAddress,
      ok,
      vaultTokenBalance: vaultTokenBalance.toString(),
      engineVault: accountedVault.toString(),
      shortfall: shortfall.toString(),
      checkedAt: now,
    });

    if (!ok) {
      // The result is already recorded above. Reporting must never be able to
      // affect it: a failure to DELIVER a page is not a reason to downgrade a
      // detected violation back to "unknown".
      try {
        logger.error("Conservation invariant VIOLATED (v17)", {
          slabAddress,
          vaultTokenBalance: vaultTokenBalance.toString(),
          engineVault: accountedVault.toString(),
          shortfall: shortfall.toString(),
        });

        const mState = this._getOrCreatePerMarket(slabAddress);
        if (now - mState.lastInvariantAlert > ALERT_COOLDOWN_MS) {
          mState.lastInvariantAlert = now;
          await Promise.resolve(
            sendCriticalAlert("Conservation invariant violated — v17 vault underfunded", [
              { name: "Market", value: slabAddress.slice(0, 16) + "...", inline: false },
              { name: "SPL Balance (actual)", value: vaultTokenBalance.toString(), inline: true },
              {
                name: "Accounted Vault (expected)",
                value: accountedVault.toString(),
                inline: true,
              },
              { name: "Shortfall", value: shortfall.toString(), inline: true },
            ]),
          ).catch(() => {});
        }
      } catch (err) {
        logger.warn("Conservation invariant alert dispatch failed", {
          slabAddress: slabAddress.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async _checkOneMarket(
    slabAddress: string,
    crankState: MarketCrankState,
    conn: ReturnType<typeof getConnection>,
    now: number,
  ): Promise<void> {
    {
      // ── 6.1: Conservation invariant ───────────────────────────────────────
      // Whether THIS invocation wrote an invariant result. Tracked explicitly
      // rather than by comparing `checkedAt` to `now`: two cycles can land in
      // the same millisecond, which would make a timestamp comparison silently
      // skip the invalidation below.
      let invariantRecorded = false;
      try {
        const data = await withTimeout(
          fetchSlab(conn, crankState.market.slabAddress, crankState.market.programId),
          MONITOR_RPC_TIMEOUT_MS,
          `fetchSlab(${slabAddress.slice(0, 8)})`,
        );
        if (isV17Account(data)) {
          // #347: run the conservation invariant on v17 too.
          //
          // The legacy path could not: `parseEngine` reads the v12 layout. But
          // "the v12 PARSER doesn't apply" was never "v17 has no vault" — the
          // v17 market-group header carries `vault: u128` in exactly the same
          // role, and `MG_VAULT_OFF` already pins it. So this is the same
          // comparison against a different offset, NOT a reconstruction of the
          // program's accounting from portfolio sums: a hand-rolled sum would
          // be a second implementation of the engine's books, and any drift
          // would fire false alerts — which disables a tripwire through alert
          // fatigue just as effectively as silence does.
          //
          // Anything that stops this from being EVALUATED still reports
          // ok:null, never ok:true. An unevaluated check is not a passing one.
          await this._checkV17Conservation(
            slabAddress,
            data,
            crankState.market.slabAddress,
            crankState.market.programId,
            now,
            conn,
          );
          invariantRecorded = true;
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
        invariantRecorded = true;

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
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("MonitorService check failed for market", {
          slabAddress: slabAddress.slice(0, 8),
          error: message,
        });
        // #347: invalidate rather than leaving the PREVIOUS cycle's result
        // standing. Before v17 could evaluate to ok:true this was harmless;
        // now a fetchSlab failure would otherwise keep a stale green on the
        // health endpoint — the exact symptom this issue was filed for.
        //
        // But only if nothing was evaluated THIS invocation. A throw after the
        // comparison (alert delivery, say) must not erase a real ok:false —
        // that would turn a detected violation back into "unknown".
        if (!invariantRecorded) {
          this._recordUnchecked(slabAddress, now, `market check failed: ${message}`);
        }
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
