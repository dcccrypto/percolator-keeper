import { PublicKey, type Connection } from "@solana/web3.js";
import { createLogger } from "@percolatorct/shared";
import { AccountCache } from "./account-cache.js";
import { ReconnectBackoff } from "./stream-reconnect.js";
import { SlotTracker } from "./slot-tracker.js";

const logger = createLogger("keeper:account-loader");

const MAINNET_PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";
const DEFAULT_DROP_QUEUE_MAX = 10_000;
// C3: getMultipleAccountsInfo RPC accepts up to 100 pubkeys per call.
const SNAPSHOT_CHUNK_SIZE = 100;

export interface AccountUpdate {
  pubkey: string;
  data: Uint8Array;
  owner: string;
  slot: number;
}

export type UnsubscribeFn = () => void;

export interface LoaderStats {
  connected: boolean;
  lastSlot: number;
  eventsReceived: number;
  eventsDropped: number;
  reconnectCount: number;
}

export interface AccountLoaderOptions {
  /** Helius API key. */
  apiKey: string;
  /** Helius LaserStream gRPC endpoint. */
  endpoint: string;
  /** Additional individual account pubkeys to subscribe to (e.g. dex_pool accounts). */
  additionalAccounts?: string[];
  /** Program ID to subscribe all owned accounts. Defaults to the mainnet percolator program. */
  programId?: string;
  /** Callback invoked when stream slot drifts beyond threshold. */
  onDriftAlert?: (drift: number) => void;
  /** Injected getRpcSlot for SlotTracker; defaults to a no-op that never fires drift alerts. */
  getRpcSlot?: () => Promise<number>;
  /**
   * C3: optional RPC Connection used to backfill the cache on (re)connect.
   * The stream uses replay:false, so without a snapshot the cache stays empty
   * (or stale, after invalidateAll) until each tracked account is next mutated.
   * When absent, the loader logs a warning and proceeds without seeding.
   */
  connection?: Connection;
}

/**
 * Thin adapter interface over helius-laserstream.
 * Exists so the rest of the keeper never imports helius-laserstream directly —
 * only this file does, making it easy to swap implementations in tests.
 */
export interface StreamAdapter {
  start(
    opts: AccountLoaderOptions,
    onAccountUpdate: (update: AccountUpdate) => void,
    onSlotUpdate: (slot: number) => void,
    onError: (err: Error) => void,
  ): Promise<void>;
  stop(): void;
}

/**
 * Production adapter: wraps the helius-laserstream subscribe() function.
 * Lazy-imports the native module so this file can be loaded in test environments
 * where the .node binary is absent — tests inject a mock StreamAdapter.
 */
export class LaserStreamAdapter implements StreamAdapter {
  private handle: { cancel(): void } | null = null;

  async start(
    opts: AccountLoaderOptions,
    onAccountUpdate: (update: AccountUpdate) => void,
    onSlotUpdate: (slot: number) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    // Dynamic import keeps this out of the module graph when tests mock AccountLoader.
    const { subscribe, CommitmentLevel } = await import("helius-laserstream");

    const programId = opts.programId ?? MAINNET_PROGRAM_ID;

    const request = {
      accounts: {
        "keeper-program": {
          account: opts.additionalAccounts ?? [],
          owner: [programId],
          filters: [],
        },
      },
      slots: {
        "keeper-slots": { filterByCommitment: true },
      },
      commitment: CommitmentLevel.CONFIRMED,
    };

    const config = {
      apiKey: opts.apiKey,
      endpoint: opts.endpoint,
      replay: false,
    };

    this.handle = await subscribe(
      config,
      request,
      (update) => {
        if (update.account?.account) {
          const info = update.account.account;
          const slotRaw = update.account.slot;
          const slot =
            typeof slotRaw === "number"
              ? slotRaw
              : typeof (slotRaw as { toNumber?: () => number })?.toNumber ===
                  "function"
                ? (slotRaw as { toNumber: () => number }).toNumber()
                : Number(slotRaw ?? 0);

          const pubkeyBytes = info.pubkey;
          const ownerBytes = info.owner;
          if (!pubkeyBytes || !ownerBytes) return;

          // Encode as base58 so cache keys match the canonical Solana pubkey
          // representation used everywhere else in the keeper (PublicKey#toBase58
          // in CrankService, LiquidationService, market maps, /status responses).
          // Without this the fast-path cache lookups in discover()/scan won't hit.
          const pubkey = new PublicKey(pubkeyBytes).toBase58();
          const owner = new PublicKey(ownerBytes).toBase58();

          onAccountUpdate({
            pubkey,
            data: info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data ?? []),
            owner,
            slot,
          });
        }
        if (update.slot?.slot != null) {
          const raw = update.slot.slot;
          const slot =
            typeof raw === "number"
              ? raw
              : typeof (raw as { toNumber?: () => number })?.toNumber ===
                  "function"
                ? (raw as { toNumber: () => number }).toNumber()
                : Number(raw);
          onSlotUpdate(slot);
        }
      },
      (err) => onError(err),
    );
  }

  stop(): void {
    this.handle?.cancel();
    this.handle = null;
  }
}

