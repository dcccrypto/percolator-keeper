/**
 * ShadowHarness — comparison loop for the shadow-keeper observation harness.
 *
 * When SHADOW_HARNESS_ENABLED=true the keeper runs in DRY_RUN mode in a
 * separate shadow region. Every "would have fired" decision is logged by
 * DecisionLog. This harness runs a periodic comparison loop that cross-checks
 * those decisions against the live keeper's on-chain tx count (via
 * getSignaturesForAddress on the program id) and fires a Discord WARN if
 * divergence exceeds the configured threshold.
 *
 * v1 matching strategy — aggregate divergence:
 *   divergence_pct = |shadow_total - live_total| / max(shadow_total, live_total, 1) * 100
 *
 * Rationale: a per-tx match requires one getTransaction RPC call per live tx
 * (up to 1000 calls per comparison cycle). At production scale that would take
 * 10–100 seconds per cycle and consume most of our RPC quota. Aggregate
 * comparison detects the failure modes we care about (shadow over-fires or
 * under-fires) without that cost. A TODO is left for per-tx matching once a
 * memo-based txType tag is available on live txs.
 *
 * TODO(phase2): when live txs include a memo with txType, match per-(txType+window)
 * rather than just aggregate counts.
 *
 * Design constraints:
 *   - The comparison loop must NEVER block or crash the keeper.
 *   - All errors (RPC, file-read, Discord) are swallowed with logger.error.
 *   - The /shadow/report endpoint is served on the existing health server
 *     (port 8081) via the caller wiring in index.ts — this module just exposes
 *     buildReport() for that endpoint to call.
 */

import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { createLogger, sendWarningAlert } from "@percolatorct/shared";
import type { DecisionEntry } from "./decision-log.js";
import type { TxType } from "./budget.js";
import {
  shadowMatchTotal,
  shadowDivergencePct,
} from "./metrics.js";

const logger = createLogger("keeper:shadow-harness");

const DEFAULT_COMPARE_WINDOW_MS = 300_000; // 5 minutes
// C4 (CRITICAL): the original pct-divergence alert was structurally broken —
// `liveTotal` from getSignaturesForAddress(programId) counts every user/maker/
// oracle/other-keeper tx, while `shadowTotal` counts only this keeper's own
// decisions. Divergence is ~100% on day 1 of mainnet, producing alert fatigue
// every 5 min from boot. The pct gate is removed entirely and replaced with
// two structurally-correct gates that don't rely on signer attribution.
const DEFAULT_SILENT_CYCLES_BEFORE_ALERT = 3;   // ~15 min at 5 min/cycle
const DEFAULT_RUNAWAY_MULTIPLIER = 3;            // shadow > 3x live
const DEFAULT_RUNAWAY_MIN_SAMPLES = 10;          // small-sample guard
const DEFAULT_ALERT_COOLDOWN_MS = 3_600_000;     // 1 hour between alerts
// When the program id is not set in env, fall back to the mainnet constant.
// This constant must match MAINNET_PROGRAM_ID in boot-assertions.ts.
const FALLBACK_PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

export interface ShadowCompareResult {
  windowMs: number;
  fromMs: number;
  toMs: number;
  shadowTotal: number;
  liveTotal: number;
  divergencePct: number;
  /** Per-txType breakdown of shadow decisions in the window. */
  shadowByType: Record<string, number>;
}

export interface ShadowReportResult {
  fromMs: number;
  toMs: number;
  shadowTotal: number;
  liveTotal: number;
  divergencePct: number;
  shadowByType: Record<string, number>;
}

/**
 * Pure divergence formula — exported so property tests can exercise it in
 * isolation without any I/O.
 *
 * Returns a value in [0, 100]. Returns 0 when both totals are 0 (no activity,
 * no divergence). Returns 100 when one side is 0 and the other is non-zero.
 */
export function computeDivergencePct(shadowTotal: number, liveTotal: number): number {
  const maxTotal = Math.max(shadowTotal, liveTotal);
  if (maxTotal === 0) return 0;
  const diff = Math.abs(shadowTotal - liveTotal);
  return Math.min((diff / maxTotal) * 100, 100);
}

