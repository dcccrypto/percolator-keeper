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
import { resolveExternalOracleAccount } from "../lib/oracle-account.js";
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

// Oracle-drift guard: abort liquidation if the oracle price drifts more than
// this between scan-time candidacy and pre-submit re-verification.
// The on-chain Liquidate instruction carries no price bound, so keeper-side
// drift detection is the only available mitigation.
// Default 150 bps (1.5%) — wider than typical intra-minute moves on SOL/BTC/ETH
// but tight enough to cap keeper-wallet exposure on a 60s scan interval.
// Set to 0 to disable.
const MAX_LIQUIDATION_DRIFT_BPS = BigInt(
  parseInt(process.env.LIQUIDATION_MAX_ORACLE_DRIFT_BPS ?? "150", 10),
);

// N4: Minimum notional value (in collateral token base units) below which
// liquidation is skipped — tx cost exceeds the reward for dust positions.
// Default 0 = no filter (preserve existing behavior). Override via env var.
const MIN_LIQUIDATION_NOTIONAL = BigInt(
  process.env.MIN_LIQUIDATION_NOTIONAL ?? "0"
);

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
 * H3: Read the current cluster Unix time from the Solana Clock sysvar.
 * Using cluster time avoids false-positive staleness verdicts when the
 * keeper host clock drifts (skew, leap-second, VM pause). Falls back to
 * Date.now()/1000 on RPC error so a failing RPC doesn't break liquidation.
 */
