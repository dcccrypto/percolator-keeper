import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  discoverMarkets,
  encodeKeeperCrank,
  encodePushOraclePrice,
  encodeUpdateHyperpMark,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  type DiscoveredMarket,
} from "@percolator/sdk";
import { config, getConnection, getFallbackConnection, loadKeypair, sendWithRetry, sendWithRetryKeeper, rateLimitedCall, eventBus, createLogger, sendCriticalAlert, getSupabase } from "@percolator/shared";
import { OracleService } from "./oracle.js";

const logger = createLogger("keeper:crank");

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
}

/** Process items in batches with delay between batches.
 *  Each item is wrapped in try/catch so one failure doesn't kill the batch.
 *  BM7: Enhanced error tracking per item. */
async function processBatched<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
): Promise<{ succeeded: number; failed: number; errors: Map<string, Error> }> {
  const errors = new Map<string, Error>();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(async (item) => {
      try {
        await fn(item);
        succeeded++;
      } catch (err) {
        failed++;
        const itemKey = String(item);
        const errorObj = err instanceof Error ? err : new Error(String(err));
        errors.set(itemKey, errorObj);
        logger.error("Batch item failed", { item: itemKey, error: errorObj.message });
      }
    }));
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
  private _stalePauseCheck?: (slabAddress: string) => boolean;
  // P1 FIX: Cache keypair at construction — was reading from disk on every crank cycle (every 30s)
  private readonly _keypair = loadKeypair(process.env.CRANK_KEYPAIR!);

  constructor(oracleService: OracleService, intervalMs?: number) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs ?? config.crankIntervalMs;
    this.inactiveIntervalMs = config.crankInactiveIntervalMs;
    this.discoveryIntervalMs = config.discoveryIntervalMs;
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
    const programIds = config.allProgramIds;
    logger.info("Discovering markets", { programCount: programIds.length });
    // Use fallback RPC for discovery (Helius rate-limits getProgramAccounts).
    // PERC-1650: Program-level 429 retry backoff (outer loop) handles rate limit
    // recovery. SDK fires tier queries in parallel; inter-program spacing (2s)
    // prevents consecutive burst on multi-program configs.
    const discoveryConn = getFallbackConnection();
    const allFound: DiscoveredMarket[] = [];
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
        allFound.push(...found);
      }

      // Inter-program spacing: 3s base, helps avoid consecutive 429s on multi-program configs.
      // The SDK fires ~8 getProgramAccounts in parallel per program; 3s gives Helius rate
      // limiters enough window to recover before the next program's burst begins.
      if (progIdx < programIds.length - 1) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
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
        for (const row of data) {
          dbMarkets.set(row.slab_address, {
            dexPoolAddress: row.dex_pool_address ?? undefined,
            mainnetCA: row.mainnet_ca ?? undefined,
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

    // Bug 17: Track markets missing from discovery, remove after 3 consecutive misses
    for (const [key, state] of this.markets) {
      if (!discoveredKeys.has(key)) {
        state.missingDiscoveryCount++;
        if (state.missingDiscoveryCount >= 3) {
          logger.warn("Removing dead market", { slabAddress: key, missingCount: state.missingDiscoveryCount });
          this.markets.delete(key);
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
        const instructions = [];

        // UpdateHyperpMark: accounts = [slab(writable), dex_pool, clock, ...remaining]
        // The pool address must be stored in state.dexPoolAddress (from Supabase or config)
        if (!state.dexPoolAddress) {
          if (!state.hyperpNoPriceSkipped) {
            state.hyperpNoPriceSkipped = true;
            logger.warn("HYPERP market has no dex_pool_address configured — skipping UpdateHyperpMark. " +
              "Set dex_pool_address in Supabase markets table for this slab.", {
              slabAddress,
            });
          }
          // No pool address → skip oracle update but still crank (funding/liquidation still work)
        } else {
          // Build UpdateHyperpMark instruction. If this fails, throw so KeeperCrank
          // is NOT sent with a stale oracle — avoids OracleInvalid (0xc) on-chain.
          const hyperpData = encodeUpdateHyperpMark();
          const poolKey = new PublicKey(state.dexPoolAddress);

          // Build accounts: [slab(writable), pool(readonly), clock(readonly), ...remaining]
          const hyperpKeys = [
            { pubkey: market.slabAddress, isSigner: false, isWritable: true },
            { pubkey: poolKey, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          ];

          // PumpSwap pools need vault0 + vault1 as remaining accounts
          // For now, pass no remaining — Raydium CLMM doesn't need them
          // TODO: detect pool type and add vault accounts for PumpSwap/Meteora

          instructions.push(buildIx({ programId, keys: hyperpKeys, data: hyperpData }));
          state.hyperpNoPriceSkipped = false;
        }

        // Crank instruction (always — handles funding, liquidation, GC)
        const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
        const oracleKey = market.slabAddress; // HYPERP: oracle account is the slab itself
        const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
          keypair.publicKey,
          market.slabAddress,
          SYSVAR_CLOCK_PUBKEY,
          oracleKey,
        ]);
        instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

        const sig = await sendWithRetryKeeper(connection, instructions, [keypair]);
        state.lastCrankTime = Date.now();
        state.successCount++;
        state.consecutiveFailures = 0;
        state.isActive = true;
        if (state.failureCount > 0) state.failureCount = 0;
        eventBus.publish("crank.success", slabAddress, { signature: sig });
        return true;
      }

      // ── Admin-push mode: off-chain price oracle ────────────────────────────
      // GH#1508: Skip admin-oracle markets where we are NOT the oracle authority.
      if (this.isAdminOracle(market) && !keypair.publicKey.equals(market.config.oracleAuthority)) {
        if (!state.foreignOracleSkipped) {
          state.foreignOracleSkipped = true;
          logger.warn("Skipping admin-oracle market — keeper is not the oracle authority (would cause OracleInvalid 0xc). " +
            "The market creator must push prices. Suppressing further crank attempts.", {
            slabAddress,
            oracleAuthority: market.config.oracleAuthority.toBase58(),
            keeperKey: keypair.publicKey.toBase58(),
            programId: programId.toBase58(),
          });
        }
        return false;
      }

      // PERC-204: Build all instructions into a single transaction bundle
      const instructions = [];

      // PERC-204: Bundle oracle price push with crank tx
      let pricePushQueued = false;
      if (this.isAdminOracle(market) && keypair.publicKey.equals(market.config.oracleAuthority)) {
        try {
          const mint = state.mainnetCA ?? market.config.collateralMint.toBase58();
          const priceEntry = await this.oracleService.fetchPrice(mint, slabAddress);
          if (priceEntry) {
            const pushData = encodePushOraclePrice({
              priceE6: priceEntry.priceE6,
              timestamp: BigInt(Math.floor(Date.now() / 1000)),
            });
            const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
              keypair.publicKey, market.slabAddress,
            ]);
            instructions.push(buildIx({ programId, keys: pushKeys, data: pushData }));
            pricePushQueued = true;
          }
        } catch (priceErr) {
          logger.warn("Price push skipped (bundled)", { slabAddress, error: priceErr instanceof Error ? priceErr.message : String(priceErr) });
        }
      }

      // PERC-1254: Hyperp-mode guard for admin-oracle markets with zero indexFeedId
      const isAdminHyperpMode = this.isAdminOracle(market) &&
        keypair.publicKey.equals(market.config.oracleAuthority) &&
        market.config.indexFeedId.toBytes().every((b: number) => b === 0);
      if (isAdminHyperpMode && !pricePushQueued && (market.config.authorityPriceE6 ?? BigInt(0)) === BigInt(0)) {
        if (!state.hyperpNoPriceSkipped) {
          state.hyperpNoPriceSkipped = true;
          logger.warn("PERC-1254: Skipping admin-hyperp market — no price available and on-chain authority_price_e6=0.", {
            slabAddress,
          });
        }
        return false;
      }
      if (state.hyperpNoPriceSkipped && (pricePushQueued || (market.config.authorityPriceE6 ?? BigInt(0)) > BigInt(0))) {
        state.hyperpNoPriceSkipped = false;
        logger.info("PERC-1254: Admin-hyperp market now has a price — resuming cranks", { slabAddress });
      }

      // Crank instruction
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });

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
      const sig = await sendWithRetryKeeper(connection, instructions, [keypair]);

      // BC1: Track signature to prevent replay attacks
      this.recentSignatures.set(sig, Date.now());

      state.lastCrankTime = Date.now();
      state.successCount++;
      state.consecutiveFailures = 0;
      state.isActive = true;
      if (state.failureCount > 0) state.failureCount = 0;

      eventBus.publish("crank.success", slabAddress, { signature: sig });
      return true;
    } catch (err) {
      state.failureCount++;
      state.consecutiveFailures++;

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
      
      // Alert on 5+ consecutive failures — fire-and-forget; never let Discord errors crash the crank loop
      if (state.consecutiveFailures === 5) {
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

    if (state.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      // P0 FIX: Log on first skip so operators know WHY a market stopped cranking.
      // Previously this was completely silent — the market would die with no trace in logs.
      if (state.consecutiveFailures === MAX_CONSECUTIVE_FAILURES + 1) {
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

    // Process in parallel batches (larger batches, no delay between)
    const batchResult = await processBatched(toCrank, PARALLEL_CONCURRENCY, 500, async (slabAddress) => {
      const ok = await this.crankMarket(slabAddress);
      if (ok) success++;
      else failed++;
    });

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
      info = await connection.getAccountInfo(slabPubkey);
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

  start(): void {
    if (this.timer) return;
    this._isRunning = true;
    logger.info("Crank service starting", { intervalMs: this.intervalMs, inactiveIntervalMs: this.inactiveIntervalMs });

    // Only fire a startup discovery if no markets are already loaded.
    // index.ts runs discover() before calling start(), so on normal startup markets.size > 0
    // and we skip this to avoid a redundant burst of getProgramAccounts calls that trigger
    // 429s on Helius. If start() is called standalone (tests, hot-restart edge case) with
    // empty markets, we still discover as expected.
    if (this.markets.size === 0) {
      logger.debug("start(): no pre-loaded markets — running initial discovery");
      this.discover().then(markets => {
        logger.info("Initial discovery complete", { marketCount: markets.length });
      }).catch(err => {
        logger.error("Initial discovery failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      });
    } else {
      logger.debug("start(): markets pre-loaded by caller — skipping redundant startup discover", {
        marketCount: this.markets.size,
        lastDiscoveryTime: this.lastDiscoveryTime,
      });
    }

    this.timer = setInterval(async () => {
      if (this._cycling) return; // Prevent overlapping cycles
      this._cycling = true;
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
          // Always log cycle result so operators can see the keeper is alive
        if (result.failed > 0 || result.success > 0) {
          logger.info("Crank cycle complete", { success: result.success, failed: result.failed, skipped: result.skipped });
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

  getMarkets(): Map<string, MarketCrankState> {
    return this.markets;
  }
}
