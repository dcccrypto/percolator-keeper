/**
 * ADL Service — PERC-8293 (T11): Auto-Deleverage crank loop
 *
 * Originally scaffolded as PERC-8276. Updated in T11 to add:
 *   - Insurance fund utilization BPS threshold check
 *   - Two-phase dispatch comments / scaffolding for T5 (PERC-8270)
 *
 * Feature-flagged via env var `ADL_ENABLED=true` so it can run alongside
 * the existing crank service without affecting production behaviour until
 * the on-chain instruction is live.
 *
 * Responsibilities:
 *  1. Per-market: fetch slab data, check `pnl_pos_tot > max_pnl_cap` OR
 *     insurance fund utilization BPS > ADL_INSURANCE_UTIL_THRESHOLD_BPS
 *  2. When ADL is needed: rank all profitable positions by PnL%
 *  3. Call ExecuteAdl (tag 50) on the top-ranked position
 *  4. Repeat until pnl_pos_tot ≤ max_pnl_cap or no profitable positions remain
 *
 * Two-phase crank note (T5/PERC-8270):
 *  The on-chain two-phase split (prepare + execute) lives in the Rust program.
 *  From the keeper's perspective the call signature is unchanged — we send a
 *  single KeeperCrank transaction. When T5 lands, update the
 *  `PrepareAdlResult` / `PhaseOneKeeperArgs` types in crank-types.ts and wire
 *  the prepare step here before the ExecuteAdl dispatch.
 *
 * Dependency surface:
 *  - @percolator/sdk:  fetchSlab, parseEngine, parseConfig, parseAllAccounts,
 *                      encodeExecuteAdl, ACCOUNTS_EXECUTE_ADL, buildAccountMetas,
 *                      buildIx, derivePythPushOraclePDA
 *  - @percolatorct/shared: getConnection, loadKeypair, sendWithRetryKeeper,
 *                        createLogger, sendWarningAlert, sendCriticalAlert
 */

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  fetchSlab,
  parseEngine,
  parseConfig,
  parseAllAccounts,
  encodeExecuteAdl,
  ACCOUNTS_EXECUTE_ADL,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import {
  getConnection,
  loadKeypair,
  createLogger,
  sendWarningAlert,
  sendCriticalAlert,
} from "@percolatorct/shared";
import type { MarketCrankState } from "./crank-types.js";
import { recordAttempt, recordLanded, recordFailed } from "../lib/sender-metrics.js";
import { txSentTotal, solSpentLamportsTotal, txLandTimeSeconds } from "../lib/metrics.js";
import { keeperSend, sharedBudget } from "../lib/keeper-send.js";
import { sharedTxQueue } from "../lib/tx-queue.js";

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
 * How often to run the ADL scan loop in milliseconds.
 * Default 10 s — fast enough to clear excess PnL promptly; slow enough to
 * avoid hammering RPC on quiet markets.
 */
const ADL_INTERVAL_MS = parseIntEnv("ADL_INTERVAL_MS", 10_000, 1000);

/**
 * Maximum number of ExecuteAdl transactions sent per market per ADL scan.
 * Guards against runaway loops if on-chain state is not updating between cycles.
 */
const ADL_MAX_TX_PER_SCAN = parseIntEnv("ADL_MAX_TX_PER_SCAN", 10, 1);

/**
 * Insurance fund balance threshold below which ADL kicks in (raw lamports).
 * Set to 0 to rely solely on pnl_pos_tot > max_pnl_cap.
 *
 * Per PERC-305 spec: ADL is triggered when pnl_pos_tot > max_pnl_cap,
 * which is itself a proxy for insurance fund stress.  This extra guard
 * allows ops to tune ADL sensitivity independently.
 *
 * Unit: raw lamports (bigint).  Default 0 = disabled.
 */
const ADL_INSURANCE_THRESHOLD = parseBigIntEnv(
  "ADL_INSURANCE_THRESHOLD_LAMPORTS", "0"
);