interface ShadowHarnessDeps {
  connection: Connection;
  programId?: string;
  readDecisions: (fromMs: number, toMs: number) => Promise<DecisionEntry[]>;
  now?: () => number;
  compareWindowMs?: number;
  /** C4: number of consecutive shadow-silent-live-active cycles before alert. */
  silentCyclesBeforeAlert?: number;
  /** C4: shadowTotal > runawayMultiplier * liveTotal triggers shadow-runaway alert. */
  runawayMultiplier?: number;
  /** C4: minimum shadowTotal for the runaway alert to fire (small-sample guard). */
  runawayMinSamples?: number;
  /** C4: minimum gap between alerts of the same type (anti-spam). */
  alertCooldownMs?: number;
}

export class ShadowHarness {
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly readDecisions: (fromMs: number, toMs: number) => Promise<DecisionEntry[]>;
  private readonly _now: () => number;
  private readonly compareWindowMs: number;
  private readonly silentCyclesBeforeAlert: number;
  private readonly runawayMultiplier: number;
  private readonly runawayMinSamples: number;
  private readonly alertCooldownMs: number;
  private _intervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Last comparison result — used by buildReport(). */
  private _lastResult: ShadowCompareResult | null = null;
  // C4: gating state for the structural alerts. _consecutiveSilentCycles
  // tracks shadow=0 / live>0 streaks (resets on any cycle where shadow>0 OR
  // the live RPC fetch failed). _lastAlertMs is the cooldown floor.
  private _consecutiveSilentCycles = 0;
  private _lastAlertMs = 0;

  constructor(deps: ShadowHarnessDeps) {
    this.connection = deps.connection;
    const rawProgramId =
      deps.programId ??
      process.env.PROGRAM_ID ??
      FALLBACK_PROGRAM_ID;
    this.programId = new PublicKey(rawProgramId);
    this.readDecisions = deps.readDecisions;
    this._now = deps.now ?? (() => Date.now());
    this.compareWindowMs =
      deps.compareWindowMs ??
      Number(process.env.SHADOW_HARNESS_COMPARE_WINDOW_MS ?? DEFAULT_COMPARE_WINDOW_MS);
    this.silentCyclesBeforeAlert =
      deps.silentCyclesBeforeAlert ??
      Number(process.env.SHADOW_HARNESS_SILENT_CYCLES_BEFORE_ALERT ?? DEFAULT_SILENT_CYCLES_BEFORE_ALERT);
    this.runawayMultiplier =
      deps.runawayMultiplier ??
      Number(process.env.SHADOW_HARNESS_RUNAWAY_MULTIPLIER ?? DEFAULT_RUNAWAY_MULTIPLIER);
    this.runawayMinSamples =
      deps.runawayMinSamples ??
      Number(process.env.SHADOW_HARNESS_RUNAWAY_MIN_SAMPLES ?? DEFAULT_RUNAWAY_MIN_SAMPLES);
    this.alertCooldownMs =
      deps.alertCooldownMs ??
      Number(process.env.SHADOW_HARNESS_ALERT_COOLDOWN_MS ?? DEFAULT_ALERT_COOLDOWN_MS);
  }

  /**
   * Start the periodic comparison loop.
   * Safe to call multiple times — second call is a no-op.
   */
  start(): void {
    if (this._intervalHandle !== null) return;
    logger.info("ShadowHarness: comparison loop started", {
      compareWindowMs: this.compareWindowMs,
      silentCyclesBeforeAlert: this.silentCyclesBeforeAlert,
      runawayMultiplier: this.runawayMultiplier,
      runawayMinSamples: this.runawayMinSamples,
      alertCooldownMs: this.alertCooldownMs,
      programId: this.programId.toBase58(),
    });
    // Run immediately, then on the interval.
    void this._runCycle();
    this._intervalHandle = setInterval(() => {
      void this._runCycle();
    }, this.compareWindowMs);
    this._intervalHandle.unref();
  }

