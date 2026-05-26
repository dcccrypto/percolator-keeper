/**
 * Per-provider latency tracker for the RPC pool.
 *
 * Maintains a rolling 60-second window of (timestamp, latencyMs) samples.
 * P50/P99 are computed from sorted samples on every tick rather than
 * maintained incrementally — the window is small (<720 samples at 5s health
 * checks) so sort cost is negligible vs accuracy guarantees.
 *
 * Slot lag is tracked separately: each provider records the last slot it
 * observed from getSlot(). The lag is the difference between that provider's
 * last slot and the other provider's last slot (negative = this provider is
 * ahead). Health threshold uses absolute value.
 */

import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:rpc-health");

export interface LatencySample {
  ts: number;
  latencyMs: number;
}

export interface HealthSnapshot {
  p50Ms: number | null;
  p99Ms: number | null;
  consecutiveFails: number;
  lastSeenSlot: number | null;
  isHealthy: boolean;
  unhealthyReason?: string;
}

export interface RpcHealthConfig {
  /** Rolling window length in ms (default 60_000). */
  windowMs: number;
  /** P99 threshold above which provider is unhealthy (default 2000). */
  unhealthyP99Ms: number;
  /** Slot lag threshold (absolute value) above which provider is unhealthy (default 50). */
  unhealthySlotLag: number;
  /** Consecutive failed health checks before marking unhealthy (default 5). */
  unhealthyConsecutiveFails: number;
  /** Recovery window: must have P99 < recoveryP99Ms AND slot lag < recoverySlotLag AND 0 consecutive fails for this duration before marking healthy. */
  recoveryWindowMs: number;
  /** P99 threshold for recovery (default 1000ms). */
  recoveryP99Ms: number;
  /** Slot lag threshold for recovery (default 10). */
  recoverySlotLag: number;
}

const HEALTH_DEFAULTS: RpcHealthConfig = {
  windowMs: 60_000,
  unhealthyP99Ms: 2_000,
  unhealthySlotLag: 50,
  unhealthyConsecutiveFails: 5,
  recoveryWindowMs: 60_000,
  recoveryP99Ms: 1_000,
  recoverySlotLag: 10,
};

export class RpcProviderHealth {
  readonly config: RpcHealthConfig;
  private readonly _name: string;
  private readonly _now: () => number;

  private _samples: LatencySample[] = [];
  private _consecutiveFails = 0;
  private _lastSeenSlot: number | null = null;
  private _isHealthy = true;
  private _unhealthyReason: string | undefined = undefined;

  // Recovery tracking: when did we first enter a clean recovery window?
  private _recoveryStartMs: number | null = null;

  constructor(name: string, config: Partial<RpcHealthConfig> = {}, now?: () => number) {
    this._name = name;
    this.config = { ...HEALTH_DEFAULTS, ...config };
    this._now = now ?? (() => Date.now());
  }

  /** Record a successful latency sample. Resets consecutive-fail counter. */
  recordSuccess(latencyMs: number): void {
    const ts = this._now();
    this._samples.push({ ts, latencyMs });
    this._consecutiveFails = 0;
    this._pruneWindow(ts);
  }

  /** Record a failed call. Increments consecutive-fail counter. */
  recordFailure(): void {
    this._consecutiveFails++;
    this._samples = []; // clear latency data — stale samples are misleading on fail streaks
  }

  /** Record the last slot seen from this provider's getSlot(). */
  recordSlot(slot: number): void {
    this._lastSeenSlot = slot;
  }

  get lastSeenSlot(): number | null {
    return this._lastSeenSlot;
  }

  get consecutiveFails(): number {
    return this._consecutiveFails;
  }

  get isHealthy(): boolean {
    return this._isHealthy;
  }