async function fetchClusterUnixTimeSec(connection: import("@solana/web3.js").Connection): Promise<bigint> {
  try {
    const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    if (info && info.data.length >= 40) {
      // Clock sysvar layout: slot(u64,8) + epoch_start_timestamp(i64,8) +
      //   epoch(u64,8) + leader_schedule_epoch(u64,8) + unix_timestamp(i64,8)
      const buf = Buffer.from(info.data);
      const ts = buf.readBigInt64LE(32);
      return ts > 0n ? ts : BigInt(Math.floor(Date.now() / 1000));
    }
  } catch (err) {
    logger.warn("fetchClusterUnixTimeSec: RPC error, falling back to Date.now()", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Resolve the effective price for a market based on its oracle mode.
 * Both scanMarket and liquidate call this to ensure identical price selection
 * logic, including the staleness fallback for admin-oracle markets.
 *
 * nowSec: current cluster Unix timestamp (from fetchClusterUnixTimeSec).
 * Using cluster time rather than Date.now() avoids false staleness on clock skew.
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
  nowSec: bigint,
): { price: bigint; stale: boolean } {
  if (mode === "pyth-pinned") {
    return { price: cfg.lastEffectivePriceE6, stale: false };
  }
  if (mode === "hyperp") {
    return { price: cfg.lastEffectivePriceE6, stale: false };
  }
  // Admin oracle: try authorityPriceE6 with off-chain staleness check
  const priceAge = cfg.authorityTimestamp > 0n ? nowSec - cfg.authorityTimestamp : nowSec;
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
  // Oracle price (E6) at candidacy decision time. Used by liquidate() to detect
  // oracle drift between scan and submit and abort if it exceeds MAX_LIQUIDATION_DRIFT_BPS.
  scanPriceE6: bigint;
}

export class LiquidationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly oracleService: OracleService;
  private liquidationCount = 0;
  private scanCount = 0;
  private lastScanTime = 0;
  // Overlap guard: the in-flight scan promise (null ⇒ no scan running). A new
  // cycle starts only when this is null — i.e. the previous scan has SETTLED.
  // We never force-clear it: a JS promise can't be cancelled, so clearing the
  // guard while a scan is still awaiting its RPCs would only start a second
  // scan concurrently (duplicate liquidations against the same accounts). A
  // genuinely hung cycle therefore stops new scans; lastScanTime stops
  // advancing, which the index.ts stall alert (3min) and /health "down" (5min →
  // supervisor restart) already act on.
  private _inFlight: Promise<void> | null = null;
  private _scanStartedAt = 0; // start of the in-flight scan — for the watchdog WARN log only
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
  // C1 (post-mainnet-audit): per-cycle dedup keyed on (slabAddress, accountIdx)
  // — the unique on-chain identifier of a User sub-account in Percolator. The
  // previous "B4" key was the owner pubkey, which silently dropped liquidations
  // of every additional sub-account belonging to the same owner; with multiple
  // sub-accounts per owner being normal usage on a perp DEX, owner-keyed dedup
  // left residual bad debt for the insurance fund to absorb. We still cap
  // liquidations per owner per cycle to bound RPC fan-out and preserve
  // fairness — a single whale with many sub-accounts cannot monopolize the
  // scan budget. Residual positions above the cap are picked up next cycle.
  private _cycleSeenPositions = new Set<string>();
  private _cycleOwnerCounts = new Map<string, number>();
  private static readonly MAX_LIQ_PER_OWNER_PER_CYCLE = 3;
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

      // H3: Use cluster clock for admin-oracle staleness to avoid false positives
      // from keeper host clock drift.
      const connection = getConnection();
      const nowSec = await fetchClusterUnixTimeSec(connection);

      // Determine oracle mode and resolve price via shared helpers
      const oracleMode = detectOracleMode(cfg);
      const { price: resolvedPrice, stale } = resolveMarketPrice(cfg, oracleMode, nowSec);

      let price: bigint;
      if (oracleMode === "pyth-pinned") {
        price = resolvedPrice;
        if (price === 0n) return []; // No price resolved yet
      } else if (oracleMode === "hyperp") {
        // H3: Use lastEffectivePriceE6 (DEX pool mark price) for Hyperp.
        // authorityPriceE6 is not the price source for Hyperp mode and is
        // legitimately 0 when the oracle authority hasn't pushed a price.
        price = resolvedPrice;
        if (price === 0n) return []; // Market not bootstrapped yet
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
          // N4: Skip dust positions where liquidation tx cost exceeds reward
          if (MIN_LIQUIDATION_NOTIONAL > 0n && notional < MIN_LIQUIDATION_NOTIONAL) continue;

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
              scanPriceE6: price,
            });
          }
        } catch (err) {
          // N6: Log parse failures — a silent skip could hide systematic issues
          logger.debug("Failed to parse account at index", {
            slabAddress, accountIndex: i,
            error: err instanceof Error ? err.message : String(err),
          });
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
    scanPriceE6: bigint = 0n,
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

      // N1: Determine oracle account using detectOracleMode to match crank/ADL logic.
      // Admin-oracle and HYPERP markets use slabAddress; pyth-pinned markets use
      // resolveExternalOracleAccount which checks the on-chain account owner to
      // distinguish Pyth Push PDA derivation from Chainlink (where index_feed_id
      // IS the aggregator account and must be passed directly).
      const oracleMode = detectOracleMode(market.config);
      let oracleAccount: PublicKey;
      if (oracleMode === "pyth-pinned") {
        oracleAccount = await resolveExternalOracleAccount(market.config.indexFeedId, connection);
      } else {
        oracleAccount = slabAddress;
      }

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
        // H3: Use cluster clock for staleness to match scanMarket behavior.
        const freshNowSec = await fetchClusterUnixTimeSec(connection);
        const freshMode = detectOracleMode(freshCfg);
        const { price: freshPrice } = resolveMarketPrice(freshCfg, freshMode, freshNowSec);

        // H2: fail-safe when no usable price is available. The previous
        // `if (freshPrice > 0n) { ...recheck... }` envelope silently skipped
        // the margin recheck whenever resolveMarketPrice returned 0n. That
        // can happen on a race: scanMarket sees a non-zero price, then by
        // submit time the admin authority has gone stale and the on-chain
        // lastEffectivePriceE6 is also 0 (brand-new market never cranked).
        // The keeper would then proceed to submit a liquidation tx with no
        // recheck at all. Mirror scanMarket's own posture (which returns []
        // on price===0n) and refuse to submit.
        if (freshPrice === 0n) {
          logger.warn(
            "Race condition: no fresh price available for pre-submit recheck, aborting",
            { accountIndex: accountIdx, slabAddress: slabAddress.toBase58(), oracleMode: freshMode },
          );
          return null;
        }

        // Oracle-drift guard: the on-chain Liquidate instruction carries no
        // price bound. If the oracle has moved more than MAX_LIQUIDATION_DRIFT_BPS
        // since candidacy, the on-chain execution price may differ enough to
        // flip the liquidation's P&L. Abort rather than absorb that drift.
        if (MAX_LIQUIDATION_DRIFT_BPS > 0n && scanPriceE6 > 0n && freshPrice > 0n) {
          const delta = freshPrice > scanPriceE6
            ? freshPrice - scanPriceE6
            : scanPriceE6 - freshPrice;
          const driftBps = delta * BPS_MULTIPLIER / scanPriceE6;
          if (driftBps > MAX_LIQUIDATION_DRIFT_BPS) {
            logger.warn("Aborting liquidation: oracle drift exceeds limit", {
              accountIndex: accountIdx,
              slabAddress: slabAddress.toBase58(),
              scanPriceE6: scanPriceE6.toString(),
              freshPriceE6: freshPrice.toString(),
              driftBps: driftBps.toString(),
              limitBps: MAX_LIQUIDATION_DRIFT_BPS.toString(),
            });
            return null;
          }
        }

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
    // C1: fresh per-cycle dedup state — positions targeted in earlier cycles
    // can be re-targeted next cycle (a previous liquidate may have only chipped
    // away part of the exposure; partial-fill retry is intentional).
    this._cycleSeenPositions.clear();
    this._cycleOwnerCounts.clear();

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
        // C1: dedup per on-chain (slab, accountIdx) position; rate-limit per
        // owner across the cycle.
        for (const candidate of candidates) {
          const positionKey = `${candidate.slabAddress}:${candidate.accountIdx}`;
          if (this._cycleSeenPositions.has(positionKey)) {
            logger.debug("Skipping position already targeted this cycle", {
              positionKey,
              owner: candidate.owner.slice(0, 8),
            });
            continue;
          }
          const ownerCount = this._cycleOwnerCounts.get(candidate.owner) ?? 0;
          if (ownerCount >= LiquidationService.MAX_LIQ_PER_OWNER_PER_CYCLE) {
            logger.debug("Owner hit per-cycle liquidation cap", {
              owner: candidate.owner.slice(0, 8),
              cap: LiquidationService.MAX_LIQ_PER_OWNER_PER_CYCLE,
            });
            continue;
          }
          this._cycleSeenPositions.add(positionKey);
          this._cycleOwnerCounts.set(candidate.owner, ownerCount + 1);
          const sig = await this.liquidate(filteredBatch[j]!.market, candidate.accountIdx, candidate.scanPriceE6);
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

    const runCycle = (): void => {
      // Single-flight: never start a second scan while one is in flight. The
      // watchdog only WARNs on an over-long cycle — it must NOT force-reset the
      // guard, because clearing it cannot cancel the in-flight RPCs and would
      // only spawn a concurrent scan. A hung cycle stops new scans; recovery is
      // driven by the existing stall alert / health-down → restart path.
      if (this._inFlight) {
        const elapsed = Date.now() - this._scanStartedAt;
        if (elapsed > MAX_SCAN_MS) {
          logger.warn("Liquidation scan still in flight past max duration — not starting a concurrent scan", {
            elapsedMs: elapsed,
            maxScanMs: MAX_SCAN_MS,
          });
        }
        return;
      }

      this._scanStartedAt = Date.now();
      const scan = (async () => {
        try {
          const marketsSnapshot = new Map(getMarkets());
          const result = await this.scanAndLiquidateAll(marketsSnapshot);
          this.consecutiveFailures = 0; // Reset on success
          if (result.candidates > 0) {
            logger.info("Liquidation scan complete", {
              scanned: result.scanned,
              candidates: result.candidates,
              liquidated: result.liquidated,
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
          // Schedule a delayed retry instead of waiting for the next fixed
          // interval. Guard on this.timer so a queued retry can't start a scan
          // after stop(); the single-flight check above prevents overlap if the
          // regular interval tick also fires.
          if (backoff > this.intervalMs && this.timer !== null) {
            setTimeout(() => {
              if (this.timer !== null) runCycle();
            }, backoff - this.intervalMs);
          }
        }
      })();

      this._inFlight = scan;
      // Clear the guard only when THIS scan settles. The identity check makes a
      // slow cycle unable to clobber a newer cycle's guard.
      void scan.finally(() => {
        if (this._inFlight === scan) this._inFlight = null;
      });
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
                const sig = await this.liquidate(market.market, c.accountIdx, c.scanPriceE6);
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