export class AccountLoader {
  private readonly opts: Required<
    Pick<AccountLoaderOptions, "apiKey" | "endpoint" | "additionalAccounts" | "programId">
  > & AccountLoaderOptions;
  private readonly cache: AccountCache;
  private readonly backoff: ReconnectBackoff;
  private readonly slotTracker: SlotTracker;
  private readonly adapter: StreamAdapter;
  private readonly dropQueueMax: number;

  private running = false;
  private connected = false;
  private lastSlot = 0;
  private eventsReceived = 0;
  private eventsDropped = 0;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Bounded event queue for backpressure.
  private readonly queue: AccountUpdate[] = [];
  private draining = false;

  // Subscriber callbacks registered via onAccount().
  private readonly listeners: Array<(update: AccountUpdate) => void> = [];

  constructor(opts: AccountLoaderOptions, adapter?: StreamAdapter) {
    this.opts = {
      additionalAccounts: [],
      programId: MAINNET_PROGRAM_ID,
      ...opts,
    };
    this.adapter = adapter ?? new LaserStreamAdapter();
    this.cache = new AccountCache();
    this.backoff = new ReconnectBackoff();
    this.slotTracker = new SlotTracker(opts.onDriftAlert);
    this.dropQueueMax =
      parseInt(process.env.KEEPER_STREAM_DROP_QUEUE_MAX ?? "", 10) ||
      DEFAULT_DROP_QUEUE_MAX;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.opts.getRpcSlot) {
      this.slotTracker.start(this.opts.getRpcSlot);
    }

    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.adapter.stop();
    this.slotTracker.stop();
    this.connected = false;
  }

  /** Register a callback that receives every account update. Returns an unsubscribe fn. */
  onAccount(cb: (update: AccountUpdate) => void): UnsubscribeFn {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  getCache(): AccountCache {
    return this.cache;
  }

  /** A.1: expose the loader's program ID so callers can owner-verify cache reads. */
  getProgramId(): string {
    return this.opts.programId;
  }

  getStats(): LoaderStats {
    return {
      connected: this.connected,
      lastSlot: this.lastSlot,
      eventsReceived: this.eventsReceived,
      eventsDropped: this.eventsDropped,
      reconnectCount: this.reconnectCount,
    };
  }

  private async connect(): Promise<void> {
    try {
      // C3 (CRITICAL): pre-seed the cache via RPC BEFORE subscribing.
      // Rationale: the stream is started with replay:false and onStreamError
      // calls cache.invalidateAll(). Without this snapshot, every reconnect
      // leaves downstream consumers (LiquidationService, CrankService) reading
      // an empty cache until each tracked account is next mutated — risking
      // missed liquidations / stale decisions for an unbounded window.
      // Ordering: snapshot runs FIRST so it can't race against stream-driven
      // cache.set() calls and overwrite newer slot data with older RPC data.
      await this._snapshotKnownAccounts();

      await this.adapter.start(
        this.opts,
        (update) => this.enqueue(update),
        (slot) => {
          this.lastSlot = slot;
          this.slotTracker.onStreamSlot(slot);
        },
        (err) => this.onStreamError(err),
      );
      this.connected = true;
      this.backoff.reset();
      logger.info("AccountLoader: stream connected", {
        programId: this.opts.programId,
        additionalAccounts: this.opts.additionalAccounts?.length ?? 0,
      });
    } catch (err) {
      this.connected = false;
      // adapter.stop() is idempotent; safe whether the failure was in the
      // snapshot (no stream started) or the stream start (no stream running).
      this.adapter.stop();
      logger.warn("AccountLoader: connection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
  }

  /**
   * C3: fetch current account state for additionalAccounts via RPC and seed
   * the cache. Uses getMultipleAccountsInfoAndContext so every entry is stamped
   * with the RPC-context slot (not 0), which keeps slot-monotonicity guards in
   * AccountCache.get() and SlotTracker behaving correctly.
   *
   * Throws on RPC failure — caller (connect()) catches and reschedules.
   */
  private async _snapshotKnownAccounts(): Promise<void> {
    const accounts = this.opts.additionalAccounts ?? [];
    if (accounts.length === 0) return;

    if (!this.opts.connection) {
      logger.warn(
        "AccountLoader: RPC connection not provided — skipping cache snapshot. " +
          "After reconnect, cache will be empty until each tracked account is next mutated.",
        { additionalAccounts: accounts.length },
      );
      return;
    }

    const pubkeys = accounts.map((a) => new PublicKey(a));
    let seeded = 0;

    for (let i = 0; i < pubkeys.length; i += SNAPSHOT_CHUNK_SIZE) {
      const chunk = pubkeys.slice(i, i + SNAPSHOT_CHUNK_SIZE);
      const resp = await this.opts.connection.getMultipleAccountsInfoAndContext(
        chunk,
        { commitment: "confirmed" },
      );
      const slot = resp.context.slot;
      for (let j = 0; j < chunk.length; j++) {
        const info = resp.value[j];
        if (!info) continue;
        // info.data is a Node Buffer (which extends Uint8Array). Copy into a
        // detached Uint8Array so the cache entry doesn't share the Buffer pool.
        const raw = info.data as unknown as Uint8Array;
        const data = new Uint8Array(raw.byteLength);
        data.set(raw);
        this.cache.set(chunk[j].toBase58(), data, info.owner.toBase58(), slot);
        seeded++;
      }
    }

    logger.info("AccountLoader: cache snapshot seeded", {
      requested: accounts.length,
      seeded,
    });
  }

  private onStreamError(err: Error): void {
    if (!this.running) return;
    this.connected = false;
    logger.warn("AccountLoader: stream error — will reconnect", {
      error: err.message,
      consecutiveFailures: this.backoff.consecutiveFailures(),
    });
    this.adapter.stop();
    // Flush cache: events may have been missed during the gap.
    this.cache.invalidateAll();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.backoff.nextDelay();
    this.reconnectCount++;
    logger.info("AccountLoader: scheduling reconnect", {
      delayMs: delay,
      attempt: this.reconnectCount,
    });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.running) await this.connect();
    }, delay);
  }

  private enqueue(update: AccountUpdate): void {
    this.eventsReceived++;
    this.cache.set(update.pubkey, update.data, update.owner, update.slot);

    if (this.queue.length >= this.dropQueueMax) {
      // Drop the oldest event to make room — newer state is more valuable.
      this.queue.shift();
      this.eventsDropped++;
    }
    this.queue.push(update);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    // Process the queue synchronously in a microtask to avoid re-entrancy.
    Promise.resolve().then(() => {
      while (this.queue.length > 0) {
        const update = this.queue.shift()!;
        for (const listener of this.listeners) {
          try {
            listener(update);
          } catch (err) {
            logger.warn("AccountLoader: listener threw", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      this.draining = false;
    }).catch((err: unknown) => {
      logger.warn("AccountLoader: drain error", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.draining = false;
    });
  }
}
