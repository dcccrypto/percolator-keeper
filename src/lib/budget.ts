/**
 * KeeperBudget — circuit breaker for keeper send-path spending.
 *
 * Why this exists: the keeper signs transactions against a wallet with real
 * funds. A misconfigured priority fee, a stuck retry loop, or a malicious
 * input can drain that wallet faster than ops can notice. The budget caps
 * lamport spend per cycle / hour / day and tx count per cycle, plus a
 * rolling-window success-rate guard that catches "we're sending but nothing
 * lands". On breach, the budget halts: every subsequent canSpend() returns
 * false until an operator manually resume()s. Day-cap breaches especially
 * never auto-recover — that's a real signal something is wrong.
 *
 * Concurrency: every public method is synchronous. Under Node's single-
 * threaded event loop, no two calls can interleave between their reads and
 * writes, so the internal counters cannot drift even under thousands of
 * concurrent canSpend() / recordTx() callers.
 */

import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:budget");

export type TxType = "crank" | "liquidation" | "oracle" | "adl";
export type TxResult = "success" | "fail" | "reverted" | "drop";

export interface KeeperBudgetConfig {
  /** Per cycle cap in lamports (default 50_000_000 = 0.05 SOL). */
  maxSolPerCycle: number;
  /** Rolling 1-hour cap in lamports (default 500_000_000 = 0.5 SOL). */
  maxSolPerHour: number;
  /** Rolling 24-hour cap in lamports (default 3_000_000_000 = 3 SOL). Manual-resume-only on breach. */
  maxSolPerDay: number;
  /** Cap on tx attempts per cycle (default 60). */
  maxTxPerCycle: number;
  /**
   * Length of the per-cycle window in ms (default 30_000, matching the default
   * crank interval). The per-cycle caps (maxSolPerCycle / maxTxPerCycle) are a
   * burst limiter scoped to this rolling window: the counters reset
   * automatically once the window elapses, so no external beginCycle() caller
   * is required. Operators running many markets or a longer crank interval
   * should size maxTxPerCycle / cycleWindowMs to their peak sends-per-window.
   */
  cycleWindowMs: number;
  /** Window length in ms over which success rate is computed (default 60_000). */
  txSuccessRateWindow: number;
  /** Floor for success rate within the window (default 0.70). */
  txSuccessRateThreshold: number;
  /** Minimum samples before the success-rate guard activates (default 10). */
  txSuccessRateMinSamples: number;
}

export interface BudgetStats {
  cycleSpend: number;
  hourSpend: number;
  daySpend: number;
  cycleTxCount: number;
  /** Lamports reserved by in-flight canSpend()s not yet settled by recordTx(). */
  reservedLamports: number;
  /** Count of in-flight canSpend()s not yet settled by recordTx(). */
  reservedTxCount: number;
  txSuccessRate: number | null;
  txWindowSize: number;
  halted: boolean;
  haltReason?: string;
  haltKind?: HaltKind;
  config: KeeperBudgetConfig;
}

export type HaltKind =
  | "cycle-spend-cap"
  | "hour-spend-cap"
  | "day-spend-cap"
  | "cycle-tx-count-cap"
  | "tx-success-rate"
  | "non-finite-cost"
  | "operator";

export interface KeeperBudgetDeps {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onHalt?: (kind: HaltKind, reason: string) => void;
  /** Fired when a latched halt is cleared (resume()). Lets callers reset a
   *  halted gauge without coupling this class to the metrics layer. */
  onResume?: () => void;
}

interface SpendEvent {
  ts: number;
  lamports: number;
}

interface TxRecord {
  ts: number;
  success: boolean;
}

