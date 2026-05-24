import os from "node:os";
import { createLogger } from "@percolatorct/shared";
import type { RedisLike } from "./redis-client.js";

const logger = createLogger("keeper:leader");

export type LeaderRole = "leader" | "standby" | "starting";

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

  constructor(redis: RedisLike, identity: string, opts: LeaderLockOptions = {}) {
    this.redis = redis;
    this.identity = identity;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.renewMs = opts.renewMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 5_000;
  }

  role(): LeaderRole {
    return this._role;
  }

  start(opts: StartOptions): void {
    this._lockKey = `keeper:leader:${opts.network}`;
    this._onDemote = opts.onDemote;

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
    if (this._role !== "leader") return;

    const ttlSec = Math.ceil(this.ttlMs / 1000);

    try {
      const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, xx: true } as { ex: number; xx?: true });

      if (result === "OK") {
        this._renewFailures = 0;
        this._scheduleRenew(opts);
      } else {
        this._renewFailures++;
        logger.warn("LeaderLock renew returned null (lock lost)", {
          identity: this.identity,
          renewFailures: this._renewFailures,
        });
        this._demote("redis-lock-lost");
      }
    } catch (err) {
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
    if (this._role !== "standby") return;

    try {
      const current = await this.redis.get(this._lockKey);

      if (current === null) {
        const ttlSec = Math.ceil(this.ttlMs / 1000);
        const result = await this.redis.set(this._lockKey, this.identity, { ex: ttlSec, nx: true } as { ex: number; nx: true });
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
      this._schedulePoll(opts);
    }
  }

  private _demote(reason: string): void {
    if (this._role !== "leader") return;
    this._role = "standby";
    this._clearTimers();
    logger.warn("LeaderLock demoted", { identity: this.identity, reason });
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
