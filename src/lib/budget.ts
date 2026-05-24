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

export type TxType = "crank" | "liquidation" | "oracle";
export type TxResult = "success" | "fail" | "drop";

export interface KeeperBudgetConfig {
  /** Per cycle cap in lamports (default 50_000_000 = 0.05 SOL). */
  maxSolPerCycle: number;
  /** Rolling 1-hour cap in lamports (default 500_000_000 = 0.5 SOL). */
  maxSolPerHour: number;
  /** Rolling 24-hour cap in lamports (default 3_000_000_000 = 3 SOL). Manual-resume-only on breach. */
  maxSolPerDay: number;
  /** Cap on tx attempts per cycle (default 60). */
  maxTxPerCycle: number;
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
  | "operator";

export interface KeeperBudgetDeps {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onHalt?: (kind: HaltKind, reason: string) => void;
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

  private _cycleSpend = 0;
  private _cycleTxCount = 0;
  private readonly _hourEvents: SpendEvent[] = [];
  private _hourSpendSum = 0;
  private readonly _dayEvents: SpendEvent[] = [];
  private _daySpendSum = 0;
  private readonly _txWindow: TxRecord[] = [];
  private _txWindowSuccesses = 0;
  private _txWindowFailures = 0;

  private _isHalted = false;
  private _haltKind: HaltKind | undefined;
  private _haltReason: string | undefined;

  constructor(config: Partial<KeeperBudgetConfig> = {}, deps: KeeperBudgetDeps = {}) {
    const envOverrides = parseEnvOverrides(deps.env ?? process.env);
    this.config = { ...DEFAULTS, ...envOverrides, ...config };
    this._now = deps.now ?? (() => Date.now());
    this._onHalt = deps.onHalt;
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

    const nowMs = this._now();
    this._pruneOld(nowMs);

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

    return true;
  }

  /**
   * Record a settled tx. Called regardless of halt state — accounts for
   * in-flight txs that settle after the budget has already tripped.
   *
   * - 'success' / 'fail': lamports are added to spend trackers (fees pay on
   *   failed txs that landed in a block).
   * - 'drop': lamports are NOT added (we never reached the chain). Still
   *   counts toward cycleTxCount as an attempt.
   */
  recordTx(lamports: number, txType: string, result: TxResult): void {
    if (lamports < 0 || !Number.isFinite(lamports)) return;
    const nowMs = this._now();
    this._cycleTxCount++;

    if (result !== "drop") {
      this._cycleSpend += lamports;
      this._hourEvents.push({ ts: nowMs, lamports });
      this._hourSpendSum += lamports;
      this._dayEvents.push({ ts: nowMs, lamports });
      this._daySpendSum += lamports;
      const success = result === "success";
      this._txWindow.push({ ts: nowMs, success });
      if (success) this._txWindowSuccesses++;
      else this._txWindowFailures++;
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
   * Reset per-cycle counters at the top of a new cycle. Does NOT clear halt
   * state — that requires resume().
   */
  beginCycle(): void {
    this._cycleSpend = 0;
    this._cycleTxCount = 0;
  }

  getStats(): BudgetStats {
    this._pruneOld(this._now());
    return {
      cycleSpend: this._cycleSpend,
      hourSpend: this._hourSpendSum,
      daySpend: this._daySpendSum,
      cycleTxCount: this._cycleTxCount,
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