const DEFAULTS: KeeperBudgetConfig = {
  maxSolPerCycle: 50_000_000,
  maxSolPerHour: 500_000_000,
  maxSolPerDay: 3_000_000_000,
  maxTxPerCycle: 60,
  cycleWindowMs: 30_000,
  txSuccessRateWindow: 60_000,
  txSuccessRateThreshold: 0.7,
  txSuccessRateMinSamples: 10,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const INT_ENV_KEYS: Array<[keyof KeeperBudgetConfig, string]> = [
  ["maxSolPerCycle", "KEEPER_MAX_SOL_PER_CYCLE"],
  ["maxSolPerHour", "KEEPER_MAX_SOL_PER_HOUR"],
  ["maxSolPerDay", "KEEPER_MAX_SOL_PER_DAY"],
  ["maxTxPerCycle", "KEEPER_MAX_TX_PER_CYCLE"],
  ["cycleWindowMs", "KEEPER_CYCLE_WINDOW_MS"],
  ["txSuccessRateWindow", "KEEPER_TX_SUCCESS_RATE_WINDOW_MS"],
  ["txSuccessRateMinSamples", "KEEPER_TX_SUCCESS_RATE_MIN_SAMPLES"],
];

function parseEnvOverrides(env: NodeJS.ProcessEnv): Partial<KeeperBudgetConfig> {
  const result: Partial<KeeperBudgetConfig> = {};
  for (const [key, envName] of INT_ENV_KEYS) {
    const raw = env[envName];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) {
      (result as Record<string, number>)[key] = n;
    }
  }
  const rateRaw = env.KEEPER_TX_SUCCESS_RATE_THRESHOLD;
  if (rateRaw !== undefined && rateRaw !== "") {
    const n = Number(rateRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      result.txSuccessRateThreshold = n;
    }
  }
  return result;
}

export class KeeperBudget {
  readonly config: KeeperBudgetConfig;
  private readonly _now: () => number;
  private readonly _onHalt: ((kind: HaltKind, reason: string) => void) | undefined;
  private readonly _onResume: (() => void) | undefined;

  private _cycleSpend = 0;
  private _cycleTxCount = 0;
  /** Wall-clock anchor for the current per-cycle window. 0 = not yet anchored
   *  (anchored lazily on first send-path call so the window starts at first
   *  use, not at construction time). */
  private _cycleStartMs = 0;
  private readonly _hourEvents: SpendEvent[] = [];
  private _hourSpendSum = 0;
  private readonly _dayEvents: SpendEvent[] = [];
  private _daySpendSum = 0;
  private readonly _txWindow: TxRecord[] = [];
  private _txWindowSuccesses = 0;
  private _txWindowFailures = 0;

  // In-flight reservations. canSpend() reserves the proposed cost (and one tx
  // slot) when it admits a send; recordTx() releases it when the send settles.
  // The cap checks count reservations so concurrent in-flight sends — booked by
  // recordTx only AFTER their network await — cannot all clear the same
  // pre-send snapshot and collectively overshoot a cap (TOCTOU). Reservations
  // are kept entirely separate from _cycleSpend/_hourSpendSum/etc., so
  // getStats().cycleSpend still equals the sum of booked (non-drop) recordTx
  // calls — the recordTx-only accounting and its property tests are unchanged.
  private _reservedLamports = 0;
  private _reservedTxCount = 0;

  private _isHalted = false;
  private _haltKind: HaltKind | undefined;
  private _haltReason: string | undefined;

  constructor(config: Partial<KeeperBudgetConfig> = {}, deps: KeeperBudgetDeps = {}) {
    const envOverrides = parseEnvOverrides(deps.env ?? process.env);
    this.config = { ...DEFAULTS, ...envOverrides, ...config };
    this._now = deps.now ?? (() => Date.now());
    this._onHalt = deps.onHalt;
    this._onResume = deps.onResume;
  }

