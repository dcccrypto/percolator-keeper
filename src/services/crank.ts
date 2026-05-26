import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import {
  discoverMarkets,
  encodeKeeperCrank,
  encodeUpdateHyperpMark,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  ACCOUNTS_KEEPER_CRANK,
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  detectDexType,
  parseDexPool,
  type DiscoveredMarket,
  type DexType,
} from "@percolatorct/sdk";
import { config, getConnection, getFallbackConnection, loadKeypair, eventBus, createLogger, sendCriticalAlert, getSupabase } from "@percolatorct/shared";
import { OracleService } from "./oracle.js";
import { recordAttempt, recordLanded, recordFailed } from "../lib/sender-metrics.js";
import {
  txSentTotal,
  solSpentLamportsTotal,
  cycleDurationSeconds,
  txLandTimeSeconds,
  updateHyperpMarkTotal,
  updateHyperpMarkCu,
} from "../lib/metrics.js";
import type { AccountLoader } from "../lib/account-loader.js";
import { keeperSend, sharedBudget } from "../lib/keeper-send.js";
import { sharedTxQueue } from "../lib/tx-queue.js";

const logger = createLogger("keeper:crank");

/** Timeout for individual RPC calls — prevents indefinite hangs on unresponsive nodes. */
const RPC_TIMEOUT_MS = 15_000;

const KEEPER_SEND_OPTS = {
  skipPreflight: true,
  multiRpcBroadcast: true,
  // Crank instruction composition is stable; avoid one getLatestBlockhash +
  // one simulateTransaction RPC per crank. The shared sender falls back to a
  // 400k CU limit, which is above observed keeper crank usage.
  simulateForCU: false,
} as const;

/** Race a promise against a timeout. Rejects with a descriptive error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface MarketCrankState {
  market: DiscoveredMarket;
  lastCrankTime: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  /** Considered active if it has had at least one successful crank */
  isActive: boolean;
  /** Number of consecutive discoveries where this market was missing */
  missingDiscoveryCount: number;
  /** Permanently skip — market is not initialized on-chain (error 0x4) */
  permanentlySkipped?: boolean;
  /** Timestamp when the market was first permanently skipped (for cooldown) */
  permanentlySkippedAt?: number;
  /** How many times this market has been skipped for 0x4 across rediscoveries */
  skipCount?: number;
  /**
   * B1: latch so the "5 consecutive failures" Discord alert fires once per
   * failure-streak instead of only on the exact-5 transition. Cleared on
   * the next successful crank.
   */
  alertedAt5?: boolean;
  /**
   * PERC-465: Mainnet CA override for price lookups.
   * On devnet Quick Launch markets, collateralMint is a devnet mirror mint with no DEX data.
   * This field stores the original mainnet CA so Jupiter/DexScreener lookups use the right address.
   */
  mainnetCA?: string;
  /**
   * GH#1508: Admin-oracle market where the keeper is NOT the oracle authority.
   * The market owner must push prices themselves — we can't crank without a valid oracle price.
   * Cranking these causes OracleInvalid (0xc) errors. Skip until authority changes.
   * Unlike permanentlySkipped (0x4), this is re-checked on each discovery cycle.
   */
  foreignOracleSkipped?: boolean;
  /**
   * PERC-1254: Hyperp-mode market (indexFeedId=all-zeros) where authority_price_e6=0 on-chain
   * and fetchPrice returned null — cranking would cause OracleInvalid (0xc).
   * Reset to false once a price push succeeds or on-chain price is non-zero.
   */
  hyperpNoPriceSkipped?: boolean;
  /**
   * DEX pool address for HYPERP oracle mode.
   * Passed as account[1] to UpdateHyperpMark instruction.
   * Populated from Supabase markets.dex_pool_address or mainnet-markets.ts config.
   */
  dexPoolAddress?: string;
  /**
   * Cached HYPERP DEX pool metadata. Pool owner/vault accounts are static for a
   * given pool address, so fetching them on every crank just burns RPC quota.
   */
  dexPoolResolvedAddress?: string;
  dexPoolType?: DexType | "unknown";
  dexPoolRemainingAccounts?: PublicKey[];
}

/** Process items in batches with delay between batches.
 *  Each item is wrapped in try/catch so one failure doesn't kill the batch.
 *
 *  B2: each closure RETURNS its outcome (boolean ok | thrown) instead of
 *  mutating outer counters. Sums are computed after every Promise.all
 *  resolves so there is no read-modify-write race even under unusual
 *  microtask interleavings.
 */
// A.15: exported so the per-item counter correctness can be property-tested
// directly. Module-private would force testing via crankAll() with discovery
// + filtering wrapper overhead that would mask off-by-ones.
export async function processBatched<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<boolean>,
): Promise<{ succeeded: number; failed: number; errors: Map<string, Error> }> {
  const errors = new Map<string, Error>();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    type ItemOutcome =
      | { kind: "ok" }
      | { kind: "no" }
      | { kind: "threw"; itemKey: string; error: Error };
    const outcomes: ItemOutcome[] = await Promise.all(
      batch.map(async (item): Promise<ItemOutcome> => {
        try {
          const ok = await fn(item);
          return ok ? { kind: "ok" } : { kind: "no" };
        } catch (err) {
          const itemKey = String(item);
          const errorObj = err instanceof Error ? err : new Error(String(err));
          return { kind: "threw", itemKey, error: errorObj };
        }
      }),
    );
    for (const o of outcomes) {
      if (o.kind === "ok") succeeded++;
      else if (o.kind === "no") failed++;
      else {
        failed++;
        errors.set(o.itemKey, o.error);
        logger.error("Batch item failed", { item: o.itemKey, error: o.error.message });
      }
    }
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { succeeded, failed, errors };
}

export class CrankService {
  private markets = new Map<string, MarketCrankState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly inactiveIntervalMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly oracleService: OracleService;
  private lastCycleResult = { success: 0, failed: 0, skipped: 0 };
  private lastDiscoveryTime = 0;
  // BC1: Signature replay protection
  private recentSignatures = new Map<string, number>(); // signature -> timestamp
  private readonly signatureTTLMs = 60_000; // 60 seconds
  private _isRunning = false;
  private _cycling = false;
  private _cycleStartedAt = 0;
  private _stalePauseCheck?: (slabAddress: string) => boolean;
  // P1 FIX: Cache keypair at construction — was reading from disk on every crank cycle (every 30s)
  private readonly _keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
  // 6.2: Total crank cycles completed (exposed via getMetrics for health + MonitorService)
  private _totalCrankCycles = 0;
  // 6.2: Optional callback fired after each completed crank cycle
  private _onCrankCycle?: () => void;
  /** LaserStream account loader — injected for event-driven account discovery. */
  private readonly _accountLoader?: AccountLoader;
  /** Timestamp of last full getProgramAccounts re-discover when streaming is active. */
  private _lastFullRediscoverTime = 0;
  private readonly _fullRediscoverIntervalMs: number;

