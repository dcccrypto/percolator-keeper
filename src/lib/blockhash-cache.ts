import type { Connection } from "@solana/web3.js";
import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:blockhash-cache");

const DEFAULT_REFRESH_MS = 2_000;
const DEFAULT_MAX_SLOTS_REUSE = 60;

interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
  slot: number;
}

export class BlockhashCache {
  private readonly _connection: Connection;
  private readonly _refreshMs: number;
  private readonly _maxSlotsReuse: number;
  private _cached: CachedBlockhash | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _fetchPromise: Promise<void> | null = null;

  constructor(
    connection: Connection,
    opts?: { refreshMs?: number; maxSlotsReuse?: number },
  ) {
    this._connection = connection;
    this._refreshMs =
      opts?.refreshMs ??
      parseInt(process.env.KEEPER_BLOCKHASH_CACHE_MS ?? String(DEFAULT_REFRESH_MS), 10);
    this._maxSlotsReuse =
      opts?.maxSlotsReuse ??
      parseInt(process.env.KEEPER_BLOCKHASH_MAX_SLOTS_REUSE ?? String(DEFAULT_MAX_SLOTS_REUSE), 10);
  }

  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._refresh().catch((err) => {
        logger.warn("Blockhash cache background refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this._refreshMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get(): { blockhash: string; lastValidBlockHeight: number } {
    const now = Date.now();
    if (this._cached && this._isStillValid(this._cached, now)) {
      return {
        blockhash: this._cached.blockhash,
        lastValidBlockHeight: this._cached.lastValidBlockHeight,
      };
    }
    // Cached value is absent or too old — must fetch synchronously.
    // We do NOT await here; callers must await get() in async contexts.
    // For sync callers we throw to force them to use the async path.
    // In practice every keeper send path is async, so we expose a sync API
    // that throws on cache miss to make the contract explicit.
    throw new Error(
      "BlockhashCache: no valid cached blockhash — call await getAsync() or ensure start() is running",
    );
  }

  async getAsync(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const now = Date.now();
    if (this._cached && this._isStillValid(this._cached, now)) {
      return {
        blockhash: this._cached.blockhash,
        lastValidBlockHeight: this._cached.lastValidBlockHeight,
      };
    }
    await this._refresh();
    return {
      blockhash: this._cached!.blockhash,
      lastValidBlockHeight: this._cached!.lastValidBlockHeight,
    };
  }

  private _isStillValid(cached: CachedBlockhash, nowMs: number): boolean {
    const ageMs = nowMs - cached.fetchedAt;
    const ageSlots = ageMs / 400;
    return ageSlots <= this._maxSlotsReuse;
  }

  private async _refresh(): Promise<void> {
    if (this._fetchPromise) {
      return this._fetchPromise;
    }
    this._fetchPromise = this._doFetch().finally(() => {
      this._fetchPromise = null;
    });
    return this._fetchPromise;
  }

  private async _doFetch(): Promise<void> {
    const result = await this._connection.getLatestBlockhash({ commitment: "processed" });
    const slot = await this._connection.getSlot("processed");
    this._cached = {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      fetchedAt: Date.now(),
      slot,
    };
    logger.debug("Blockhash cache refreshed", {
      blockhash: result.blockhash.slice(0, 8),
      lastValidBlockHeight: result.lastValidBlockHeight,
    });
  }
}