  /**
   * Pre-flight check: would sending a tx that costs `lamports` lamports breach
   * any cap? Returns false on breach AND latches the halt so subsequent calls
   * also return false until resume() is called.
   *
   * txType is currently advisory (logged on breach); planned use is to attribute
   * Prometheus halt counters per tx category.
   */
  canSpend(lamports: number, txType: TxType): boolean {
    if (this._isHalted) return false;

    // A non-finite or negative cost means the fee/CU/tip math produced NaN or
    // Infinity — almost always a malformed numeric env (e.g. JITO_TIP_LAMPORTS).
    // NaN slips every `x > cap` comparison below (NaN > cap === false), so it
    // would otherwise be admitted, silently disabling the breaker. Treat it as a
    // hard fault: refuse and halt so an operator fixes the config and resume()s.
    // Checked first so the bad value never enters a comparison and never reserves.
    if (!Number.isFinite(lamports) || lamports < 0) {
      this._halt(
        "non-finite-cost",
        `proposed cost ${lamports} is not a finite non-negative number — likely a malformed fee env (txType=${txType})`,
      );
      return false;
    }

    const nowMs = this._now();
    this._rollCycleIfElapsed(nowMs);
    this._pruneOld(nowMs);

    // ── Settled-spend breaches HALT (latching, manual-resume) ──────────────
    // These mirror the historical behavior exactly: if the ALREADY-BOOKED spend
    // plus this one cost would breach a cap, that is a real overspend signal and
    // the breaker latches. Reservations are intentionally excluded here so the
    // halt semantics (and the existing cap tests) are unchanged.
    if (this._cycleSpend + lamports > this.config.maxSolPerCycle) {
      this._halt(
        "cycle-spend-cap",
        `proposed cycle spend ${this._cycleSpend + lamports} > cap ${this.config.maxSolPerCycle} (txType=${txType})`,
      );
      return false;
    }
    if (this._hourSpendSum + lamports > this.config.maxSolPerHour) {
      this._halt(
        "hour-spend-cap",
        `proposed hour spend ${this._hourSpendSum + lamports} > cap ${this.config.maxSolPerHour} (txType=${txType})`,
      );
      return false;
    }
    if (this._daySpendSum + lamports > this.config.maxSolPerDay) {
      this._halt(
        "day-spend-cap",
        `proposed day spend ${this._daySpendSum + lamports} > cap ${this.config.maxSolPerDay} (txType=${txType})`,
      );
      return false;
    }
    if (this._cycleTxCount + 1 > this.config.maxTxPerCycle) {
      this._halt(
        "cycle-tx-count-cap",
        `proposed cycle tx count ${this._cycleTxCount + 1} > cap ${this.config.maxTxPerCycle} (txType=${txType})`,
      );
      return false;
    }

    const rate = this._computeSuccessRate();
    if (rate !== null && rate < this.config.txSuccessRateThreshold) {
      this._halt(
        "tx-success-rate",
        `tx success rate ${rate.toFixed(3)} < threshold ${this.config.txSuccessRateThreshold} over ${this._txWindow.length} samples (txType=${txType})`,
      );
      return false;
    }

    // ── Reservation back-pressure: REFUSE without halting ──────────────────
    // The settled spend alone is within every cap, but in-flight (reserved)
    // sends would push this one over. That is concurrency back-pressure, not
    // overspend — nothing has been over-spent yet, and capacity returns as the
    // in-flight sends settle and release. Refuse this send (the caller skips it
    // and retries next cycle) rather than latching the breaker, which would
    // stall the keeper during exactly the bursts it exists to handle.
    if (
      this._cycleSpend + this._reservedLamports + lamports > this.config.maxSolPerCycle ||
      this._hourSpendSum + this._reservedLamports + lamports > this.config.maxSolPerHour ||
      this._daySpendSum + this._reservedLamports + lamports > this.config.maxSolPerDay ||
      this._cycleTxCount + this._reservedTxCount + 1 > this.config.maxTxPerCycle
    ) {
      return false;
    }

    // All checks passed — reserve before returning true so a concurrent
    // canSpend() sees this in-flight cost. recordTx() releases the reservation.
    this._reservedLamports += lamports;
    this._reservedTxCount += 1;
    return true;
  }