  constructor(oracleService: OracleService, intervalMs?: number, accountLoader?: AccountLoader) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs ?? config.crankIntervalMs;
    this.inactiveIntervalMs = config.crankInactiveIntervalMs;
    this.discoveryIntervalMs = config.discoveryIntervalMs;
    this._accountLoader = accountLoader;
    this._fullRediscoverIntervalMs =
      parseInt(process.env.KEEPER_FULL_REDISCOVER_INTERVAL_MS ?? "", 10) ||
      30 * 60_000; // 30 min default
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /** Register a callback to check if a market is paused due to stale oracle */
  setStalePauseCheck(check: (slabAddress: string) => boolean): void {
    this._stalePauseCheck = check;
  }

  /**
   * PERC-1650: Per-program 429 retry backoff for discoverMarkets calls.
   * Escalating delays: 3s → 9s → 27s → 81s before giving up.
   * Applied at the program level (outer loop).
   * Note: SDK fires all tier queries in parallel (~8 getProgramAccounts each),
   * so even a single program invocation is a burst. Start at 3s to give Helius
   * rate limiters time to recover before the next attempt.
   */
  private static readonly DISCOVER_429_BACKOFF_MS = [3_000, 9_000, 27_000, 81_000];

  /** Add up to 25% jitter to avoid thundering herd on retry. */
  private static jitter(ms: number): number {
    return ms + Math.floor(Math.random() * ms * 0.25);
  }

