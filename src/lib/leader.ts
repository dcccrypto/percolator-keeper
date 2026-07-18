import os from "node:os";
import { createLogger } from "@percolatorct/shared";
import type { RedisLike } from "./redis-client.js";

const logger = createLogger("keeper:leader");

// C2 (CRITICAL): SET XX is value-blind — under a partition+heal sequence
// where a standby legitimately takes over after TTL expiry, a stale leader's
// blind XX renewal would overwrite the new leader's identity and produce
// split-brain. Atomic compare-and-pexpire: only refresh the TTL if the
// stored value still matches our identity. PEXPIRE returns 1 on success,
// the script returns 0 when our identity no longer owns the key.
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export type LeaderRole = "leader" | "standby" | "starting";

/**
 * #377: thrown when lease timings would make the single-writer guarantee
 * unenforceable. Constructing a LeaderLock is the last point at which this is
 * still cheap to catch — past it the misconfiguration is silent, and its only
 * symptom is two nodes writing on-chain at once.
 */
export class LeaderLockTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderLockTimingError";
  }
}

/**
 * #377: the lock's correctness rests on timings nothing previously checked.
 * `Number(process.env.X ?? default)` in index.ts yields NaN for any malformed
 * value, and NaN fails every comparison silently: `setTimeout(fn, NaN)` fires
 * on the next tick, turning renewal into a hot loop, while `ex: NaN` produces a
 * lease Redis will not honour.
 *
 * The ordering invariant matters more than the individual bounds. If
 * renewMs >= ttlMs the lease expires BEFORE the leader ever tries to renew, so
 * a standby acquires the freed key and promotes itself while the original node
 * still reports role() === "leader" — it does not learn otherwise until its
 * renewal finally runs and the fencing script rejects it. keeperSend gates
 * writes on that local role alone, so both nodes submit transactions in the
 * interval. Split-brain is then deterministic, not a race.
 */
