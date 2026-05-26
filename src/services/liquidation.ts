import { PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import {
  fetchSlab,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
  parseUsedIndices,
  detectLayout,
  buildAccountMetas,
  buildIx,
  encodeLiquidateAtOracle,
  encodeKeeperCrank,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_KEEPER_CRANK,
  derivePythPushOraclePDA,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { config, getConnection, loadKeypair, sendWithRetry, pollSignatureStatus, getRecentPriorityFees, checkTransactionSize, eventBus, createLogger, sendWarningAlert, acquireToken, getFallbackConnection, backoffMs, getErrorMessage } from "@percolatorct/shared";
import { OracleService } from "./oracle.js";
import { recordAttempt, recordLanded, recordFailed } from "../lib/sender-metrics.js";
import {
  txSentTotal,
  solSpentLamportsTotal,
  cycleDurationSeconds,
  txLandTimeSeconds,
} from "../lib/metrics.js";
import type { AccountLoader } from "../lib/account-loader.js";
import { keeperSend, sharedBudget } from "../lib/keeper-send.js";
import { sharedTxQueue } from "../lib/tx-queue.js";
import { AlertAggregator } from "../lib/alert-aggregator.js";

const logger = createLogger("keeper:liquidation");

/** Timeout for individual RPC calls — prevents indefinite hangs on unresponsive nodes. */
const RPC_TIMEOUT_MS = 15_000;

/** Race a promise against a timeout. Rejects with a descriptive error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rate-limited fetchSlab with automatic fallback to secondary RPC.
 * Retries up to 3 times with exponential backoff on rate-limit (429) or
 * transient network errors, falling back to the secondary RPC on 429.
 */
async function fetchSlabWithRetry(
  slabPubkey: PublicKey,
  maxRetries = 3,
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const conn = attempt === 0 ? getConnection() : getFallbackConnection();
    try {
      await acquireToken();
      return await withTimeout(
        fetchSlab(conn, slabPubkey),
        RPC_TIMEOUT_MS,
        `fetchSlab(${slabPubkey.toBase58()})`,
      );
    } catch (err) {
      lastErr = err;
      const msg = getErrorMessage(err).toLowerCase();
      const isRetryable = msg.includes("429") || msg.includes("too many requests")
        || msg.includes("rate limit") || msg.includes("timeout")
        || msg.includes("socket") || msg.includes("econnrefused")
        || msg.includes("502") || msg.includes("503");
      if (!isRetryable || attempt >= maxRetries - 1) break;
      const delay = backoffMs(attempt, 500, 8_000);
      logger.warn("fetchSlab retrying", {
        slabAddress: slabPubkey.toBase58(),
        attempt: attempt + 1,
        delayMs: Math.round(delay),
        error: msg.slice(0, 120),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// BL2: Extract magic numbers to named constants
const PRICE_E6_DIVISOR = 1_000_000n; // Price precision divisor (6 decimals)
const BPS_MULTIPLIER = 10_000n; // Basis points multiplier (100% = 10000 bps)

/**
 * A.13: pure helper for margin-ratio-in-bps. scanMarket() and liquidate()
 * both compute this value; extracting it both unblocks property testing and
 * prevents drift between the two call sites.
 *
 * Semantics (matches the inline code that was duplicated):
 *  - notional == 0n  → 0n (no position, nothing to ratio)
 *  - equity   <= 0n  → 0n (B3: underwater = liquidatable; the unreachable
 *                          `-1` sentinel that lived inside the equity<=0n
 *                          branch is removed in the same commit)
 *  - else            → equity * 10_000n / notional (bigint divide truncates)
 */
export function computeMarginRatioBps(equity: bigint, notional: bigint): bigint {
  if (notional === 0n) return 0n;
  if (equity <= 0n) return 0n;
  return equity * BPS_MULTIPLIER / notional;
}

/**
 * Oracle mode for a market.
 * - 'pyth-pinned': oracle_authority == [0;32] && index_feed_id != [0;32]
 *   → staleness enforced on-chain by Pyth CPI
 * - 'hyperp': index_feed_id == [0;32]
 *   → DEX oracle, authority_timestamp stores funding rate (not a real timestamp)
 * - 'admin': oracle_authority != [0;32] && index_feed_id != [0;32]
 *   → off-chain authority pushes prices; needs staleness check
 */
type OracleMode = "pyth-pinned" | "hyperp" | "admin";

/**
 * Detect oracle mode from market config keys.
 * Centralizes mode detection so scanMarket and liquidate use identical logic.
 */
function detectOracleMode(cfg: { oracleAuthority: PublicKey; indexFeedId: PublicKey }): OracleMode {
  const zeroKey = new PublicKey(new Uint8Array(32));
  const isHyperp = cfg.indexFeedId.equals(zeroKey);
  if (isHyperp) return "hyperp";
  if (cfg.oracleAuthority.equals(zeroKey)) return "pyth-pinned";
  return "admin";
}

/**
 * Resolve the effective price for a market based on its oracle mode.
 * Both scanMarket and liquidate call this to ensure identical price selection
 * logic, including the staleness fallback for admin-oracle markets.
 *
 * Returns 0n if no valid price is available.
 */
function resolveMarketPrice(
  cfg: {
    oracleAuthority: PublicKey;
    indexFeedId: PublicKey;
    lastEffectivePriceE6: bigint;
    authorityPriceE6: bigint;
    authorityTimestamp: bigint;
  },
  mode: OracleMode,
): { price: bigint; stale: boolean } {
  if (mode === "pyth-pinned") {
    return { price: cfg.lastEffectivePriceE6, stale: false };
  }
  if (mode === "hyperp") {
    return { price: cfg.lastEffectivePriceE6, stale: false };
  }
  // Admin oracle: try authorityPriceE6 with off-chain staleness check
  const now = BigInt(Math.floor(Date.now() / 1000));
  const priceAge = cfg.authorityTimestamp > 0n ? now - cfg.authorityTimestamp : now;
  const authorityFresh = cfg.authorityPriceE6 > 0n && priceAge <= 60n;

  if (authorityFresh) {
    return { price: cfg.authorityPriceE6, stale: false };
  }
  // Authority stale — fall back to lastEffectivePriceE6 (mirrors on-chain behavior)
  return { price: cfg.lastEffectivePriceE6, stale: true };
}

interface LiquidationCandidate {
  slabAddress: string;
  accountIdx: number;
  owner: string;
  positionSize: bigint;
  capital: bigint;
  pnl: bigint;
  marginRatio: number;  // as percentage
  maintenanceMarginBps: bigint;
}

export class LiquidationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly oracleService: OracleService;
  private liquidationCount = 0;
  private scanCount = 0;
  private lastScanTime = 0;
  // Overlap guard: prevent concurrent scan cycles from interleaving
  private _scanning = false;
  private _scanStartedAt = 0;
  // BC1: Signature replay protection
  private recentSignatures = new Map<string, number>(); // signature -> timestamp
  private readonly signatureTTLMs = 60_000; // 60 seconds
  // PERC-134: Exponential backoff on consecutive scan failures
  private consecutiveFailures = 0;
  private readonly maxBackoffMs = 300_000; // 5 minutes max backoff
  // PERC-484: Track markets that permanently fail with InvalidSlabLen (0x4).
  // These are test/corrupt markets with wrong slab size — skip them indefinitely.
  private readonly permanentlySkipped = new Set<string>();
  // Cache keypair at construction — avoids re-parsing from env on every liquidate() call
  private readonly _keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
  /** LaserStream account loader — injected for event-driven portfolio scanning. */
  private readonly _accountLoader?: AccountLoader;
  /** Per-account debounce timers: slab pubkey → setTimeout handle. */
  private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _DEBOUNCE_MS = 1_000;
  private _unsubLoader?: () => void;
  // B4: per-cycle dedup so the same owner is never targeted twice in the same
  // scan cycle. A user underwater in multiple markets used to get N parallel
  // liquidates fired; now we attempt one per cycle and let the next cycle pick
  // up any residual undercollateralization.
  private _cycleSeenOwners = new Set<string>();
  // B5: collapse per-liquidation Discord alerts into a single summary alert per
  // market within a 5 s window — prevents cascade-driven channel flooding.
  private readonly _liquidationAlertAggregator = new AlertAggregator(
    async (key, count) => {
      const market = key.startsWith("liq:") ? key.slice(4) : key;
      await sendWarningAlert(
        count === 1 ? "Liquidation executed" : `${count} liquidations executed in market`,
        [
          { name: "Market", value: market.slice(0, 16), inline: true },
          { name: "Count", value: count.toString(), inline: true },
        ],
      ).catch(() => {});
    },
    { bufferMs: 5_000 },
  );

  constructor(oracleService: OracleService, intervalMs = 60_000, accountLoader?: AccountLoader) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs;
    this._accountLoader = accountLoader;
  }

  /**
   * Scan a single market for undercollateralized accounts.
   */
  async scanMarket(market: DiscoveredMarket): Promise<LiquidationCandidate[]> {
    const slabAddress = market.slabAddress.toBase58();

    try {
      const data = await fetchSlabWithRetry(market.slabAddress);
      const engine = parseEngine(data);
      const params = parseParams(data);
      const cfg = parseConfig(data);
      const layout = detectLayout(data.length);
      if (!layout) return [];

      const candidates: LiquidationCandidate[] = [];
      const maintenanceMarginBps = params.maintenanceMarginBps;

      // Determine oracle mode and resolve price via shared helpers
      const oracleMode = detectOracleMode(cfg);
      const { price: resolvedPrice, stale } = resolveMarketPrice(cfg, oracleMode);

      let price: bigint;
      if (oracleMode === "pyth-pinned") {
        price = resolvedPrice;
        if (price === 0n) return []; // No price resolved yet
      } else if (oracleMode === "hyperp") {
        price = resolvedPrice;
        if (price === 0n) return []; // Market not bootstrapped yet

        // Sanity check: mark price should also be non-zero in a healthy Hyperp market
        if (cfg.authorityPriceE6 === 0n) {
          if (engine.totalOpenInterest > 0n) {
            logger.warn("Hyperp market has zero mark price, skipping", { slabAddress });
          }
          return [];
        }
      } else {
        // Admin oracle — resolveMarketPrice handles staleness fallback
        price = resolvedPrice;
        if (price === 0n) {
          if (engine.totalOpenInterest > 0n) {
            logger.warn("No valid price (authority stale, no effective price), skipping", {
              slabAddress,
              authorityTimestamp: Number(cfg.authorityTimestamp),
            });
          }
          return [];
        }
        if (stale) {
          logger.debug("Authority price stale, using lastEffectivePriceE6", {
            slabAddress,
            lastEffectivePriceE6: price.toString(),
          });
        }
      }

      // Use bitmap to find actually-used account indices (not sequential iteration)
      // The bitmap can be sparse — e.g., accounts at indices 0, 5, 100
      const usedIndices = parseUsedIndices(data);

      for (const i of usedIndices) {
        try {
          const account = parseAccount(data, i);

          // Skip LP accounts (kind=1) and empty accounts
          if (account.kind !== 0) continue;  // 0 = User
          if (account.positionSize === 0n) continue;  // No position

          // Calculate margin health using mark-to-market PnL (not stale on-chain pnl)
          // On-chain pnl is only updated during cranks; between cranks it can be stale
          const notional = absBI(account.positionSize) * price / PRICE_E6_DIVISOR;
          if (notional === 0n) continue;

          // v12.17: entryPrice is always 0n (removed from on-chain struct).
          // Use account.pnl directly — it is always populated and accurate.
          const markPnl = account.pnl;
          const equity = account.capital + markPnl;
          const marginRatioBps = computeMarginRatioBps(equity, notional);

          // If margin ratio < maintenance margin, this account is liquidatable.
          // The equity<=0n short-circuit lives inside computeMarginRatioBps;
          // a candidate with marginRatioBps == 0n is collected here just like
          // any other below-threshold ratio.
          if (marginRatioBps < maintenanceMarginBps) {
            candidates.push({
              slabAddress,
              accountIdx: i,
              owner: account.owner.toBase58(),
              positionSize: account.positionSize,
              capital: account.capital,
              pnl: markPnl,
              marginRatio: Number(marginRatioBps) / 100,
              maintenanceMarginBps,
            });
          }
        } catch {
          // Skip accounts that fail to parse
          continue;
        }
      }

      return candidates;
    } catch (err) {
      const errMsg = getErrorMessage(err);

      // Unrecognized slab data length means parseEngine/detectLayout cannot handle
      // this slab size (e.g. 4096-slot = 992560 bytes, larger than any known layout).
      // Permanently skip so we stop logging an [ERRO] every ~60 seconds.
      // Root fix: SDK needs to add a 4096-slot layout variant — message sdk agent.
      if (errMsg.toLowerCase().includes("unrecognized slab data length")) {
        this.permanentlySkipped.add(slabAddress);
        logger.warn(
          "Unrecognized slab layout — permanently skipping this market in liquidation scanner. " +
          "SDK needs to add support for this slab size. File issue against percolator-sdk.",
          {
            slabAddress,
            error: errMsg,
          },
        );
        return [];
      }

      logger.error("Market scan failed", {
        slabAddress,
        error: errMsg,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return [];
    }
  }

  /**
   * Execute liquidation for an undercollateralized account.
   * Prepends oracle price push + crank (to ensure fresh state) then liquidates.
   */
  async liquidate(
    market: DiscoveredMarket,
    accountIdx: number,
  ): Promise<string | null> {
    const slabAddress = market.slabAddress;

    try {
      const connection = getConnection();
      const keypair = this._keypair;
      const programId = market.programId;

      // Build multi-instruction tx: crank → liquidate.
      // Admin-push oracle was removed by percolator-prog Phase G —
      // all markets now read Pyth/Chainlink/Hyperp directly.
      const instructions: TransactionInstruction[] = [];

      // Determine oracle account for crank/liquidate
      const feedIdBytes = market.config.indexFeedId.toBytes();
      const feedHex = Array.from(feedIdBytes).map(b => b.toString(16).padStart(2, "0")).join("");
      const isAllZeros = feedHex === "0".repeat(64);
      const oracleAccount = isAllZeros ? slabAddress : derivePythPushOraclePDA(feedHex)[0];

      // 1. Crank (make sure engine state is fresh)
      const crankData = encodeKeeperCrank({ callerIdx: 65535 });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        keypair.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, oracleAccount,
      ]);
      instructions.push(buildIx({ programId, keys: crankKeys, data: crankData }));

      // 2. Liquidate
      const liqData = encodeLiquidateAtOracle({ targetIdx: accountIdx });
      const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
        keypair.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, oracleAccount,
      ]);
      instructions.push(buildIx({ programId, keys: liqKeys, data: liqData }));

      // Bug 3: Re-read slab data and verify account before submitting
      {
        const freshData = await fetchSlabWithRetry(slabAddress);
        const freshEngine = parseEngine(freshData);
        const freshParams = parseParams(freshData);
        const freshCfg = parseConfig(freshData);

        // Use bitmap to verify account is still active (not sequential numUsedAccounts)
        const freshUsed = parseUsedIndices(freshData);
        if (!freshUsed.includes(accountIdx)) {
          logger.warn("Race condition: account not in bitmap", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58() });
          return null;
        }

        const freshAccount = parseAccount(freshData, accountIdx);
        // Owner is verified implicitly — the account at this index is what we'll liquidate

        // Verify still undercollateralized
        if (freshAccount.kind !== 0 || freshAccount.positionSize === 0n) {
          logger.warn("Race condition: account no longer active", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58() });
          return null;
        }

        // Use the same price source as scanMarket via shared helpers
        // (fixes bug where admin-oracle staleness fallback was missing here)
        const freshMode = detectOracleMode(freshCfg);
        const { price: freshPrice } = resolveMarketPrice(freshCfg, freshMode);
        if (freshPrice > 0n) {
          const notional = absBI(freshAccount.positionSize) * freshPrice / PRICE_E6_DIVISOR;
          // A.13: shared helper. equity<=0n returns 0n, which is < any
          // positive maintenanceMarginBps and so correctly proceeds with
          // liquidation; the previous `if (equity > 0n)` wrapper just
          // skipped the re-check entirely on underwater equity, missing
          // the same liquidation case the scanMarket path catches.
          const freshMarkPnl = freshAccount.pnl;
          const equity = freshAccount.capital + freshMarkPnl;
          const marginRatioBps = computeMarginRatioBps(equity, notional);
          if (
            notional > 0n &&
            equity > 0n &&
            marginRatioBps >= freshParams.maintenanceMarginBps
          ) {
            logger.warn("Race condition: account no longer undercollateralized", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58(), marginRatioBps: Number(marginRatioBps) });
            return null;
          }
        }
      }

      // PERC-204: Use keeper-optimized send (skipPreflight + multi-RPC + tight CU)
      // Replaces manual tx building with sendWithRetryKeeper for:
      //   - skipPreflight=true (saves ~20-50ms)
      //   - Multi-RPC parallel broadcast (+20-40% landing rate)
      //   - Simulation-based tight CU limit (better queue position)
      const __t0 = Date.now();
      recordAttempt();
      let sig: string;
      try {
        const sendResult = await sharedTxQueue.enqueue("liquidation", () =>
          keeperSend(connection, instructions, [keypair], "liquidation", sharedBudget, 3),
        );
        if (!sendResult) {
          recordFailed();
          return null;
        }
        sig = sendResult.signature;
        const __tip = process.env.USE_HELIUS_SENDER === "true"
          ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
          : 0;
        const __elapsed = Date.now() - __t0;
        recordLanded(__elapsed, __tip);
        txSentTotal.inc({ result: "success", type: "liquidation" });
        txLandTimeSeconds.observe({ type: "liquidation", lane: __tip > 0 ? "jito" : "sender" }, __elapsed / 1000);
        if (__tip > 0) solSpentLamportsTotal.inc({ type: "liquidation" }, __tip);
      } catch (err) {
        recordFailed();
        txSentTotal.inc({ result: "fail", type: "liquidation" });
        throw err;
      }

      // BC1: Track signature to prevent replay attacks
      const now = Date.now();
      this.recentSignatures.set(sig, now);
      // Clean up signatures older than TTL
      for (const [oldSig, timestamp] of this.recentSignatures.entries()) {
        if (now - timestamp > this.signatureTTLMs) {
          this.recentSignatures.delete(oldSig);
        }
      }

      this.liquidationCount++;
      eventBus.publish("liquidation.success", slabAddress.toBase58(), {
        accountIdx,
        signature: sig,
      });
      logger.info("Account liquidated", { accountIndex: accountIdx, slabAddress: slabAddress.toBase58(), signature: sig });

      // B5: aggregate per-liquidation Discord alerts into a 5 s summary per market.
      this._liquidationAlertAggregator.add(`liq:${slabAddress.toBase58()}`);

      return sig;
    } catch (err) {
      const errMsg = getErrorMessage(err);

      // PERC-484: InvalidSlabLen (0x4) means the slab has wrong size for the program.
      // These are test/corrupt markets that will never succeed — permanently skip them
      // so the liquidation service stops retrying every 60 seconds.
      if (errMsg.includes("custom program error: 0x4")) {
        this.permanentlySkipped.add(slabAddress.toBase58());
        logger.warn(
          "Market slab size mismatch (0x4 InvalidSlabLen) — permanently skipping for liquidation. " +
          "Fix: run `npx tsx scripts/reinit-slab.ts --slab <ADDRESS>` to recreate with correct size.",
          {
            slabAddress: slabAddress.toBase58(),
            accountIdx,
            programId: market.programId.toBase58(),
          },
        );
        return null;
      }

      logger.error("Liquidation failed", {
        error: errMsg,
        stack: err instanceof Error ? err.stack : undefined,
        slabAddress: slabAddress.toBase58(),
        accountIdx,
        market: slabAddress.toBase58(),
        programId: market.programId.toBase58(),
      });
      
      eventBus.publish("liquidation.failure", slabAddress.toBase58(), {
        accountIdx,
        error: errMsg,
      });
      return null;
    }
  }

  /**
   * Scan all markets and liquidate any undercollateralized accounts.
   */
  async scanAndLiquidateAll(markets: Map<string, { market: DiscoveredMarket }>): Promise<{
    scanned: number;
    candidates: number;
    liquidated: number;
  }> {
    const _scanStart = Date.now();
    let scanned = 0;
    let candidateCount = 0;
    let liquidated = 0;
    // B4: fresh per-cycle dedup set — owners targeted in earlier cycles can
    // be re-targeted next cycle (the previous liquidate may have only chipped
    // away part of their exposure).
    this._cycleSeenOwners.clear();

    // P2 FIX: Periodically clear permanentlySkipped to allow recovery when SDK is updated.
    // Markets re-add themselves on next parse failure, so this is safe.
    // Note: scanCount=0 on first call, so use scanCount > 0 to avoid clearing on initial run.
    if (this.permanentlySkipped.size > 0 && this.scanCount > 0 && this.scanCount % 10 === 0) {
      logger.debug("Clearing permanentlySkipped set for retry", {
        count: this.permanentlySkipped.size,
        markets: Array.from(this.permanentlySkipped).slice(0, 5),
      });
      this.permanentlySkipped.clear();
    }

    // Process markets in batches to avoid RPC rate-limit bursts.
    // Batch size of 10 keeps us well within Helius free-tier (100 req/10s).
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 1_200; // ~1.2s pause between batches
    const entries = Array.from(markets.values());

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      // PERC-484: Skip markets permanently flagged as invalid slab (0x4 InvalidSlabLen).
      const filteredBatch = batch.filter((state) => {
        const addr = state.market.slabAddress.toBase58();
        if (this.permanentlySkipped.has(addr)) {
          logger.debug("Skipping permanently-skipped market", { slabAddress: addr });
          return false;
        }
        return true;
      });
      const batchResults = await Promise.allSettled(
        filteredBatch.map((state) => this.scanMarket(state.market)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        scanned++;
        const result = batchResults[j]!;
        if (result.status === "rejected") {
          logger.error("Market scan rejected", { error: result.reason });
          continue;
        }
        const candidates = result.value;
        candidateCount += candidates.length;

        // Liquidations are sequential (each is a transaction).
        // B4: skip owners already targeted earlier in this scan cycle.
        for (const candidate of candidates) {
          if (this._cycleSeenOwners.has(candidate.owner)) {
            logger.debug("Skipping owner already targeted this cycle", {
              owner: candidate.owner.slice(0, 8),
              slabAddress: candidate.slabAddress.slice(0, 8),
            });
            continue;
          }
          this._cycleSeenOwners.add(candidate.owner);
          const sig = await this.liquidate(filteredBatch[j]!.market, candidate.accountIdx);
          if (sig) liquidated++;
        }
      }

      // Pause between batches (skip after last batch)
      if (i + BATCH_SIZE < entries.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    cycleDurationSeconds.observe({ service: "liquidation" }, (Date.now() - _scanStart) / 1000);
    this.scanCount++;
    this.lastScanTime = Date.now();
    return { scanned, candidates: candidateCount, liquidated };
  }

  start(getMarkets: () => Map<string, { market: DiscoveredMarket }>): void {
    if (this.timer) return;
    logger.info("Liquidation service starting", { intervalMs: this.intervalMs });

    const MAX_SCAN_MS = this.intervalMs * 5;

    const runCycle = async () => {
      if (this._scanning) {
        const elapsed = Date.now() - this._scanStartedAt;
        if (elapsed > MAX_SCAN_MS) {
          logger.error("Liquidation scan watchdog: cycle exceeded max duration, force-resetting", {
            elapsedMs: elapsed,
            maxScanMs: MAX_SCAN_MS,
          });
          this._scanning = false;
        }
        return;
      }
      this._scanning = true;
      this._scanStartedAt = Date.now();
      try {
        const marketsSnapshot = new Map(getMarkets());
        const result = await this.scanAndLiquidateAll(marketsSnapshot);
        this.consecutiveFailures = 0; // Reset on success
        if (result.candidates > 0) {
          logger.info("Liquidation scan complete", {
            scanned: result.scanned,
            candidates: result.candidates,
            liquidated: result.liquidated
          });
        }
      } catch (err) {
        this.consecutiveFailures++;
        const backoff = Math.min(
          this.intervalMs * Math.pow(2, this.consecutiveFailures - 1),
          this.maxBackoffMs,
        );
        logger.error("Liquidation cycle failed", {
          error: err instanceof Error ? err.message : String(err),
          consecutiveFailures: this.consecutiveFailures,
          nextRetryMs: Math.round(backoff),
        });
        // Schedule delayed retry instead of waiting for next fixed interval
        if (backoff > this.intervalMs) {
          setTimeout(runCycle, backoff - this.intervalMs);
        }
      } finally {
        this._scanning = false;
      }
    };
    this.timer = setInterval(runCycle, this.intervalMs);

    // Event-driven path: when KEEPER_USE_LASERSTREAM=true and an accountLoader
    // is injected, subscribe to account updates and debounce scans per slab.
    // The polling path above remains active as a safety net (slow path).
    if (
      process.env.KEEPER_USE_LASERSTREAM === "true" &&
      this._accountLoader
    ) {
      this._unsubLoader = this._accountLoader.onAccount((update) => {
        const markets = getMarkets();
        if (!markets.has(update.pubkey)) return;
        const market = markets.get(update.pubkey)!;
        const slabKey = market.market.slabAddress.toBase58();
        const existing = this._debounceTimers.get(slabKey);
        if (existing) clearTimeout(existing);
        this._debounceTimers.set(
          slabKey,
          setTimeout(() => {
            this._debounceTimers.delete(slabKey);
            // Single-market scan — fire-and-forget; errors logged inside scanMarket.
            this.scanMarket(market.market).then(async (candidates) => {
              for (const c of candidates) {
                const sig = await this.liquidate(market.market, c.accountIdx);
                if (sig) {
                  logger.info("Event-driven liquidation complete", {
                    slabAddress: slabKey,
                    accountIdx: c.accountIdx,
                    signature: sig,
                  });
                }
              }
            }).catch((err: unknown) => {
              logger.warn("Event-driven scan/liquidate failed", {
                slabAddress: slabKey,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, this._DEBOUNCE_MS),
        );
      });
      logger.info("Liquidation service: event-driven mode active", {
        debounceMs: this._DEBOUNCE_MS,
      });
    }
  }

  stop(): void {
    if (this._unsubLoader) {
      this._unsubLoader();
      this._unsubLoader = undefined;
    }
    for (const t of this._debounceTimers.values()) clearTimeout(t);
    this._debounceTimers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // B5: flush any pending aggregated alerts so a SIGTERM during a cascade
      // doesn't drop the summary.
      void this._liquidationAlertAggregator.flush();
      logger.info("Liquidation service stopped");
    }
  }

  getStatus() {
    return {
      liquidationCount: this.liquidationCount,
      scanCount: this.scanCount,
      lastScanTime: this.lastScanTime,
      running: this.timer !== null,
      permanentlySkippedCount: this.permanentlySkipped.size,
      permanentlySkippedMarkets: Array.from(this.permanentlySkipped),
    };
  }
}

function absBI(n: bigint): bigint {
  return n < 0n ? -n : n;
}