  /**
   * Stop the comparison loop.
   */
  stop(): void {
    if (this._intervalHandle === null) return;
    clearInterval(this._intervalHandle);
    this._intervalHandle = null;
    logger.info("ShadowHarness: comparison loop stopped");
  }

  /**
   * Run one comparison cycle. Called by the interval and exposed for testing.
   * Errors are fully swallowed.
   */
  async runCycle(): Promise<ShadowCompareResult> {
    return this._runCycle();
  }

  private async _runCycle(): Promise<ShadowCompareResult> {
    const toMs = this._now();
    const fromMs = toMs - this.compareWindowMs;
    const result = await this._compare(fromMs, toMs);
    this._lastResult = result;
    return result;
  }

  private async _compare(fromMs: number, toMs: number): Promise<ShadowCompareResult> {
    const windowMs = toMs - fromMs;

    let decisions: DecisionEntry[] = [];
    try {
      decisions = await this.readDecisions(fromMs, toMs);
    } catch (err) {
      logger.error("ShadowHarness: failed to read decisions", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const shadowTotal = decisions.length;

    // Aggregate shadow decisions by txType.
    const shadowByType: Record<string, number> = {};
    for (const d of decisions) {
      shadowByType[d.txType] = (shadowByType[d.txType] ?? 0) + 1;
    }

    let liveTotal = 0;
    let liveFetchOk = false;
    try {
      const fromSec = Math.floor(fromMs / 1000);
      const toSec = Math.floor(toMs / 1000);
      const signatures = await this.connection.getSignaturesForAddress(
        this.programId,
        { limit: 1000 },
      );
      // Filter by blockTime within the window.
      liveTotal = signatures.filter((s) => {
        const bt = s.blockTime;
        return bt !== null && bt !== undefined && bt >= fromSec && bt <= toSec;
      }).length;
      liveFetchOk = true;
    } catch (err) {
      logger.error("ShadowHarness: getSignaturesForAddress failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const divergencePct = computeDivergencePct(shadowTotal, liveTotal);

    // Per-txType metrics. Since we have no per-type breakdown for live txs in
    // v1, we record aggregate metrics under a synthetic "all" label and per-type
    // shadow-only counts. The gauge gets one entry per known txType.
    const allTxTypes: TxType[] = ["crank", "liquidation", "oracle", "adl"];
    for (const txType of allTxTypes) {
      const shadowTypeTotal = shadowByType[txType] ?? 0;
      // In v1 we don't have per-type live counts, so divergence per type is
      // only meaningful for shadow-only cases. We still emit the gauge so
      // dashboards have a stable label set.
      shadowDivergencePct.set({ txType }, shadowTypeTotal === 0 ? 0 : divergencePct);
    }

    // Aggregate comparison outcome metrics.
    const liveOnly = Math.max(0, liveTotal - shadowTotal);
    const shadowOnly = Math.max(0, shadowTotal - liveTotal);
    const matches = Math.min(shadowTotal, liveTotal);

    for (const txType of allTxTypes) {
      const frac = shadowTotal > 0 ? (shadowByType[txType] ?? 0) / shadowTotal : 0;
      const typeMatches = Math.round(matches * frac);
      const typeShadowOnly = Math.round(shadowOnly * frac);
      if (typeMatches > 0) {
        shadowMatchTotal.inc({ txType, result: "match" }, typeMatches);
      }
      if (typeShadowOnly > 0) {
        shadowMatchTotal.inc({ txType, result: "shadow_only" }, typeShadowOnly);
      }
    }
    if (liveOnly > 0) {
      // live_only cannot be attributed to a txType without per-tx RPC lookup.
      // Record under a synthetic "unknown" label so the counter is not lost.
      shadowMatchTotal.inc({ txType: "unknown" as TxType, result: "live_only" }, liveOnly);
    }

    logger.info("ShadowHarness: comparison cycle complete", {
      fromMs,
      toMs,
      shadowTotal,
      liveTotal,
      liveFetchOk,
      divergencePct: divergencePct.toFixed(2),
      consecutiveSilentCycles: this._consecutiveSilentCycles,
    });

    // C4 (CRITICAL): structural alert gates. The old `divergencePct > threshold`
    // gate fired on every cycle because liveTotal counts everyone's txs, not
    // just the live keeper's. The two gates below are structurally correct —
    // they don't depend on signer attribution and don't fire on legitimate
    // mixed live activity.
    //
    // Gate 1 — SHADOW SILENT: shadowTotal === 0 while live activity exists
    // for `silentCyclesBeforeAlert` consecutive cycles. The streak counter
    // suppresses one-off transient silence (startup, brief decision-log gap)
    // and only fires when shadow has been quiet for ~15 min (3 × 5 min).
    // RPC failures (liveFetchOk=false) neither advance nor reset the streak —
    // we genuinely don't know the live state.
    //
    // Gate 2 — SHADOW RUNAWAY: shadowTotal > runawayMultiplier * liveTotal
    // AND shadowTotal >= runawayMinSamples. Catches the inverse failure
    // (shadow over-fires, including the case where live keeper is dead and
    // submits nothing). Min-samples guard prevents N=1 vs N=0 alerts.
    if (liveFetchOk) {
      const shadowSilent = shadowTotal === 0 && liveTotal > 0;
      if (shadowSilent) {
        this._consecutiveSilentCycles++;
      } else {
        this._consecutiveSilentCycles = 0;
      }

      const now = this._now();
      const cooldownReady = now - this._lastAlertMs >= this.alertCooldownMs;

      if (this._consecutiveSilentCycles >= this.silentCyclesBeforeAlert && cooldownReady) {
        this._lastAlertMs = now;
        sendWarningAlert("Shadow keeper silent while live program is active", [
          { name: "Consecutive Silent Cycles", value: String(this._consecutiveSilentCycles), inline: true },
          { name: "Live Total", value: String(liveTotal), inline: true },
          { name: "Window", value: `${Math.round(windowMs / 60_000)} min`, inline: true },
        ]).catch(() => {});
      } else if (
        shadowTotal >= this.runawayMinSamples &&
        shadowTotal > this.runawayMultiplier * liveTotal &&
        cooldownReady
      ) {
        this._lastAlertMs = now;
        sendWarningAlert("Shadow keeper runaway: shadow fires vastly exceed live activity", [
          { name: "Shadow Total", value: String(shadowTotal), inline: true },
          { name: "Live Total", value: String(liveTotal), inline: true },
          { name: "Multiplier", value: `${this.runawayMultiplier}x`, inline: true },
          { name: "Window", value: `${Math.round(windowMs / 60_000)} min`, inline: true },
        ]).catch(() => {});
      }
    }

    return {
      windowMs,
      fromMs,
      toMs,
      shadowTotal,
      liveTotal,
      divergencePct,
      shadowByType,
    };
  }

  /**
   * Build the report object for the /shadow/report endpoint.
   * fromMs and toMs are optional — defaults to last comparison window.
   */
  async buildReport(fromMs?: number, toMs?: number): Promise<ShadowReportResult> {
    const now = this._now();
    const effectiveTo = toMs ?? now;
    const effectiveFrom = fromMs ?? effectiveTo - this.compareWindowMs;
    const result = await this._compare(effectiveFrom, effectiveTo);
    return {
      fromMs: result.fromMs,
      toMs: result.toMs,
      shadowTotal: result.shadowTotal,
      liveTotal: result.liveTotal,
      divergencePct: result.divergencePct,
      shadowByType: result.shadowByType,
    };
  }

  getLastResult(): ShadowCompareResult | null {
    return this._lastResult;
  }
}

/**
 * Singleton factory — call initSharedShadowHarness() from index.ts after the
 * connection is available.  sharedShadowHarness is null until that call.
 */
export let sharedShadowHarness: ShadowHarness | null = null;

export function initSharedShadowHarness(deps: ShadowHarnessDeps): ShadowHarness {
  sharedShadowHarness = new ShadowHarness(deps);
  return sharedShadowHarness;
}