  /**
   * Record a settled tx. Called regardless of halt state — accounts for
   * in-flight txs that settle after the budget has already tripped.
   *
   * - 'success' / 'fail' / 'reverted': lamports are added to spend trackers
   *   (fees are paid on any tx that landed in a block).
   * - Only 'success' and 'fail' feed the tx-success-rate window. 'reverted'
   *   means the tx LANDED on-chain and the program returned an error — the
   *   send path demonstrably works, so a revert is NOT an "are we landing?"
   *   failure and must not move that breaker. Otherwise a single
   *   persistently-reverting market, or an attacker who front-runs liquidations
   *   to make them revert, would drive the global rate down and halt every
   *   market (cross-market DoS). A reverting market is instead contained by the
   *   per-market consecutiveFailures skip in crank.ts.
   * - 'drop': lamports are NOT added (we never reached the chain). Still
   *   counts toward cycleTxCount as an attempt.
   */
  recordTx(lamports: number, txType: string, result: TxResult): void {
    if (lamports < 0 || !Number.isFinite(lamports)) return;
    const nowMs = this._now();
    // Roll before counting so this tx lands in the current window.
    this._rollCycleIfElapsed(nowMs);

    // Release the reservation taken by the matching canSpend() (keeperSend
    // passes the same estimatedCost to both, and guarantees exactly one
    // recordTx per reserving canSpend via try/finally). Clamped at >= 0 so
    // recordTx-only callers (tests, or a settled tx that was never reserved)
    // cannot drive the tally negative — this is what keeps the cycleSpend-sum
    // invariant exact: reservations never touch the booked spend below.
    this._reservedLamports = Math.max(0, this._reservedLamports - lamports);
    this._reservedTxCount = Math.max(0, this._reservedTxCount - 1);

    this._cycleTxCount++;

    if (result !== "drop") {
      this._cycleSpend += lamports;
      this._hourEvents.push({ ts: nowMs, lamports });
      this._hourSpendSum += lamports;
      this._dayEvents.push({ ts: nowMs, lamports });
      this._daySpendSum += lamports;
      // Only landing outcomes feed the success-rate guard. A revert landed, so
      // it is excluded from the window entirely (neither success nor failure).
      if (result === "success" || result === "fail") {
        const success = result === "success";
        this._txWindow.push({ ts: nowMs, success });
        if (success) this._txWindowSuccesses++;
        else this._txWindowFailures++;
      }
    }

    this._pruneOld(nowMs);

    if (process.env.KEEPER_BUDGET_DEBUG === "true") {
      logger.debug("recordTx", {
        txType,
        result,
        lamports,
        cycleSpend: this._cycleSpend,
        hourSpend: this._hourSpendSum,
        daySpend: this._daySpendSum,
      });
    }
  }

  /**
   * Manually reset per-cycle counters and re-anchor the per-cycle window.
   * No longer required for correctness — the per-cycle window now resets
   * itself on a timer (see _rollCycleIfElapsed) so the caps work without any
   * caller. Retained for explicit manual cordoning/tests. Does NOT clear halt
   * state — that requires resume().
   */
  beginCycle(): void {
    this._cycleSpend = 0;
    this._cycleTxCount = 0;
    this._cycleStartMs = this._now();
    // Intentionally does NOT reset _reservedLamports / _reservedTxCount:
    // reservations track sends that are still in flight and may straddle a cycle
    // boundary (canSpend in cycle N, recordTx in cycle N+1). Clearing them here
    // would orphan the pending release and let the new cycle over-admit by the
    // number of in-flight sends. They self-clear as each in-flight recordTx lands.
  }

  getStats(): BudgetStats {
    const nowMs = this._now();
    this._rollCycleIfElapsed(nowMs);
    this._pruneOld(nowMs);
    return {
      cycleSpend: this._cycleSpend,
      hourSpend: this._hourSpendSum,
      daySpend: this._daySpendSum,
      cycleTxCount: this._cycleTxCount,
      reservedLamports: this._reservedLamports,
      reservedTxCount: this._reservedTxCount,
      txSuccessRate: this._computeSuccessRate(),
      txWindowSize: this._txWindow.length,
      halted: this._isHalted,
      haltReason: this._haltReason,
      haltKind: this._haltKind,
      config: { ...this.config },
    };
  }

