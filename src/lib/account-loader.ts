import { PublicKey } from "@solana/web3.js";
import { createLogger } from "@percolatorct/shared";
import { AccountCache } from "./account-cache.js";
import { ReconnectBackoff } from "./stream-reconnect.js";
import { SlotTracker } from "./slot-tracker.js";

const logger = createLogger("keeper:account-loader");

const MAINNET_PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";
const DEFAULT_DROP_QUEUE_MAX = 10_000;

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
      logger.warn("AccountLoader: initial connection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
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