  async discover(): Promise<DiscoveredMarket[]> {
    // When the LaserStream loader is active and the feature flag is set,
    // use the cache for the fast path. The slow-path full re-discover still
    // runs every KEEPER_FULL_REDISCOVER_INTERVAL_MS (30 min default) so
    // new markets are eventually picked up even under streaming.
    if (
      process.env.KEEPER_USE_LASERSTREAM === "true" &&
      this._accountLoader
    ) {
      const now = Date.now();
      const needsFullRediscover =
        now - this._lastFullRediscoverTime >= this._fullRediscoverIntervalMs;
      if (!needsFullRediscover) {
        // Fast path: refresh account data for known markets from cache.
        const cache = this._accountLoader.getCache();
        const stats = this._accountLoader.getStats();
        const currentSlot = stats.lastSlot;
        // A.1: owner-verify every cache read against the loader's program ID
        // so a corrupted stream message at a slab pubkey can't inject bytes
        // into market state via the SDK parsers.
        const expectedOwner = this._accountLoader.getProgramId();
        let cacheHits = 0;
        for (const [, state] of this.markets) {
          const key = state.market.slabAddress.toBase58();
          const entry = cache.getOwnerVerified(key, currentSlot, expectedOwner);
          if (entry) {
            // Re-parse the slab from cached bytes so the market state reflects
            // the latest on-chain data without an RPC call.
            try {
              const { parseHeader, parseConfig, parseEngine, parseParams } = await import("@percolatorct/sdk");
              const data = entry.data;
              state.market.header = parseHeader(data);
              state.market.config = parseConfig(data);
              state.market.engine = parseEngine(data);
              state.market.params = parseParams(data);
              cacheHits++;
            } catch {
              // Ignore parse errors — market state stays at last known good.
            }
          }
        }
        this.lastDiscoveryTime = now;
        logger.debug("LaserStream fast-path discover complete", {
          knownMarkets: this.markets.size,
          cacheHits,
          nextFullRediscoverMs: this._lastFullRediscoverTime + this._fullRediscoverIntervalMs - now,
        });
        return Array.from(this.markets.values()).map((s) => s.market);
      }
      // Full rediscover time — fall through to standard getProgramAccounts path.
      this._lastFullRediscoverTime = now;
      logger.info("LaserStream: running periodic full re-discover", {
        intervalMs: this._fullRediscoverIntervalMs,
      });
    }

    // PERC-HOTFIX: If MARKETS_FILTER is set, skip expensive getProgramAccounts discovery.
    // Instead, batch-fetch the slab accounts via getMultipleAccountsInfo on the fallback
    // RPC — one roundtrip per 100 slabs vs N sequential calls on the primary RPC (B15).
    const marketsFilter = (process.env.MARKETS_FILTER ?? "").trim();
    const allFound: DiscoveredMarket[] = [];
    // Track which program IDs were successfully scanned. Used by the eviction
    // logic to avoid incrementing missingDiscoveryCount for markets whose
    // program scan failed due to transient RPC errors (not genuine removal).
    const succeededProgramIds = new Set<string>();
    if (marketsFilter) {
      const slabAddresses = marketsFilter.split(",").map(s => s.trim()).filter(Boolean);
      logger.info("Using MARKETS_FILTER — skipping getProgramAccounts discovery", { count: slabAddresses.length });
      // B14: parseHeader/parseConfig/parseEngine/parseParams are statically imported at the
      // top of this file — drop the redundant dynamic import that used to run on every call.
      // B15: batch via getMultipleAccountsInfo with a per-call timeout on the fallback RPC.
      const conn = getFallbackConnection();
      const pubkeys: Array<PublicKey | null> = slabAddresses.map((addr) => {
        try {
          return new PublicKey(addr);
        } catch {
          logger.warn("MARKETS_FILTER: invalid base58 slab address", { slab: addr.slice(0, 8) });
          return null;
        }
      });
      const FETCH_BATCH = 100;
      for (let i = 0; i < pubkeys.length; i += FETCH_BATCH) {
        const batch = pubkeys.slice(i, i + FETCH_BATCH).filter((p): p is PublicKey => p !== null);
        if (batch.length === 0) continue;
        let infos: Array<Awaited<ReturnType<typeof conn.getAccountInfo>>>;
        try {
          infos = await withTimeout(
            conn.getMultipleAccountsInfo(batch),
            RPC_TIMEOUT_MS,
            `getMultipleAccountsInfo(${batch.length})`,
          );
        } catch (err) {
          logger.warn("MARKETS_FILTER: getMultipleAccountsInfo failed for batch", {
            batchSize: batch.length,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (let j = 0; j < batch.length; j++) {
          const pubkey = batch[j]!;
          const info = infos[j];
          if (!info?.data) {
            logger.warn("MARKETS_FILTER: slab not found on-chain", { slab: pubkey.toBase58().slice(0, 8) });
            continue;
          }
          try {
            const data = new Uint8Array(info.data);
            const header = parseHeader(data);
            const marketConfig = parseConfig(data);
            const engine = parseEngine(data);
            const params = parseParams(data);
            allFound.push({
              slabAddress: pubkey,
              programId: info.owner,
              header,
              config: marketConfig,
              engine,
              params,
            });
            succeededProgramIds.add(info.owner.toBase58());
          } catch (e) {
            logger.warn("MARKETS_FILTER: failed to parse slab", {
              slab: pubkey.toBase58().slice(0, 8),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      // Fall through to Supabase fetch + this.markets population below
    } else {

    const programIds = config.allProgramIds;
    logger.info("Discovering markets", { programCount: programIds.length });
    const discoveryConn = getFallbackConnection();
    for (let progIdx = 0; progIdx < programIds.length; progIdx++) {
      const id = programIds[progIdx];
      let found: DiscoveredMarket[] = [];
      let programSuccess = false;

      for (let attempt = 0; attempt <= CrankService.DISCOVER_429_BACKOFF_MS.length; attempt++) {
        try {
          found = await discoverMarkets(discoveryConn, new PublicKey(id), { sequential: true, interTierDelayMs: 500 });
          programSuccess = true;
          logger.debug("Program scan complete", { programId: id, marketCount: found.length });
          break;
        } catch (e) {
          const is429 =
            e instanceof Error &&
            (e.message.includes("429") ||
              e.message.toLowerCase().includes("rate limit") ||
              e.message.toLowerCase().includes("too many requests"));
          if (is429 && attempt < CrankService.DISCOVER_429_BACKOFF_MS.length) {
            const delay = CrankService.jitter(CrankService.DISCOVER_429_BACKOFF_MS[attempt]);
            logger.warn("429 on discoverMarkets — backing off at program level", {
              programId: id,
              attempt: attempt + 1,
              delayMs: delay,
            });
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          logger.warn("Program scan failed", { programId: id, error: e, attempt: attempt + 1 });
          break;
        }
      }

      if (programSuccess) {
        succeededProgramIds.add(id);
        allFound.push(...found);
      }

      // Inter-program spacing: 3s base, helps avoid consecutive 429s on multi-program configs.
      // The SDK fires ~8 getProgramAccounts in parallel per program; 3s gives Helius rate
      // limiters enough window to recover before the next program's burst begins.
      if (progIdx < programIds.length - 1) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    } // end else (normal discovery)
    const discovered = allFound;
    this.lastDiscoveryTime = Date.now();
    logger.info("Market discovery complete", { totalMarkets: discovered.length });

    // Fetch dex_pool_address + mainnet_ca from Supabase for HYPERP pool lookups
    const slabAddresses = discovered.map((m) => m.slabAddress.toBase58());
    let dbMarkets: Map<string, { dexPoolAddress?: string; mainnetCA?: string }> = new Map();
    try {
      const { data, error } = await getSupabase()
        .from("markets")
        .select("slab_address, dex_pool_address, mainnet_ca")
        .in("slab_address", slabAddresses);
      if (error) {
        logger.warn("Supabase market metadata query error", { error: error.message });
      }
      if (data) {
        const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
        for (const row of data) {
          const pool = row.dex_pool_address ?? undefined;
          const ca = row.mainnet_ca ?? undefined;
          if (pool && !base58Re.test(pool)) {
            logger.warn("Invalid dex_pool_address from Supabase, ignoring", { slabAddress: row.slab_address, dexPoolAddress: pool });
            continue;
          }
          if (ca && !base58Re.test(ca)) {
            logger.warn("Invalid mainnet_ca from Supabase, ignoring", { slabAddress: row.slab_address, mainnetCA: ca });
            continue;
          }
          dbMarkets.set(row.slab_address, {
            dexPoolAddress: pool,
            mainnetCA: ca,
          });
        }
      }
    } catch (err) {
      logger.warn("Failed to fetch market metadata from Supabase", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const discoveredKeys = new Set<string>();
    for (const market of discovered) {
      const key = market.slabAddress.toBase58();
      discoveredKeys.add(key);
      const dbMeta = dbMarkets.get(key);
      if (!this.markets.has(key)) {
        this.markets.set(key, {
          market,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          isActive: true,
          missingDiscoveryCount: 0,
          dexPoolAddress: dbMeta?.dexPoolAddress,
          mainnetCA: dbMeta?.mainnetCA,
        });
      } else {
        const state = this.markets.get(key)!;
        state.market = market;
        // Update pool address and mainnetCA from Supabase on every discovery.
        // Use explicit undefined check so a DB null/removal clears stale values (not just truthy-set).
        if (dbMeta !== undefined) {
          state.dexPoolAddress = dbMeta.dexPoolAddress;
          state.mainnetCA = dbMeta.mainnetCA;
        }
        state.missingDiscoveryCount = 0;
        // P1 FIX: Reset consecutiveFailures on rediscovery so markets can recover.
        // Previously, a market that hit MAX_CONSECUTIVE_FAILURES was dead until keeper restart.
        // Now it gets a fresh chance every discovery cycle (default 5min).
        if (state.consecutiveFailures > 0) {
          logger.debug("Resetting consecutive failures on rediscovery", {
            slabAddress: key,
            previousFailures: state.consecutiveFailures,
          });
          state.consecutiveFailures = 0;
          state.isActive = true;
        }
        // GH#1508: Reset foreignOracleSkipped on re-discovery — oracle authority may have changed.
        // crankMarket() will re-check and re-set it if the keeper is still not the authority.
        if (state.foreignOracleSkipped) {
          state.foreignOracleSkipped = false;
          logger.debug("Re-checking foreign oracle skip on rediscovery", { slabAddress: key });
        }
        // PERC-1254: Reset hyperpNoPriceSkipped on re-discovery so we retry fetchPrice.
        // Oracle data may have become available since the last skip (e.g. DEX pool created).
        if (state.hyperpNoPriceSkipped) {
          state.hyperpNoPriceSkipped = false;
          logger.debug("PERC-1254: Re-checking Hyperp no-price skip on rediscovery", { slabAddress: key });
        }
        // PERC-381: Only re-enable permanently skipped (0x4) markets after a long cooldown
        // to avoid crank→skip→rediscover→re-enable→crank thrash loop on stale slabs.
        // Cooldown increases exponentially with skip count (1h, 2h, 4h, ... capped at 24h).
        if (state.permanentlySkipped && state.permanentlySkippedAt) {
          const skipCount = state.skipCount ?? 1;
          const cooldownMs = Math.min(skipCount * 3_600_000, 24 * 3_600_000); // 1h per skip, max 24h
          const elapsed = Date.now() - state.permanentlySkippedAt;
          if (elapsed >= cooldownMs) {
            state.permanentlySkipped = false;
            state.consecutiveFailures = 0;
            logger.info("Re-enabling permanently skipped market after cooldown", {
              slabAddress: key,
              cooldownMs,
              skipCount,
              elapsedMs: elapsed,
            });
          } else {
            logger.debug("Permanently skipped market still in cooldown", {
              slabAddress: key,
              remainingMs: cooldownMs - elapsed,
              skipCount,
            });
          }
        }
      }
    }

    // Bug 17: Track markets missing from discovery, remove after 3 consecutive misses.
    // Only increment missingDiscoveryCount when the market's owning program was
    // successfully scanned. If the program scan failed (transient RPC error), the
    // market's absence proves nothing — don't count it toward eviction.
    for (const [key, state] of this.markets) {
      if (!discoveredKeys.has(key)) {
        const ownerProgram = state.market.programId.toBase58();
        if (succeededProgramIds.has(ownerProgram)) {
          state.missingDiscoveryCount++;
          if (state.missingDiscoveryCount >= 3) {
            logger.warn("Removing dead market", { slabAddress: key, missingCount: state.missingDiscoveryCount });
            this.markets.delete(key);
          }
        } else {
          logger.debug("Skipping eviction — owning program scan failed", {
            slabAddress: key,
            programId: ownerProgram,
          });
        }
      }
    }

    return discovered;
  }

  private isAdminOracle(market: DiscoveredMarket): boolean {
    return !market.config.oracleAuthority.equals(PublicKey.default);
  }

  /**
   * True HYPERP mode: oracle_authority == [0;32] AND index_feed_id == [0;32].
   * Uses toBytes() check — compatible with both real PublicKey and test mocks.
   */
  private isHyperpOracle(market: DiscoveredMarket): boolean {
    const feedBytes = market.config.indexFeedId.toBytes();
    const isZeroFeed = feedBytes.every((b: number) => b === 0);
    return !this.isAdminOracle(market) && isZeroFeed;
  }

  private async resolveHyperpPoolRemainingAccounts(
    connection: Connection,
    state: MarketCrankState,
    poolKey: PublicKey,
    slabAddress: string,
  ): Promise<PublicKey[]> {
    const poolAddress = poolKey.toBase58();
    if (
      state.dexPoolResolvedAddress === poolAddress &&
      state.dexPoolRemainingAccounts !== undefined
    ) {
      return state.dexPoolRemainingAccounts;
    }

    state.dexPoolResolvedAddress = undefined;
    state.dexPoolType = undefined;
    state.dexPoolRemainingAccounts = undefined;

    let poolAccountInfo: Awaited<ReturnType<Connection["getAccountInfo"]>>;
    try {
      poolAccountInfo = await withTimeout(
        connection.getAccountInfo(poolKey),
        RPC_TIMEOUT_MS,
        `getAccountInfo(${poolAddress})`,
      );
    } catch (err) {
      logger.warn("HYPERP: failed to fetch pool account info for vault detection — sending without remaining accounts", {
        slabAddress,
        poolAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    if (poolAccountInfo === null) {
      logger.warn("HYPERP: pool account not found for vault detection — sending without remaining accounts", {
        slabAddress,
        poolAddress,
      });
      return [];
    }

    const dexType = detectDexType(poolAccountInfo.owner);
    const remainingAccounts: PublicKey[] = [];

    if (dexType === "pumpswap") {
      // parseDexPool reads baseVault (offset 131) and quoteVault (offset 163)
      const poolData = new Uint8Array(poolAccountInfo.data);
      const poolInfo = parseDexPool("pumpswap", poolKey, poolData);
      if (poolInfo.baseVault && poolInfo.quoteVault) {
        remainingAccounts.push(poolInfo.baseVault, poolInfo.quoteVault);
      } else {
        logger.warn("HYPERP: PumpSwap pool missing vault pubkeys in parsed data — caching empty remaining accounts", {
          slabAddress,
          poolAddress,
        });
      }
    } else if (dexType === "meteora-dlmm") {
      // reserve_y (vault_y) is stored at byte offset 184 in the LbPair account
      const METEORA_DLMM_OFF_RESERVE_Y = 184;
      const METEORA_DLMM_MIN_LEN = METEORA_DLMM_OFF_RESERVE_Y + 32;
      if (poolAccountInfo.data.length >= METEORA_DLMM_MIN_LEN) {
        const reserveY = new PublicKey(
          poolAccountInfo.data.slice(METEORA_DLMM_OFF_RESERVE_Y, METEORA_DLMM_OFF_RESERVE_Y + 32),
        );
        remainingAccounts.push(reserveY);
      } else {
        logger.warn("HYPERP: Meteora DLMM pool data too short to read reserve_y — caching empty remaining accounts", {
          slabAddress,
          poolAddress,
          dataLength: poolAccountInfo.data.length,
          required: METEORA_DLMM_MIN_LEN,
        });
      }
    } else if (dexType === null) {
      logger.warn("HYPERP: unknown DEX pool owner — caching empty remaining accounts", {
        slabAddress,
        poolAddress,
        owner: poolAccountInfo.owner.toBase58(),
      });
    }
    // Raydium CLMM: no remaining accounts needed — on-chain price is read
    // directly from the pool's sqrt_price_x64 field without vault lookups.

    state.dexPoolResolvedAddress = poolAddress;
    state.dexPoolType = dexType ?? "unknown";
    state.dexPoolRemainingAccounts = remainingAccounts;

    logger.info("HYPERP: cached DEX pool metadata for cranking", {
      slabAddress,
      poolAddress,
      dexType: state.dexPoolType,
      remainingAccounts: remainingAccounts.length,
    });

    return remainingAccounts;
  }

  /** Check if a market is due for cranking based on activity */
  private isDue(state: MarketCrankState): boolean {
    const interval = state.isActive ? this.intervalMs : this.inactiveIntervalMs;
    return Date.now() - state.lastCrankTime >= interval;
  }

  async crankMarket(slabAddress: string): Promise<boolean> {
    const state = this.markets.get(slabAddress);
    if (!state) {
      logger.warn("Market not found", { slabAddress });
      return false;
    }

    const { market } = state;

    try {
      const connection = getConnection();
      const keypair = this._keypair;
      const programId = market.programId;

      // ── HYPERP mode: permissionless on-chain oracle ──────────────────────
      // True HYPERP markets (oracle_authority=[0;32], index_feed_id=[0;32]) use
      // UpdateHyperpMark to read DEX pool state directly on-chain. No off-chain
      // price push needed — the instruction reads Raydium/PumpSwap/Meteora pools.
      if (this.isHyperpOracle(market)) {
        const instructions: TransactionInstruction[] = [];

        // UpdateHyperpMark: accounts = [slab(writable), dex_pool, clock, ...remaining]
        //
        // PERC-SetDexPool security model:
        //   1. PRIMARY: read dexPool from on-chain config (set by admin via SetDexPool).
        //      An attacker who compromises Supabase service_role cannot override this.
        //   2. FALLBACK: if on-chain dexPool is null (old slab / SetDexPool not yet called),
        //      fall back to state.dexPoolAddress (from Supabase) with a migration warning.
        //      The on-chain program will reject the UpdateHyperpMark with OracleInvalid anyway
        //      until SetDexPool is called, so the fallback is only for the transition period.
        //
        // If both values exist but differ, log a security alert and use the on-chain value.
        const onChainDexPool = state.market.config.dexPool;
        let effectiveDexPoolAddress: string | undefined;

        if (onChainDexPool) {
          // SECURE PATH: on-chain pinned pool — use this exclusively
          const onChainStr = onChainDexPool.toBase58();
          if (state.dexPoolAddress && state.dexPoolAddress !== onChainStr) {
            logger.warn("SECURITY: Supabase dex_pool_address differs from on-chain pinned dexPool — " +
              "using on-chain value. If this is unexpected, admin must call SetDexPool to update.", {
              slabAddress,
              onChainDexPool: onChainStr,
              supabaseDexPool: state.dexPoolAddress,
            });
          }
          effectiveDexPoolAddress = onChainStr;
        } else if (state.dexPoolAddress) {
          // FALLBACK: on-chain dexPool not set yet (old slab or SetDexPool not called)
          // The program will reject UpdateHyperpMark with OracleInvalid until admin calls SetDexPool.
          logger.debug("HYPERP: using Supabase dex_pool_address (on-chain dexPool not set — admin must call SetDexPool)", {
            slabAddress,
            dexPoolAddress: state.dexPoolAddress,
          });
          effectiveDexPoolAddress = state.dexPoolAddress;
        }

        if (!effectiveDexPoolAddress) {
          if (!state.hyperpNoPriceSkipped) {
            state.hyperpNoPriceSkipped = true;
            logger.warn("HYPERP market has no dex_pool_address configured — skipping UpdateHyperpMark. " +
              "Admin must call SetDexPool for this market.", {
              slabAddress,
            });
          }
          // No pool address → skip oracle update but still crank (funding/liquidation still work)
        } else {
          // Build UpdateHyperpMark instruction (tag 34).
          const hyperpData = encodeUpdateHyperpMark();
          const poolKey = new PublicKey(effectiveDexPoolAddress);

          // Build accounts: [slab(writable), pool(readonly), clock(readonly), ...remaining]
          const hyperpKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
            { pubkey: market.slabAddress, isSigner: false, isWritable: true },
            { pubkey: poolKey, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          ];

          const remainingAccounts = await this.resolveHyperpPoolRemainingAccounts(
            connection,
            state,
            poolKey,
            slabAddress,
          );
          for (const pubkey of remainingAccounts) {
            hyperpKeys.push({ pubkey, isSigner: false, isWritable: false });
          }

          instructions.push(buildIx({ programId, keys: hyperpKeys, data: hyperpData }));
          state.hyperpNoPriceSkipped = false;
        }

        // Crank instruction (always — handles funding, liquidation, GC)
        const crankData = encodeKeeperCrank({ callerIdx: 65535 });
        const oracleKey = market.slabAddress; // HYPERP: oracle account is the slab itself
        const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
          keypair.publicKey,
          market.slabAddress,
          SYSVAR_CLOCK_PUBKEY,
          oracleKey,
        ]);
        instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

        const __t0 = Date.now();
        recordAttempt();
        let sig: string;
        const __dexType = state.dexPoolType ?? "unknown";
        try {
          // UpdateHyperpMark pushes oracle data from the DEX pool on-chain.
          // txType="crank" for budget/priority-fee tiering; lane="oracle" because
          // this instruction is oracle data, not a routine funding crank.
          const sendResult = await sharedTxQueue.enqueue("oracle", () =>
            keeperSend(connection, instructions, [keypair], "crank", sharedBudget, 3, KEEPER_SEND_OPTS),
          );
          if (!sendResult) {
            recordFailed();
            updateHyperpMarkTotal.inc({ dex_type: __dexType, result: "skipped" });
            return false;
          }
          sig = sendResult.signature;
          const __tip = process.env.USE_HELIUS_SENDER === "true"
            ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
            : 0;
          const __elapsed = Date.now() - __t0;
          recordLanded(__elapsed, __tip);
          txSentTotal.inc({ result: "success", type: "crank" });
          txLandTimeSeconds.observe({ type: "crank", lane: __tip > 0 ? "jito" : "sender" }, __elapsed / 1000);
          if (__tip > 0) solSpentLamportsTotal.inc({ type: "crank" }, __tip);
          updateHyperpMarkTotal.inc({ dex_type: __dexType, result: "success" });
          // Emit CU histogram when the instruction list includes UpdateHyperpMark
          // (instructions.length > 1 means the pool address was resolved and the
          // instruction was actually appended; length === 1 is crank-only / no-pool path).
          if (sendResult.simulatedCu > 0 && instructions.length > 1) {
            updateHyperpMarkCu.observe({ dex_type: __dexType }, sendResult.simulatedCu);
          }
        } catch (err) {
          recordFailed();
          updateHyperpMarkTotal.inc({ dex_type: __dexType, result: "failed" });
          throw err;
        }
        state.lastCrankTime = Date.now();
        state.successCount++;
        state.consecutiveFailures = 0;
        state.alertedAt5 = false; // B1: reset alert latch on success
        state.isActive = true;
        // B10: do NOT reset failureCount — it is the lifetime counter exposed
        // by /status, used to compute the long-run error rate. Resetting it on
        // every success made the rate read 0 forever; only the per-streak
        // counter (consecutiveFailures) should reset.
        eventBus.publish("crank.success", slabAddress, { signature: sig });
        return true;
      }

      // Admin-push oracle was removed by percolator-prog Phase G — all markets
      // now read Pyth/Chainlink/Hyperp directly. The foreign-oracle skip, the
      // bundled price-push, and the admin-hyperp guard that used to live here
      // are no longer reachable (oracle_authority is zero on all new markets
      // and the on-chain PushOraclePrice handler was deleted).

      const instructions: TransactionInstruction[] = [];

      // Crank instruction
      const crankData = encodeKeeperCrank({ callerIdx: 65535 });

      let oracleKey: PublicKey;
      if (this.isAdminOracle(market)) {
        oracleKey = market.slabAddress;
      } else {
        const feedHex = Array.from(market.config.indexFeedId.toBytes())
          .map(b => b.toString(16).padStart(2, "0")).join("");
        oracleKey = derivePythPushOraclePDA(feedHex)[0];
      }

      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        keypair.publicKey,
        market.slabAddress,
        SYSVAR_CLOCK_PUBKEY,
        oracleKey,
      ]);
      instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

      // PERC-204: Use keeper-optimized send (skipPreflight + multi-RPC + tight CU)
      const __t0 = Date.now();
      recordAttempt();
      let sig: string;
      try {
        const sendResult = await sharedTxQueue.enqueue("crank", () =>
          keeperSend(connection, instructions, [keypair], "crank", sharedBudget, 3, KEEPER_SEND_OPTS),
        );
        if (!sendResult) {
          recordFailed();
          return false;
        }
        sig = sendResult.signature;
        const __tip = process.env.USE_HELIUS_SENDER === "true"
          ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
          : 0;
        const __elapsed = Date.now() - __t0;
        recordLanded(__elapsed, __tip);
        txSentTotal.inc({ result: "success", type: "crank" });
        txLandTimeSeconds.observe({ type: "crank", lane: __tip > 0 ? "jito" : "sender" }, __elapsed / 1000);
        if (__tip > 0) solSpentLamportsTotal.inc({ type: "crank" }, __tip);
      } catch (err) {
        recordFailed();
        throw err;
      }

      // BC1: Track signature to prevent replay attacks
      this.recentSignatures.set(sig, Date.now());

      state.lastCrankTime = Date.now();
      state.successCount++;
      state.consecutiveFailures = 0;
      state.alertedAt5 = false; // B1: reset alert latch on success
      state.isActive = true;
      // B10: see HYPERP branch above — preserve lifetime failureCount.

      eventBus.publish("crank.success", slabAddress, { signature: sig });
      return true;
    } catch (err) {
      state.failureCount++;
      state.consecutiveFailures++;
      txSentTotal.inc({ result: "fail", type: "crank" });

      const errMsg = err instanceof Error ? err.message : String(err);

      // P1 FIX: Detect InsufficientDexLiquidity (error 0x25 = 37) specifically.
      // This is a permanent program-level rejection — the DEX pool doesn't meet the
      // MIN_DEX_QUOTE_LIQUIDITY threshold. Log clearly so operators know the fix is
      // to either change the pool or redeploy the program with a lower threshold.
      if (errMsg.includes("Custom\":37") || errMsg.includes("custom program error: 0x25")) {
        logger.error("InsufficientDexLiquidity — DEX pool does not meet program minimum liquidity threshold. " +
          "Fix: use a pool with more liquidity, or redeploy the program with a lower MIN_DEX_QUOTE_LIQUIDITY.", {
          slabAddress,
          dexPoolAddress: state.dexPoolAddress ?? "none",
          programId: market.programId.toBase58(),
          consecutiveFailures: state.consecutiveFailures + 1,
        });
      }

      // Detect NotInitialized (error 0x4) — permanently skip these markets
      // PERC-381: Track skip count and timestamp for exponential cooldown on rediscovery
      if (errMsg.includes("custom program error: 0x4")) {
        state.permanentlySkipped = true;
        state.permanentlySkippedAt = Date.now();
        state.skipCount = (state.skipCount ?? 0) + 1;
        state.isActive = false;
        logger.warn("Market slab size mismatch (0x4 InvalidSlabLen) — permanently skipping. " +
          "Fix: run `npx tsx scripts/reinit-slab.ts --slab <ADDRESS>` to recreate with correct size.", {
          slabAddress,
          programId: market.programId.toBase58(),
          skipCount: state.skipCount,
        });
        return false;
      }

      // Mark inactive after 10 consecutive failures regardless of lifetime success
      if (state.consecutiveFailures >= 10) {
        state.isActive = false;
      }
      
      logger.error("Crank failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        consecutiveFailures: state.consecutiveFailures,
        market: market.slabAddress.toBase58(),
        programId: market.programId.toBase58(),
      });
      
      // B1: alert when consecutive failures crosses 5 (changed from `=== 5`
      // so a jump 4 → 6 still fires) and latch `alertedAt5` so we don't
      // re-alert every cycle while still failing. Latch clears on next success.
      if (state.consecutiveFailures >= 5 && !state.alertedAt5) {
        state.alertedAt5 = true;
        sendCriticalAlert("Crank experiencing consecutive failures", [
          { name: "Market", value: slabAddress.slice(0, 12), inline: true },
          { name: "Consecutive Failures", value: state.consecutiveFailures.toString(), inline: true },
          { name: "Error", value: (err instanceof Error ? err.message : String(err)).slice(0, 100), inline: false },
        ])?.catch(() => {});
      }
      
      eventBus.publish("crank.failure", slabAddress, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async crankAll(): Promise<{ success: number; failed: number; skipped: number }> {
  const _crankAllStart = Date.now();
  let success = 0;
  let failed = 0;

  // NEW: split skipped into categories
  let skippedPermanent = 0;
  let skippedForeignOracle = 0;
  let skippedHyperpNoPrice = 0;
  let skippedStalePaused = 0;
  let skippedFailures = 0;
  let skippedNotDue = 0;

  const MAX_CONSECUTIVE_FAILURES = 10;

  // GH#1251: Load the keeper key once here so we can check authority live.
  // We re-evaluate foreign oracle authority at crankAll time rather than relying on
  // state.foreignOracleSkipped.  After discover() resets the flag, crankMarket() would
  // return false (and set failed++) instead of skipped.  Checking here means those markets
  // are categorised as skipped before they even enter the crank queue.
  const keeperKey = this._keypair.publicKey;

  const toCrank: string[] = [];

  for (const [slabAddress, state] of this.markets) {
    if (state.permanentlySkipped) {
      skippedPermanent++;
      txSentTotal.inc({ result: "drop", type: "crank" });
      continue;
    }
    // GH#1251: Live authority check — covers both the steady-state case (flag already set)
    // and the post-discover() window where the flag was just reset.
    // Any admin-oracle market where the keeper is NOT the oracle authority is always skipped.
    if (
      this.isAdminOracle(state.market) &&
      !keeperKey.equals(state.market.config.oracleAuthority)
    ) {
      // Keep the flag in sync so crankMarket() also fast-paths correctly.
      if (!state.foreignOracleSkipped) {
        state.foreignOracleSkipped = true;
        // GH#1748: Use WARN (not debug) on first detection, include both keys so ops can
        // immediately diagnose a CRANK_KEYPAIR mismatch without reading the source.
        logger.warn("crankAll: admin-oracle market skipped — keeper is NOT the oracle authority (key mismatch). " +
          "Fix: set CRANK_KEYPAIR to the oracle authority key, or update the on-chain oracle authority.", {
          slabAddress,
          marketOracleAuthority: state.market.config.oracleAuthority.toBase58(),
          keeperPublicKey: keeperKey.toBase58(),
        });
      } else {
        logger.debug("crankAll: re-skipping foreign oracle market (flag was reset by discover)", {
          slabAddress,
          marketOracleAuthority: state.market.config.oracleAuthority.toBase58(),
          keeperPublicKey: keeperKey.toBase58(),
        });
      }
      skippedForeignOracle++;
      continue;
    }
    // PERC-1254: Live Hyperp-no-price check.
    // Condition: admin-oracle market where keeper IS the authority, indexFeedId=all-zeros
    // (Hyperp mode), and on-chain authority_price_e6 is still 0.  Sending KeeperCrank in
    // this state causes OracleInvalid (0xc).  Skip eagerly — crankMarket() would return
    // false and the batch counts it as failed rather than skipped.
    // The flag (state.hyperpNoPriceSkipped) is set here for the first time on new markets
    // so crankMarket's guard also short-circuits on subsequent calls.
    {
      const isHyperpAdminOwner =
        this.isAdminOracle(state.market) &&
        keeperKey.equals(state.market.config.oracleAuthority) &&
        state.market.config.indexFeedId.toBytes().every((b: number) => b === 0);
      const onChainPriceZero = (state.market.config.authorityPriceE6 ?? BigInt(0)) === BigInt(0);
      if (isHyperpAdminOwner && onChainPriceZero) {
        if (!state.hyperpNoPriceSkipped) {
          state.hyperpNoPriceSkipped = true;
          logger.debug("crankAll: Hyperp-mode market with zero authority_price_e6 — skipping to prevent OracleInvalid (0xc)", { slabAddress });
        }
        skippedHyperpNoPrice++;
        continue;
      }
    }

    // PERC-8108: Skip markets paused due to stale oracle (>10min without price push)
    if (this._stalePauseCheck?.(slabAddress)) {
      skippedStalePaused++;
      continue;
    }

    // B1: gate is `>=`, not `>`. The off-by-one previously let MAX-th failure
    // through (cranks at 10, skips at 11+). Now skips at MAX (10+).
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Log on first skip so operators know WHY a market stopped cranking.
      if (state.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        logger.warn("Market exceeded max consecutive failures — pausing cranks until next rediscovery", {
          slabAddress,
          consecutiveFailures: state.consecutiveFailures,
          lastError: "Check previous crank error logs for root cause",
        });
      }
      skippedFailures++;
      continue;
    }
    if (!this.isDue(state)) {
      skippedNotDue++;
      continue;
    }
    toCrank.push(slabAddress);
  }

  // NEW: meaningful accounting check
  const skipped = skippedPermanent + skippedForeignOracle + skippedHyperpNoPrice + skippedStalePaused + skippedFailures + skippedNotDue;
  const total = this.markets.size;
  const accounted = toCrank.length + skipped;

  if (accounted !== total) {
    logger.warn("Crank accounting mismatch", {
      totalMarkets: total,
      toCrank: toCrank.length,
      skipped,
      skippedPermanent,
      skippedForeignOracle,
      skippedHyperpNoPrice,
      skippedStalePaused,
      skippedFailures,
      skippedNotDue,
    });
  }

    // PERC-204: Full parallel fan-out — all market cranks are independent transactions,
    // submit them all simultaneously instead of in sequential batches.
    // Each market gets its own transaction with independent nonce/blockhash.
    // The Solana network de-dupes by signature, so parallel submission is safe.
    const PARALLEL_CONCURRENCY = 10; // Cap concurrency to avoid rate limit storms

    // B16: drop inter-batch delay from 500 ms to 50 ms. At PARALLEL_CONCURRENCY=10
    // and ~100 markets, the original 500 ms gap added ~4.5 s of pure wait per cycle
    // and pushed land time past the next interval. The Solana network rate limits
    // are handled per-RPC, not per-process, so this purely reclaims wasted time.
    //
    // B2: closure returns a plain boolean; processBatched sums succeeded/failed
    // after Promise.all resolves. No outer counter mutation in the closure.
    const batchResult = await processBatched(
      toCrank,
      PARALLEL_CONCURRENCY,
      50,
      (slabAddress) => this.crankMarket(slabAddress),
    );
    success = batchResult.succeeded;
    failed = batchResult.failed;

    // BM7: Log detailed error summary if any failed
    if (batchResult.failed > 0) {
      logger.error("Parallel crank batch completed with errors", { 
        failedCount: batchResult.failed,
        successCount: success,
        parallelism: PARALLEL_CONCURRENCY,
      });
      for (const [slab, error] of batchResult.errors) {
        logger.error("Batch error detail", { slabAddress: slab, error: error.message });
      }
    }

    // P2 FIX: Clean up stale signatures every cycle (was only on success path)
    const now = Date.now();
    for (const [oldSig, ts] of this.recentSignatures.entries()) {
      if (now - ts > this.signatureTTLMs) this.recentSignatures.delete(oldSig);
    }

    // P0 FIX: Always log cycle result with skip breakdown. Previously only logged
    // when failed > 0, causing skipped-only cycles to produce zero log output.
    logger.info("Crank cycle complete", {
      success, failed, skipped,
      toCrank: toCrank.length,
      ...(skippedFailures > 0 && { skippedFailures }),
      ...(skippedForeignOracle > 0 && { skippedForeignOracle }),
      ...(skippedHyperpNoPrice > 0 && { skippedHyperpNoPrice }),
      ...(skippedPermanent > 0 && { skippedPermanent }),
      ...(skippedStalePaused > 0 && { skippedStalePaused }),
      ...(skippedNotDue > 0 && { skippedNotDue }),
    });

    cycleDurationSeconds.observe({ service: "crank" }, (Date.now() - _crankAllStart) / 1000);
    this.lastCycleResult = { success, failed, skipped };
    return { success, failed, skipped };
  }

  /**
   * Hot-register a freshly created market without waiting for the next discovery cycle.
   * Fetches slab data on-chain, adds to the tracked markets map, and triggers an
   * immediate crank so the price is pushed to the new market within seconds.
   *
   * @param slabAddress - The slab account address on-chain
   * @param mainnetCA   - Optional mainnet CA for price lookups (for devnet mirror mint markets)
   *
   * Called by the /register HTTP endpoint when the frontend creates a new market.
   */
  async registerMarket(slabAddress: string, mainnetCA?: string): Promise<{ success: boolean; message: string }> {
    if (this.markets.has(slabAddress)) {
      // Update mainnetCA even if already tracked (registration may have been partial)
      if (mainnetCA) {
        const existing = this.markets.get(slabAddress)!;
        existing.mainnetCA = mainnetCA;
      }
      logger.info("Market already tracked, skipping hot-register", { slabAddress });
      return { success: true, message: "Market already tracked" };
    }

    const connection = getConnection();
    const slabPubkey = new PublicKey(slabAddress);

    let info: Awaited<ReturnType<typeof connection.getAccountInfo>>;
    try {
      info = await withTimeout(
        connection.getAccountInfo(slabPubkey),
        RPC_TIMEOUT_MS,
        `getAccountInfo(${slabAddress})`,
      );
    } catch (err) {
      const msg = `RPC error fetching slab: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg, { slabAddress });
      return { success: false, message: msg };
    }

    if (!info) {
      return { success: false, message: `Slab account not found: ${slabAddress}` };
    }

    const data = new Uint8Array(info.data);
    const programId = info.owner;

    // Validate account owner is a known Percolator program — reject unknown programs
    // to prevent the keeper from sending signed transactions to arbitrary programs.
    const knownIds = new Set(config.allProgramIds);
    if (!knownIds.has(programId.toBase58())) {
      const msg = `Slab account owned by unknown program ${programId.toBase58()} — expected one of [${config.allProgramIds.join(", ")}]`;
      logger.warn(msg, { slabAddress });
      return { success: false, message: msg };
    }

    try {
      const header = parseHeader(data);
      const marketConfig = parseConfig(data);
      const engine = parseEngine(data);
      const params = parseParams(data);

      const market: DiscoveredMarket = { slabAddress: slabPubkey, programId, header, config: marketConfig, engine, params };

      this.markets.set(slabAddress, {
        market,
        lastCrankTime: 0,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        isActive: true,
        missingDiscoveryCount: 0,
        mainnetCA,
      });

      logger.info("Hot-registered new market", { slabAddress, programId: programId.toBase58() });

      // Trigger immediate oracle push + crank so price is live within seconds
      await this.crankMarket(slabAddress);

      return { success: true, message: "Market registered and initial crank triggered" };
    } catch (err) {
      const msg = `Failed to parse slab: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg, { slabAddress });
      return { success: false, message: msg };
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this._isRunning = true;
    logger.info("Crank service starting", { intervalMs: this.intervalMs, inactiveIntervalMs: this.inactiveIntervalMs });

    // B11: await initial discovery so the first crank cycle never races against
    // the discover() call. index.ts already discovers before calling start() on
    // normal boot (markets.size > 0), so this path is only hit by tests or
    // hot-restart edge cases — but when it does run, the interval below must
    // not start ticking until markets is populated.
    if (this.markets.size === 0) {
      logger.debug("start(): no pre-loaded markets — running initial discovery");
      try {
        const markets = await this.discover();
        logger.info("Initial discovery complete", { marketCount: markets.length });
      } catch (err) {
        logger.error("Initial discovery failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
        // Continue — the periodic discovery in the interval will retry.
      }
    } else {
      logger.debug("start(): markets pre-loaded by caller — skipping redundant startup discover", {
        marketCount: this.markets.size,
        lastDiscoveryTime: this.lastDiscoveryTime,
      });
    }

    // Sender confirmation can legitimately take up to 60s per attempt and the
    // keeper sender retries up to 3 times. A watchdog tied to the crank interval
    // was too aggressive for fast intervals (2s -> 20s), force-resetting
    // _cycling while the previous send was still polling confirmation. That
    // created overlapping sends and RPC status-poll storms. Keep the watchdog
    // above the worst normal Sender retry window.
    const MAX_CYCLE_MS = Math.max(this.intervalMs * 10, 4 * 60_000);

    this.timer = setInterval(async () => {
      if (this._cycling) {
        const elapsed = Date.now() - this._cycleStartedAt;
        if (elapsed > MAX_CYCLE_MS) {
          logger.error("Crank cycle watchdog: cycle exceeded max duration, force-resetting", {
            elapsedMs: elapsed,
            maxCycleMs: MAX_CYCLE_MS,
          });
          sendCriticalAlert("Crank cycle hung — watchdog reset", [
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
        // Only rediscover periodically (default 5min) to avoid RPC rate limits
        // PERC-8235: Don't use markets.size===0 as a trigger to rediscover every tick.
        // On mainnet with 0 markets, this causes discovery every 30s (crankIntervalMs),
        // hammering RPC. Always respect discoveryIntervalMs (default 5min).
        const needsDiscovery =
          Date.now() - this.lastDiscoveryTime >= this.discoveryIntervalMs;
        if (needsDiscovery) {
          await this.discover();
        }
        if (this.markets.size > 0) {
          const result = await this.crankAll();
          // 6.2: Track total crank cycles for health metrics and MonitorService
          this._totalCrankCycles++;
          this._onCrankCycle?.();
          // Always log cycle result so operators can see the keeper is alive
          if (result.failed > 0 || result.success > 0) {
            logger.info("Crank cycle complete", {
              success: result.success,
              failed: result.failed,
              skipped: result.skipped,
              totalCycles: this._totalCrankCycles,
            });
          }
        }
      } catch (err) {
        logger.error("Crank cycle failed", { error: err });
      } finally {
        this._cycling = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._isRunning = false;
      logger.info("Crank service stopped");
    }
  }

  getStatus(): Record<string, { lastCrankTime: number; successCount: number; failureCount: number; isActive: boolean }> {
    const status: Record<string, { lastCrankTime: number; successCount: number; failureCount: number; isActive: boolean }> = {};
    for (const [key, state] of this.markets) {
      status[key] = {
        lastCrankTime: state.lastCrankTime,
        successCount: state.successCount,
        failureCount: state.failureCount,
        isActive: state.isActive,
      };
    }
    return status;
  }

  getLastCycleResult() {
    return this.lastCycleResult;
  }

  /** 6.2: Total completed crank cycles since service start. */
  getTotalCrankCycles(): number {
    return this._totalCrankCycles;
  }

  /** 6.2: Register a callback fired after each completed crank cycle. */
  setOnCrankCycle(fn: () => void): void {
    this._onCrankCycle = fn;
  }

  getMarkets(): Map<string, MarketCrankState> {
    return this.markets;
  }
}