  /**
   * Evaluate health given the other provider's last seen slot.
   * Returns true if the provider transitions from unhealthy→healthy (for logging).
   */
  evaluate(otherLastSeenSlot: number | null): boolean {
    const nowMs = this._now();
    this._pruneWindow(nowMs);

    const p99 = this._computePercentile(99);
    const slotLag = this._computeSlotLag(otherLastSeenSlot);

    // Determine the unhealthy reason if any condition is breached.
    const p99Breach = p99 !== null && p99 > this.config.unhealthyP99Ms;
    const lagBreach = slotLag !== null && Math.abs(slotLag) > this.config.unhealthySlotLag;
    const failBreach = this._consecutiveFails >= this.config.unhealthyConsecutiveFails;

    const anyBreach = p99Breach || lagBreach || failBreach;

    if (anyBreach) {
      const reasons: string[] = [];
      if (p99Breach) reasons.push(`P99=${p99!.toFixed(0)}ms > ${this.config.unhealthyP99Ms}ms`);
      if (lagBreach) reasons.push(`slotLag=${slotLag} > ±${this.config.unhealthySlotLag}`);
      if (failBreach) reasons.push(`consecutiveFails=${this._consecutiveFails} >= ${this.config.unhealthyConsecutiveFails}`);
      const reason = reasons.join("; ");

      if (this._isHealthy) {
        logger.warn("RPC provider became unhealthy", { provider: this._name, reason });
      }
      this._isHealthy = false;
      this._unhealthyReason = reason;
      this._recoveryStartMs = null; // reset recovery clock on any new breach
      return false;
    }

    // No breach: check recovery.
    if (!this._isHealthy) {
      // Check if we meet recovery criteria.
      const recoveryP99Ok = p99 === null || p99 < this.config.recoveryP99Ms;
      const recoveryLagOk = slotLag !== null && Math.abs(slotLag) < this.config.recoverySlotLag;
      const recoveryFailsOk = this._consecutiveFails === 0;

      if (recoveryP99Ok && recoveryLagOk && recoveryFailsOk) {
        if (this._recoveryStartMs === null) {
          // Start the recovery clock.
          this._recoveryStartMs = nowMs;
        }
        const elapsed = nowMs - this._recoveryStartMs;
        if (elapsed >= this.config.recoveryWindowMs) {
          this._isHealthy = true;
          this._unhealthyReason = undefined;
          this._recoveryStartMs = null;
          logger.warn("RPC provider recovered", { provider: this._name });
          return true;
        }
        // Still in recovery window — stay unhealthy.
      } else {
        // Recovery criteria not fully met; reset recovery clock.
        this._recoveryStartMs = null;
      }
      return false;
    }

    // Was already healthy.
    return false;
  }

  snapshot(): HealthSnapshot {
    return {
      p50Ms: this._computePercentile(50),
      p99Ms: this._computePercentile(99),
      consecutiveFails: this._consecutiveFails,
      lastSeenSlot: this._lastSeenSlot,
      isHealthy: this._isHealthy,
      unhealthyReason: this._unhealthyReason,
    };
  }

  computeP50(): number | null {
    return this._computePercentile(50);
  }

  computeP99(): number | null {
    return this._computePercentile(99);
  }

  computeSlotLag(otherLastSeenSlot: number | null): number | null {
    return this._computeSlotLag(otherLastSeenSlot);
  }

  private _pruneWindow(nowMs: number): void {
    const cutoff = nowMs - this.config.windowMs;
    // Find first non-expired index without allocating intermediate arrays.
    let firstValid = 0;
    while (firstValid < this._samples.length && this._samples[firstValid]!.ts < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this._samples = this._samples.slice(firstValid);
    }
  }

  private _computePercentile(pct: number): number | null {
    if (this._samples.length === 0) return null;
    const sorted = this._samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    // Nearest-rank method: ceil(pct/100 * n) - 1.
    const idx = Math.min(
      Math.ceil((pct / 100) * sorted.length) - 1,
      sorted.length - 1,
    );
    return sorted[idx]!;
  }

  private _computeSlotLag(otherLastSeenSlot: number | null): number | null {
    if (this._lastSeenSlot === null || otherLastSeenSlot === null) return null;
    // Positive = this provider is behind; negative = this provider is ahead.
    return otherLastSeenSlot - this._lastSeenSlot;
  }
}