/**
 * PERC-8293 (T11): Insurance fund utilization BPS threshold.
 *
 * ADL also triggers when the insurance fund is sufficiently drawn down,
 * measured as:
 *   utilization_bps = (fee_revenue - balance) * 10_000 / max(fee_revenue, 1)
 *
 * This captures the fraction of lifetime fee revenue that has been consumed
 * by socialised losses.  When fee_revenue == 0 (fresh market), utilization is
 * treated as 0 (not triggered).
 *
 * Default 8000 BPS = 80% utilization triggers ADL even before pnl_pos_tot
 * exceeds max_pnl_cap.  Set to 0 to disable the utilization gate.
 */
const ADL_INSURANCE_UTIL_THRESHOLD_BPS = parseBigIntEnv(
  "ADL_INSURANCE_UTIL_THRESHOLD_BPS", "8000"
);

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
 */
export interface AdlTriggerState {
  slabAddress: string;
  pnlPosTot: string;
  maxPnlCap: string;
  insuranceFundBalance: string;
  insuranceFundFeeRevenue: string;
  insuranceUtilizationBps: number;
  capExceeded: boolean;
  insuranceDepleted: boolean;
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
  adlTxSent: number;
  consecutiveErrors: number;
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

/** Returns a structured trigger state for a market. */
function checkAdlTrigger(
  pnlPosTot: bigint,
  maxPnlCap: bigint,
  insuranceFundBalance: bigint,
  insuranceFundFeeRevenue: bigint,
  slabAddress: string,
  data: Uint8Array
): Omit<AdlTriggerState, "rankings"> & { excess: bigint } {
  const capExceeded = maxPnlCap > 0n && pnlPosTot > maxPnlCap;
  const insuranceDepleted =
    ADL_INSURANCE_THRESHOLD > 0n &&
    insuranceFundBalance < ADL_INSURANCE_THRESHOLD;
  const utilizationBps = computeInsuranceUtilizationBps(
    insuranceFundBalance,
    insuranceFundFeeRevenue
  );
  const utilizationTriggered =
    ADL_INSURANCE_UTIL_THRESHOLD_BPS > 0n &&
    utilizationBps >= ADL_INSURANCE_UTIL_THRESHOLD_BPS;

  // ADL disabled if max_pnl_cap == 0 UNLESS insurance utilization gate fires
  const adlNeeded =
    capExceeded || insuranceDepleted || utilizationTriggered;

  const excess =
    capExceeded && maxPnlCap > 0n
      ? pnlPosTot - maxPnlCap
      : pnlPosTot; // Use full pnlPosTot as excess when triggered by insurance

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
 * @deprecated Use checkAdlTrigger instead.
 * Returns true when ADL should run for this market given engine state.
 */
function isAdlNeeded(
  pnlPosTot: bigint,
  maxPnlCap: bigint,
  insuranceFundBalance: bigint
): boolean {
  if (maxPnlCap === 0n) return false; // ADL disabled on market (max_pnl_cap=0)

  const capExceeded = pnlPosTot > maxPnlCap;

  // Optional insurance fund gate (operator configurable)
  const insuranceDepleted =
    ADL_INSURANCE_THRESHOLD > 0n &&
    insuranceFundBalance < ADL_INSURANCE_THRESHOLD;

  return capExceeded || insuranceDepleted;
}

/**
 * Rank all profitable positions by PnL% (descending).
 * Uses capital as denominator; positions with zero capital are excluded.
 */
function rankProfitablePositions(
  data: Uint8Array,
  excess: bigint
): RankedPosition[] {
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

// ─── ADL service class ─────────────────────────────────────────────────────

export class AdlService {
  private markets = new Map<string, AdlMarketState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _getMarkets: (() => Map<string, MarketCrankState>) | null = null;
  private _isRunning = false;
  private _cycling = false;
  // Cache keypair at construction — avoids re-parsing from env on every scanMarket() call
  private readonly _keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
  private _cycleStartedAt = 0;

  /** Inject the crank service's market map so ADL can iterate tracked markets. */
  setMarketSource(fn: () => Map<string, MarketCrankState>): void {
    this._getMarkets = fn;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * PERC-8293 (T11): Fetch on-chain state and return ADL trigger info + position
   * rankings for a single market without sending any transactions.
   *
   * Used by the /api/adl/rankings API endpoint.
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
      data
    );

    let rankings: AdlTriggerState["rankings"] = [];
    if (trigger.adlNeeded) {
      const ranked = rankProfitablePositions(data, trigger.excess);
      rankings = ranked.map((r, i) => ({
        rank: i + 1,
        idx: r.idx,
        pnlAbs: r.pnlAbs.toString(),
        capital: r.capital.toString(),
        pnlPctMillionths: r.pnlPct.toString(),
      }));
    }

    return { ...trigger, rankings };
  }

  /**
   * Scan one market for ADL conditions.
   * Returns number of ExecuteAdl transactions sent (0 if ADL not needed).
   */
  async scanMarket(slabAddress: string, market: DiscoveredMarket): Promise<number> {
    // B17: stamp lastScanTime on every scan so /status reports activity even
    // when the trigger conditions are false. Without this the field stays at 0
    // and looks like the ADL service has never run — operators can't tell
    // "ADL is off" from "ADL is hung".
    this._getOrCreateState(slabAddress).lastScanTime = Date.now();

    const connection = getConnection();
    const keypair = this._keypair;
    const programId = market.programId;

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
      data
    );

    if (!trigger.adlNeeded) {
      return 0;
    }

    const { excess } = trigger;
    logger.info("ADL triggered for market", {
      slabAddress,
      pnlPosTot: trigger.pnlPosTot,
      maxPnlCap: trigger.maxPnlCap,
      excess: excess.toString(),
      insuranceFundBalance: trigger.insuranceFundBalance,
      insuranceUtilizationBps: trigger.insuranceUtilizationBps,
      capExceeded: trigger.capExceeded,
      utilizationTriggered: trigger.utilizationTriggered,
    });

    // ── T5 two-phase hook (PERC-8270) ─────────────────────────────────────
    // When anchor T5 lands, add a PrepareAdl instruction dispatch here before
    // executing ExecuteAdl. The prepare phase reads oracle/price state and
    // writes a PrepareAdlResult PDA that the execute phase consumes.
    //
    // Pseudocode for when T5 is live:
    //   const prepareData = encodePrepareAdl({ ...args });
    //   const prepareSig = await sendWithRetryKeeper(conn, [buildIx(...)], [keypair]);
    //   const prepareResult = await fetchPrepareAdlResult(conn, prepareResultPda);
    //
    // See crank-types.ts → PrepareAdlArgs / PrepareAdlResult for the scaffold.
    // ──────────────────────────────────────────────────────────────────────

    // Derive oracle key (same logic as crank.ts)
    const pConfig = cfg;

    // Rank profitable positions (reuse trigger.excess calculated above)
    const ranked = rankProfitablePositions(data, excess);
    if (ranked.length === 0) {
      logger.warn("ADL: pnl_pos_tot exceeds cap but no profitable positions found — stale state?", {
        slabAddress,
      });
      return 0;
    }

    // Determine oracle key (same logic as crank.ts)
    const feedBytes = pConfig.indexFeedId.toBytes();
    const isZeroFeed = feedBytes.every((b: number) => b === 0);
    const isAdminOracle = !pConfig.oracleAuthority.equals(PublicKey.default);

    let oracleKey: PublicKey;
    if (isAdminOracle || isZeroFeed) {
      // Admin-oracle or HYPERP mode: oracle account is the slab itself
      oracleKey = market.slabAddress;
    } else {
      const feedHex = Array.from(feedBytes)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");
      oracleKey = derivePythPushOraclePDA(feedHex)[0];
    }

    let sent = 0;
    let remainingExcess = excess;

    for (const pos of ranked) {
      if (sent >= ADL_MAX_TX_PER_SCAN) {
        logger.warn("ADL: reached max tx cap per scan", {
          slabAddress,
          maxTxPerScan: ADL_MAX_TX_PER_SCAN,
          remainingExcess: remainingExcess.toString(),
        });
        break;
      }
      if (remainingExcess <= 0n) break;

      try {
        const adlData = encodeExecuteAdl({ targetIdx: pos.idx });
        const adlKeys = buildAccountMetas(ACCOUNTS_EXECUTE_ADL, [
          keypair.publicKey,
          market.slabAddress,
          SYSVAR_CLOCK_PUBKEY,
          oracleKey,
        ]);
        const ix = buildIx({ programId, keys: adlKeys, data: adlData });

        const __t0 = Date.now();
        recordAttempt();
        let sig: string;
        try {
          // A.9: route ADL through the budget+priority-fee+CU pipeline. ADL
          // was the only send-path that bypassed KeeperBudget; the cap that
          // protects the keeper wallet from a runaway crank or liquidation
          // loop did nothing for ADL until this fix.
          // ADL is liquidation-priority — always dispatched from the liquidation lane.
          const result = await sharedTxQueue.enqueue("liquidation", () =>
            keeperSend(connection, [ix], [keypair], "adl", sharedBudget),
          );
          if (!result) {
            logger.warn("ADL: budget gate refused send — skipping target", {
              slabAddress,
              targetIdx: pos.idx,
              stats: sharedBudget.getStats(),
            });
            recordFailed();
            break;
          }
          sig = result.signature;
          const __tip = process.env.USE_HELIUS_SENDER === "true"
            ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
            : 0;
          const __elapsed = Date.now() - __t0;
          recordLanded(__elapsed, __tip);
          txSentTotal.inc({ result: "success", type: "liquidation" });
          txLandTimeSeconds.observe({ type: "liquidation", lane: __tip > 0 ? "jito" : "sender" }, __elapsed / 1000);
          if (__tip > 0) solSpentLamportsTotal.inc({ type: "liquidation" }, __tip);
        } catch (err) {
          recordFailed();
          txSentTotal.inc({ result: "fail", type: "liquidation" });
          throw err;
        }

        logger.info("ADL tx sent", {
          slabAddress,
          targetIdx: pos.idx,
          pnlPct: (Number(pos.pnlPct) / 1_000_000).toFixed(4) + "%",
          sig,
        });

        sent++;
        // Optimistic: reduce remaining excess by the position's PnL.
        // On next cycle we re-fetch fresh state anyway.
        remainingExcess =
          remainingExcess > pos.pnlAbs ? remainingExcess - pos.pnlAbs : 0n;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("ADL tx failed", {
          slabAddress,
          targetIdx: pos.idx,
          error: errMsg,
        });

        const state = this._getOrCreateState(slabAddress);
        state.consecutiveErrors++;

        if (state.consecutiveErrors >= 3) {
          await sendWarningAlert("ADL consecutive failures", [
            { name: "Market", value: slabAddress.slice(0, 12), inline: true },
            {
              name: "Consecutive Errors",
              value: state.consecutiveErrors.toString(),
              inline: true,
            },
            { name: "Error", value: errMsg.slice(0, 100), inline: false },
          ]).catch(() => {});
        }
        // Continue to next position — one failure shouldn't abort the whole run.
      }
    }

    if (sent > 0) {
      const state = this._getOrCreateState(slabAddress);
      state.adlTxSent += sent;
      state.consecutiveErrors = 0;
    }

    return sent;
  }

  /** Run ADL scan across all tracked markets. */
  async scanAll(): Promise<{ scanned: number; triggered: number; txSent: number }> {
    if (!this._getMarkets) return { scanned: 0, triggered: 0, txSent: 0 };

    const markets = this._getMarkets();
    let scanned = 0;
    let triggered = 0;
    let txSent = 0;

    for (const [slabAddress, crankState] of markets) {
      // Skip permanently-skipped markets
      if (crankState.permanentlySkipped) continue;
      if (crankState.foreignOracleSkipped) continue;

      try {
        const sent = await this.scanMarket(slabAddress, crankState.market);
        scanned++;
        if (sent > 0) {
          triggered++;
          txSent += sent;
        }
      } catch (err) {
        logger.error("ADL scanMarket threw unexpectedly", {
          slabAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { scanned, triggered, txSent };
  }

  start(getMarkets: () => Map<string, MarketCrankState>): void {
    if (this.timer) return;
    this._getMarkets = getMarkets;
    this._isRunning = true;

    logger.info("ADL service starting", { intervalMs: ADL_INTERVAL_MS });

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
        if (result.triggered > 0) {
          logger.info("ADL scan complete", result);
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
        adlTxSent: 0,
        consecutiveErrors: 0,
      });
    }
    return this.markets.get(slabAddress)!;
  }

  getStats(): Map<string, AdlMarketState> {
    return this.markets;
  }
}