  isHalted(): boolean {
    return this._isHalted;
  }

  get haltReason(): string | undefined {
    return this._haltReason;
  }

  get haltKind(): HaltKind | undefined {
    return this._haltKind;
  }

  /**
   * Clear halt state. Logs the operator name so the audit trail records who
   * authorized the resume. Pass a recognizable identifier (e.g. on-call
   * pager handle) so the alert thread can reference it.
   */
  resume(operator: string): void {
    if (!this._isHalted) return;
    logger.warn("Keeper budget resumed", {
      operator,
      previousHaltKind: this._haltKind,
      previousHaltReason: this._haltReason,
    });
    this._isHalted = false;
    this._haltKind = undefined;
    this._haltReason = undefined;
    try {
      this._onResume?.();
    } catch (err) {
      logger.warn("onResume hook threw — ignoring", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Operator-initiated halt. Useful for cordoning the keeper before a
   * deploy or in response to an external incident.
   */
  haltManually(reason: string): void {
    this._halt("operator", reason);
  }

  private _halt(kind: HaltKind, reason: string): void {
    if (this._isHalted) return;
    this._isHalted = true;
    this._haltKind = kind;
    this._haltReason = reason;
    logger.error("Keeper budget halted — refusing further sends until manual resume()", {
      kind,
      reason,
    });
    try {
      this._onHalt?.(kind, reason);
    } catch (err) {
      logger.warn("onHalt hook threw — ignoring", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reset the per-cycle counters when the cycle window has elapsed. This is the
   * reset that beginCycle() was supposed to provide but that no production
   * caller ever invoked, which made the per-cycle caps accumulate over the whole
   * process lifetime and permanently self-halt the keeper.
   *
   * Time-driven on purpose: the budget is a single shared singleton hit by the
   * crank, liquidation, and ADL services on independent timers. If each service
   * reset the counters at the top of its own loop they would stomp one another
   * (multi-owner race). Anchoring the reset to wall-clock time means no service
   * owns it — any send-path call crossing the window boundary rolls it
   * identically, race-free under Node's single-threaded event loop.
   *
   * It deliberately does NOT clear a latched halt: a breach within a single
   * window is a genuine burst anomaly that must stay halted until an operator
   * resume()s (see resume() / the /admin/budget/resume endpoint). Only the
   * lifetime-accumulation that caused the self-halt is removed.
   */
  private _rollCycleIfElapsed(nowMs: number): void {
    if (this._cycleStartMs === 0) {
      this._cycleStartMs = nowMs;
      return;
    }
    if (nowMs - this._cycleStartMs >= this.config.cycleWindowMs) {
      this._cycleSpend = 0;
      this._cycleTxCount = 0;
      this._cycleStartMs = nowMs;
    }
  }

  private _pruneOld(nowMs: number): void {
    const hourCutoff = nowMs - HOUR_MS;
    while (this._hourEvents.length > 0 && this._hourEvents[0]!.ts < hourCutoff) {
      this._hourSpendSum -= this._hourEvents.shift()!.lamports;
    }
    const dayCutoff = nowMs - DAY_MS;
    while (this._dayEvents.length > 0 && this._dayEvents[0]!.ts < dayCutoff) {
      this._daySpendSum -= this._dayEvents.shift()!.lamports;
    }
    const windowCutoff = nowMs - this.config.txSuccessRateWindow;
    while (this._txWindow.length > 0 && this._txWindow[0]!.ts < windowCutoff) {
      const evicted = this._txWindow.shift()!;
      if (evicted.success) this._txWindowSuccesses--;
      else this._txWindowFailures--;
    }
  }

  private _computeSuccessRate(): number | null {
    const total = this._txWindow.length;
    if (total < this.config.txSuccessRateMinSamples) return null;
    return this._txWindowSuccesses / total;
  }
}