function validateTiming(ttlMs: number, renewMs: number, pollMs: number): void {
  for (const [name, value] of [
    ["ttlMs", ttlMs],
    ["renewMs", renewMs],
    ["pollMs", pollMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new LeaderLockTimingError(
        `LeaderLock ${name} must be a finite positive number of milliseconds, got ${String(value)}. ` +
          `Check KEEPER_LEADER_LOCK_TTL_MS / KEEPER_LEADER_LOCK_RENEW_MS / KEEPER_STANDBY_POLL_MS.`,
      );
    }
  }

  if (renewMs >= ttlMs) {
    throw new LeaderLockTimingError(
      `LeaderLock renewMs (${renewMs}) must be strictly less than ttlMs (${ttlMs}) — otherwise the ` +
        `lease expires before the leader renews it and a standby can promote while this node still ` +
        `reports itself leader, allowing both to submit on-chain transactions (split-brain). ` +
        `Set KEEPER_LEADER_LOCK_RENEW_MS below KEEPER_LEADER_LOCK_TTL_MS (recommended: at most half).`,
    );
  }
}

export interface LeaderLockOptions {
  ttlMs?: number;
  renewMs?: number;
  pollMs?: number;
}

export interface StartOptions {
  network: string;
  onPromote: () => void;
  onDemote: (reason: string) => void;
}

export class LeaderLock {
  private readonly redis: RedisLike;
  private readonly identity: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;

  private _role: LeaderRole = "starting";
  private _renewTimer: NodeJS.Timeout | null = null;
  private _pollTimer: NodeJS.Timeout | null = null;
  private _renewFailures = 0;
  private _lockKey = "";
  private _onDemote: ((reason: string) => void) | null = null;
  // Captured at start() so _demote() can re-enter the standby poll loop — it is
  // the one transition that needs StartOptions but isn't handed them.
  private _opts: StartOptions | null = null;
  // Terminal kill-switch. Set true at the top of stop() BEFORE any await so an
  // already-queued _poll/_renew callback (a timer that fired into the event
  // loop microseconds before _clearTimers ran) cannot re-arm a timer or promote
  // a node the operator has shut down. Role alone can't express this: stop()
  // leaves the role as "standby", indistinguishable from a live standby.
  private _stopped = false;

  constructor(redis: RedisLike, identity: string, opts: LeaderLockOptions = {}) {
    const ttlMs = opts.ttlMs ?? 30_000;
    const renewMs = opts.renewMs ?? 10_000;
    const pollMs = opts.pollMs ?? 5_000;

    // #377: fail fast at construction. A lock built on unsafe timings cannot
    // provide the guarantee its callers assume, so refusing to boot is the only
    // safe outcome — the alternative is a silently split-brained keeper.
    validateTiming(ttlMs, renewMs, pollMs);

    // Renewal must also survive being LATE. A renewal firing at renewMs still
    // has to complete a Redis round-trip before ttlMs, so a margin thinner than
    // half the TTL leaves little room for a slow round-trip or event-loop stall.
    // This is a judgement call, not an invariant, so it warns rather than throws.
    if (renewMs > ttlMs / 2) {
      logger.warn("LeaderLock renew margin is thin — a slow Redis round-trip or event-loop stall could let the lease lapse", {
        ttlMs,
        renewMs,
        recommendedMaxRenewMs: ttlMs / 2,
      });
    }

    this.redis = redis;
    this.identity = identity;
    this.ttlMs = ttlMs;
    this.renewMs = renewMs;
    this.pollMs = pollMs;
  }

  role(): LeaderRole {
    return this._role;
  }

  start(opts: StartOptions): void {
    this._lockKey = `keeper:leader:${opts.network}`;
    this._onDemote = opts.onDemote;
    this._opts = opts;
    this._stopped = false;

    logger.info("LeaderLock starting", {
      identity: this.identity,
      lockKey: this._lockKey,
      ttlMs: this.ttlMs,
      renewMs: this.renewMs,
      pollMs: this.pollMs,
    });

    void this._tryAcquire(opts);
  }

  async stop(): Promise<void> {
    // Latch BEFORE _clearTimers() and before any await: a poll/renew callback
    // already past clearTimeout's reach will observe this and abort.
    this._stopped = true;
    this._clearTimers();

    if (this._role === "leader") {
      try {
        await this.redis.del(this._lockKey);
        logger.info("LeaderLock released (graceful stop)", { identity: this.identity });
      } catch (err) {
        logger.warn("LeaderLock release failed during stop", {
          identity: this.identity,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this._role = "standby";
  }

  private async _tryAcquire(opts: StartOptions): Promise<void> {
    const ttlSec = Math.ceil(this.ttlMs / 1000);

    try {
      const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, nx: true } as { ex: number; nx: true });

      if (result === "OK") {
        this._promote(opts);
      } else {
        this._enterStandby(opts);
      }
    } catch (err) {
      logger.warn("LeaderLock initial acquire error — entering standby", {
        identity: this.identity,
        error: err instanceof Error ? err.message : String(err),
      });
      this._enterStandby(opts);
    }
  }

  private _promote(opts: StartOptions): void {
    if (this._stopped) return;
    this._role = "leader";
    this._renewFailures = 0;
    logger.info("LeaderLock promoted to leader", { identity: this.identity });
    opts.onPromote();
    this._scheduleRenew(opts);
  }

  private _scheduleRenew(opts: StartOptions): void {
    this._renewTimer = setTimeout(async () => {
      await this._renew(opts);
    }, this.renewMs);
    this._renewTimer.unref?.();
  }

  private async _renew(opts: StartOptions): Promise<void> {
    if (this._stopped || this._role !== "leader") return;

    try {
      // C2 (CRITICAL): fenced renewal via Lua EVAL. The script atomically
      // verifies our identity still owns the lock before extending the TTL.
      // Returns 1 on success, 0 if the lease has been lost (identity mismatch
      // or key gone). Identity mismatch is a definitive loss of lease and
      // demotes IMMEDIATELY — it is NOT a transient error and must bypass the
      // 2-strike counter (which is reserved for thrown transport errors).
      const result = await this.redis.eval<number | null>(
        RENEW_SCRIPT,
        [this._lockKey],
        [this.identity, this.ttlMs],
      );

      if (result === 1) {
        this._renewFailures = 0;
        this._scheduleRenew(opts);
        return;
      }

      // result === 0: our identity no longer owns the key (or key vanished
      // mid-script). result === null/undefined: defensive — treat as lease
      // loss rather than ambiguous transient. In either case, demote now.
      if (result === 0 || result === null || result === undefined) {
        logger.warn("LeaderLock renew fencing failed (lease lost) — demoting immediately", {
          identity: this.identity,
          result,
        });
        this._demote("redis-lock-lost");
        return;
      }

      // Unexpected non-numeric/non-null result. Treat as transient so we do
      // not demote spuriously on, e.g., an upstream protocol oddity.
      this._renewFailures++;
      logger.warn("LeaderLock renew returned unexpected value — treating as transient", {
        identity: this.identity,
        renewFailures: this._renewFailures,
        result,
      });
      if (this._renewFailures >= 2) {
        this._demote("redis-renew-failed");
      } else {
        this._scheduleRenew(opts);
      }
    } catch (err) {
      // Transient transport error (network blip, 5xx, rate-limit). Preserve
      // the existing 2-strike tolerance — this is the path the M15 finding
      // discusses; tightening it is a separate PR.
      this._renewFailures++;
      logger.warn("LeaderLock renew error", {
        identity: this.identity,
        renewFailures: this._renewFailures,
        error: err instanceof Error ? err.message : String(err),
      });

      if (this._renewFailures >= 2) {
        logger.error("LeaderLock renew failed twice — demoting", { identity: this.identity });
        this._demote("redis-renew-failed");
      } else {
        this._scheduleRenew(opts);
      }
    }
  }

  private _enterStandby(opts: StartOptions): void {
    if (this._stopped) return;
    this._role = "standby";
    logger.info("LeaderLock entering standby", { identity: this.identity });
    this._schedulePoll(opts);
  }

  private _schedulePoll(opts: StartOptions): void {
    this._pollTimer = setTimeout(async () => {
      await this._poll(opts);
    }, this.pollMs);
    this._pollTimer.unref?.();
  }

  private async _poll(opts: StartOptions): Promise<void> {
    if (this._stopped || this._role !== "standby") return;

    try {
      const current = await this.redis.get(this._lockKey);
      // stop() may have run while we were awaiting Redis — never promote or
      // re-arm a timer on a stopped node.
      if (this._stopped || this._role !== "standby") return;

      if (current === null) {
        const ttlSec = Math.ceil(this.ttlMs / 1000);
        const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, nx: true } as { ex: number; nx: true });
        if (this._stopped || this._role !== "standby") return;
        if (result === "OK") {
          this._promote(opts);
          return;
        }
      }

      this._schedulePoll(opts);
    } catch (err) {
      logger.warn("LeaderLock standby poll error — staying in standby (fail-safe)", {
        identity: this.identity,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this._stopped) return;
      this._schedulePoll(opts);
    }
  }

  private _demote(reason: string): void {
    if (this._role !== "leader") return;
    this._role = "standby";
    this._clearTimers();
    logger.warn("LeaderLock demoted", { identity: this.identity, reason });
    // Re-arm the standby poll so the node rejoins the election and re-acquires
    // once Redis recovers and the lock frees — without this, a transient blip
    // parks the node forever (services stopped via onDemote, never restarted).
    // Scheduled BEFORE firing onDemote so recovery is armed even if the handler
    // throws; _clearTimers() above guarantees no timer is live (no double-arm),
    // and stop() (incl. one invoked from onDemote) latches _stopped and clears
    // this poll. Mirrors _enterStandby()'s initial-standby behavior.
    if (this._opts) this._schedulePoll(this._opts);
    this._onDemote?.(reason);
  }

  private _clearTimers(): void {
    if (this._renewTimer) {
      clearTimeout(this._renewTimer);
      this._renewTimer = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

export function makeIdentity(): string {
  return `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}
