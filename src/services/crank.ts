import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import {
  discoverMarkets,
  encodePermissionlessCrank,
  encodeRestartAssetOracle,
  CrankAction,
  buildIx,
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  // v17 discovery + provisioning
  isV17Account,
  parseWrapperConfigV17,
  parsePortfolioV17,
  encodeInitUser,
  deriveLpVaultRegistry,
  deriveLpBackingLedger,
  parseLpVaultRegistry,
  encodeLpVaultCrankFees,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { config, getConnection, getFallbackConnection, loadKeypair, eventBus, createLogger, sendCriticalAlert, getSupabase } from "@percolatorct/shared";
import { OracleService } from "./oracle.js";
import { resolveExternalOracleAccount } from "../lib/oracle-account.js";
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
import { parseV17RiskParams, V17_RISK_PARAMS_MIN_DATA_LEN } from "../lib/v17-risk.js";
import { resolveV17OracleTail } from "../lib/v17-oracle-tail.js";

export type CrankResult = "success" | "skipped" | "failed";

const logger = createLogger("keeper:crank");

/** Timeout for individual RPC calls — prevents indefinite hangs on unresponsive nodes. */
const RPC_TIMEOUT_MS = 15_000;

// ─── v17 constants ───────────────────────────────────────────────────────────

/**
 * v17 market group account magic bytes (little-endian "PERCV16\0"):
 *   [0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]
 *
 * Stored at bytes [0..8] of every v17 percolator-owned account.
 * Used as the memcmp filter key for getProgramAccounts discovery of v17 markets.
 * Correct encodings of these LE bytes: base58 "1347Wxtvn4w", base64 "ADYxVkNSRVA=".
 * The runtime memcmp uses base64 (encoding:"base64") below — do NOT copy a wrong base58 here.
 *
 * DESYNC-1 FIX: The legacy discoverMarkets() SDK function checks for the old
 * TALOCREP magic (0x504552434f4c4154) and will never find v17 accounts. We
 * discover v17 market group accounts independently using this filter.
 */
const V17_MAGIC_BYTES = new Uint8Array([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

/**
 * v17 portfolio account total size.
 *
 * Computed from: HEADER_LEN(16) + sizeof(PortfolioAccountV16Account) + PORTFOLIO_MATCHER_CONFIG_LEN(104).
 * sizeof(PortfolioAccountV16Account) = ProvenanceHeader(100) + owner(32) + capital(16) + pnl(16) +
 *   reserved_pnl(16) + residual_crystallized_loss_atoms_total(16) + residual_spent_principal_atoms_total(16) +
 *   residual_received_atoms_total(16) + fee_credits(16) + cancel_deposit_escrow(16) +
 *   last_fee_slot(8) + active_bitmap(8) + legs[16](16×144=2304) +
 *   source_domains[32](32×196=6272) + health_cert(121) + stale_state(1) + b_stale_state(1) +
 *   rebalance_lock(1) + liquidation_lock(1) + close_progress(184) + resolved_payout_receipt(66) = 9227.
 * Total = 16 + 9227 + 104 = 9347. (CloseProgressLedgerV16Account is 184 bytes, not 188 — all V16PodU*
 * fields are align-1 byte arrays, no padding. sizeof(PortfolioAccountV16Account)=9227.)
 *
 * DESYNC-2/3 FIX: Used as the EXACT dataSize filter when querying portfolio accounts; must equal
 * constants::PORTFOLIO_ACCOUNT_LEN in percolator-prog or getProgramAccounts matches zero accounts.
 */
const V17_PORTFOLIO_ACCOUNT_LEN = 9347;

/**
 * Offset of the market_group_id field within a v17 portfolio account.
 * Located at the start of the ProvenanceHeaderV16Account = bytes [16..48].
 *
 * Used in the memcmp filter: offset=16, bytes=market_pubkey_base58.
 * This lets getProgramAccounts return only portfolios for a specific market.
 */
const V17_PORTFOLIO_MARKET_GROUP_MEMCMP_OFFSET = 16;

/**
 * Offset of the owner pubkey within a v17 portfolio account.
 * ProvenanceHeader starts at offset 16, owner is at offset 64 within the provenance
 * header (market_group_id[32] + portfolio_account_id[32] = 64 bytes before owner).
 * So: 16 + 64 = 80.
 */
const V17_PORTFOLIO_OWNER_MEMCMP_OFFSET = 80;

/**
 * Build a base58-encoded memcmp bytes string from a raw Uint8Array.
 * Used to create the `bytes` value for getProgramAccounts memcmp filters.
 */
function toBase58Memcmp(bytes: Uint8Array): string {
  return new PublicKey(bytes).toBase58();
}

/**
 * Map a v17 WrapperConfigV17 to the legacy MarketConfig shape expected by DiscoveredMarket.
 *
 * v17 has a completely different config layout from v12.x. Fields that don't exist in v17
 * are stubbed with zero/empty values. Fields that have direct equivalents are mapped.
 *
 * This bridge is necessary because DiscoveredMarket.config is typed as MarketConfig and
 * is consumed by oracle resolution (oracleAuthority, indexFeedId) and crank logic.
 */
function wrapperConfigV17ToMarketConfig(cfg: ReturnType<typeof parseWrapperConfigV17>): DiscoveredMarket["config"] {
  const zeroKey = PublicKey.default;
  const oracleMode = cfg.oracleMode;
  // Program enum (v16_program.rs:75-78):
  //   MANUAL=0, HYBRID_AFTER_HOURS=1, EWMA_MARK=2, AUTH_MARK=3
  //
  // Only AUTH_MARK(3) is keeper-authority-gated (the keeper must push prices via
  // RestartAssetOracle / UpdateAuthMark). EWMA_MARK(2) uses the stored mark_ewma_e6
  // and is also keeper-authority-gated for price pushes but PermissionlessCrank is
  // permissionless for it. HYBRID_AFTER_HOURS(1) reads external Pyth accounts from
  // the crank account-tail — PermissionlessCrank is permissionless and does NOT
  // require the keeper to be the oracle authority.
  //
  // Bug fix: previous code set isAdminOracle=true for modes 1 and 2, which caused
  // HYBRID_AFTER_HOURS(1) markets to get oracleAuthority=marketauth and be skipped
  // by the foreign-oracle guard in crankAll (crank.ts:1511). Correct mapping:
  //   - AUTH_MARK(3): isAdminOracle=true, oracleAuthority=marketauth, indexFeedId=zero
  //   - EWMA_MARK(2): isAdminOracle=false for skip-guard; oracleAuthority=zero (no ext key)
  //   - HYBRID_AFTER_HOURS(1): isAdminOracle=false; indexFeedId=oracleLegFeeds[0] so
  //       resolveOracleKey derives the correct Pyth push-oracle PDA
  //   - MANUAL(0): isAdminOracle=false; indexFeedId=zero (slab placeholder used)
  const isAdminOracle = oracleMode === 3; // AUTH_MARK only
  const oracleAuthority = isAdminOracle ? cfg.marketauth : zeroKey;
  // HYBRID_AFTER_HOURS uses oracle_leg_feeds for the external Pyth price source.
  // Set indexFeedId so resolveOracleKey can derive the Pyth push-oracle PDA.
  const indexFeedId = (oracleMode === 1 && cfg.oracleLegFeeds.length > 0)
    ? cfg.oracleLegFeeds[0]!
    : zeroKey;

  return {
    collateralMint: cfg.collateralMint,
    vaultPubkey: zeroKey,              // v17: vault is managed differently (program-owned)
    indexFeedId,
    maxStalenessSlots: cfg.maxStalenessSecs,
    confFilterBps: cfg.confFilterBps,
    vaultAuthorityBump: 0,
    invert: cfg.invert,
    unitScale: cfg.unitScale,
    fundingHorizonSlots: 0n,
    fundingKBps: 0n,
    fundingInvScaleNotionalE6: 0n,
    fundingMaxPremiumBps: 0n,
    fundingMaxBpsPerSlot: 0n,
    threshFloor: 0n,
    threshRiskBps: 0n,
    threshUpdateIntervalSlots: 0n,
    threshStepBps: 0n,
    threshAlphaBps: 0n,
    threshMin: 0n,
    threshMax: 0n,
    threshMinStep: 0n,
    oracleAuthority,
    authorityPriceE6: cfg.oracleTargetPriceE6,
    authorityTimestamp: cfg.oracleTargetPublishTime,
    oraclePriceCapE2bps: 0n,
    lastEffectivePriceE6: cfg.markEwmaE6,
    oiCapMultiplierBps: 0n,
    maxPnlCap: 0n,
    adaptiveFundingEnabled: false,
    adaptiveScaleBps: 0,
    adaptiveMaxFundingBps: 0n,
    marketCreatedSlot: 0n,
    oiRampSlots: 0n,
    resolvedSlot: 0n,
    insuranceIsolationBps: 0,
    oraclePhase: 0,
    cumulativeVolumeE6: 0n,
    phase2DeltaSlots: 0,
    dexPool: null,
  };
}

/**
 * DESYNC-1 FIX: Discover v17 market group accounts for a given program.
 *
 * v17 market group accounts use a different magic (PERCV16\0) from the legacy
 * TALOCREP magic used by v12.x slabs. The SDK's discoverMarkets() only recognises
 * v12.x accounts. This function performs a separate getProgramAccounts query
 * filtered on the v17 magic bytes to find v17 markets.
 *
 * Returns an array of DiscoveredMarket objects compatible with the rest of the
 * keeper crank/liquidation pipeline. Fields that don't exist in v17 are zero-filled.
 */
async function discoverV17Markets(
  connection: Connection,
  programId: PublicKey,
): Promise<DiscoveredMarket[]> {
  // memcmp `bytes` must encode the EXACT raw bytes to match. Use base64 (web3.js >=1.87) so
  // sub-32-byte filters work — `new PublicKey(bytes)` left-pads to 32 bytes and base58.slice() is
  // not byte-aligned, both of which previously made these filters match ZERO v17 accounts.
  const v17MagicBase64 = Buffer.from(V17_MAGIC_BYTES).toString("base64"); // 8-byte MAGIC at offset 0
  const kindMarketBase64 = Buffer.from(Uint8Array.from([1])).toString("base64"); // KIND_MARKET=1 at offset 10
  let rawAccounts: ReadonlyArray<{ pubkey: PublicKey; account: { data: Buffer | Uint8Array; owner: PublicKey } }>;
  try {
    rawAccounts = await withTimeout(
      connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: v17MagicBase64,
              encoding: "base64",
            },
          },
          // Filter for market group accounts (kind byte = 1 at offset 10)
          {
            memcmp: {
              offset: 10,
              bytes: kindMarketBase64,
              encoding: "base64",
            },
          },
        ],
        dataSlice: { offset: 0, length: V17_RISK_PARAMS_MIN_DATA_LEN },
      }),
      RPC_TIMEOUT_MS * 2,
      `discoverV17Markets(${programId.toBase58().slice(0, 8)})`,
    );
  } catch (err) {
    logger.warn("discoverV17Markets: getProgramAccounts failed", {
      programId: programId.toBase58(),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const markets: DiscoveredMarket[] = [];
  for (const { pubkey, account } of rawAccounts) {
    try {
      const data = new Uint8Array(account.data);
      if (!isV17Account(data)) continue;

      // Parse the v17 wrapper config (starts at offset 16, 432 bytes)
      const wrapperCfg = parseWrapperConfigV17(data);
      const marketConfig = wrapperConfigV17ToMarketConfig(wrapperCfg);

      // Stub engine/header with zero values — these fields are read from
      // the market group account's dynamic section. Risk params are parsed
      // from the v17 market-group header below, because liquidation logic
      // must not assume every market uses the 500 bps default.
      const stubEngine = {
        vault: 0n, insuranceFund: { balance: 0n, feeRevenue: 0n, isolatedBalance: 0n, isolationBps: 0 },
        currentSlot: 0n, fundingIndexQpbE6: 0n, lastFundingSlot: 0n,
        fundingRateBpsPerSlotLast: 0n, fundingRateE9: 0n, marketMode: null,
        lastCrankSlot: 0n, maxCrankStalenessSlots: 0n, totalOpenInterest: 0n,
        longOi: 0n, shortOi: 0n, cTot: 0n, pnlPosTot: 0n, pnlMaturedPosTot: 0n,
        liqCursor: 0, gcCursor: 0, lastSweepStartSlot: 0n, lastSweepCompleteSlot: 0n,
        crankCursor: 0, sweepStartIdx: 0, lifetimeLiquidations: 0n, lifetimeForceCloses: 0n,
        netLpPos: 0n, lpSumAbs: 0n, lpMaxAbs: 0n, lpMaxAbsSweep: 0n,
        emergencyOiMode: false, emergencyStartSlot: 0n, lastBreakerSlot: 0n,
        markPriceE6: 0n, oraclePriceE6: 0n, fLongNum: 0n, fShortNum: 0n,
        negPnlAccountCount: 0n, fundPxLast: 0n,
        resolvedKLongTerminalDelta: 0n, resolvedKShortTerminalDelta: 0n, resolvedLivePrice: 0n,
        numUsedAccounts: 0, nextAccountId: 0n,
      };
      const v17Params = parseV17RiskParams(data);
      const stubHeader = {
        magic: 0n, version: 16, kind: 1,
        marketCreatedSlot: 0n, resolvedSlot: 0n,
      };

      const market: DiscoveredMarket & { _rawV17Config?: ReturnType<typeof parseWrapperConfigV17> } = {
        slabAddress: pubkey,
        programId,
        header: stubHeader as never,
        config: marketConfig,
        engine: stubEngine as never,
        params: v17Params as never,
      };
      // Attach raw v17 config for multi-leg HYBRID_AFTER_HOURS oracle tail construction.
      market._rawV17Config = wrapperCfg;
      markets.push(market);
    } catch (err) {
      logger.debug("discoverV17Markets: failed to parse account", {
        pubkey: pubkey.toBase58().slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return markets;
}

/**
 * DESYNC-1 FIX (MARKETS_FILTER path): Try to parse a raw account buffer as a
 * DiscoveredMarket, routing v17 accounts through parseWrapperConfigV17 and
 * legacy accounts through parseHeader/parseConfig/parseEngine/parseParams.
 *
 * Returns null if the account cannot be parsed.
 */
function parseMarketFromAccountData(
  pubkey: PublicKey,
  programId: PublicKey,
  data: Uint8Array,
): DiscoveredMarket | null {
  try {
    if (isV17Account(data)) {
      // v17 market group account
      const wrapperCfg = parseWrapperConfigV17(data);
      const marketConfig = wrapperConfigV17ToMarketConfig(wrapperCfg);
      const stubEngine = {
        vault: 0n, insuranceFund: { balance: 0n, feeRevenue: 0n, isolatedBalance: 0n, isolationBps: 0 },
        currentSlot: 0n, fundingIndexQpbE6: 0n, lastFundingSlot: 0n,
        fundingRateBpsPerSlotLast: 0n, fundingRateE9: 0n, marketMode: null,
        lastCrankSlot: 0n, maxCrankStalenessSlots: 0n, totalOpenInterest: 0n,
        longOi: 0n, shortOi: 0n, cTot: 0n, pnlPosTot: 0n, pnlMaturedPosTot: 0n,
        liqCursor: 0, gcCursor: 0, lastSweepStartSlot: 0n, lastSweepCompleteSlot: 0n,
        crankCursor: 0, sweepStartIdx: 0, lifetimeLiquidations: 0n, lifetimeForceCloses: 0n,
        netLpPos: 0n, lpSumAbs: 0n, lpMaxAbs: 0n, lpMaxAbsSweep: 0n,
        emergencyOiMode: false, emergencyStartSlot: 0n, lastBreakerSlot: 0n,
        markPriceE6: 0n, oraclePriceE6: 0n, fLongNum: 0n, fShortNum: 0n,
        negPnlAccountCount: 0n, fundPxLast: 0n,
        resolvedKLongTerminalDelta: 0n, resolvedKShortTerminalDelta: 0n, resolvedLivePrice: 0n,
        numUsedAccounts: 0, nextAccountId: 0n,
      };
      const v17Params = parseV17RiskParams(data);
      const stubHeader = { magic: 0n, version: 16, kind: 1, marketCreatedSlot: 0n, resolvedSlot: 0n };
      const market: DiscoveredMarket & { _rawV17Config?: ReturnType<typeof parseWrapperConfigV17> } = {
        slabAddress: pubkey, programId,
        header: stubHeader as never,
        config: marketConfig,
        engine: stubEngine as never,
        params: v17Params as never,
      };
      market._rawV17Config = wrapperCfg;
      return market;
    }
    // Legacy v12.x slab
    const header = parseHeader(data);
    const marketConfig = parseConfig(data);
    const engine = parseEngine(data);
    const params = parseParams(data);
    return { slabAddress: pubkey, programId, header, config: marketConfig, engine, params };
  } catch {
    return null;
  }
}

/**
 * DESYNC-2 FIX: Provision (find or create) the keeper's portfolio for a market.
 *
 * The v17 PermissionlessCrank requires account[2] to be the cranker's own portfolio.
 * On first discovery of each market, the keeper must either locate its existing portfolio
 * account or submit InitPortfolio (tag 1) to create one.
 *
 * Portfolio accounts for the keeper are found via:
 *   getProgramAccounts(programId, {
 *     filters: [
 *       { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
 *       { memcmp: { offset: V17_PORTFOLIO_MARKET_GROUP_MEMCMP_OFFSET, bytes: marketKey } },
 *       { memcmp: { offset: V17_PORTFOLIO_OWNER_MEMCMP_OFFSET, bytes: keeperKey } },
 *     ]
 *   })
 *
 * If no portfolio exists, submit InitPortfolio (tag 1) with:
 *   accounts: [keeper(s,w), market(w), portfolio(w)]
 *   data: [1]  (tag byte only)
 *
 * Returns the portfolio pubkey on success, null on failure.
 */
async function provisionKeeperPortfolio(
  connection: Connection,
  programId: PublicKey,
  marketPubkey: PublicKey,
  keeperPublicKey: PublicKey,
  keypair: import("@solana/web3.js").Keypair,
): Promise<PublicKey | null> {
  const marketKeyBase58 = marketPubkey.toBase58();
  const keeperKeyBase58 = keeperPublicKey.toBase58();

  // Query for the keeper's existing portfolio on this market
  let portfolioPubkey: PublicKey | null = null;
  try {
    const existing = await withTimeout(
      connection.getProgramAccounts(programId, {
        filters: [
          { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
          {
            memcmp: {
              offset: V17_PORTFOLIO_MARKET_GROUP_MEMCMP_OFFSET,
              bytes: marketKeyBase58,
            },
          },
          {
            memcmp: {
              offset: V17_PORTFOLIO_OWNER_MEMCMP_OFFSET,
              bytes: keeperKeyBase58,
            },
          },
        ],
      }),
      RPC_TIMEOUT_MS,
      "provisionKeeperPortfolio:getProgramAccounts",
    );
    if (existing.length > 0 && existing[0]) {
      // Verify it is indeed a portfolio account by parsing
      try {
        const data = new Uint8Array(existing[0].account.data);
        const parsed = parsePortfolioV17(data);
        if (parsed.owner.equals(keeperPublicKey)) {
          portfolioPubkey = existing[0].pubkey;
          logger.debug("Found existing keeper portfolio", {
            market: marketKeyBase58.slice(0, 8),
            portfolio: portfolioPubkey.toBase58().slice(0, 8),
          });
          return portfolioPubkey;
        }
      } catch (parseErr) {
        logger.debug("provisionKeeperPortfolio: failed to parse found account, skipping", {
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    }
  } catch (rpcErr) {
    logger.warn("provisionKeeperPortfolio: getProgramAccounts failed", {
      market: marketKeyBase58.slice(0, 8),
      error: rpcErr instanceof Error ? rpcErr.message : String(rpcErr),
    });
    return null;
  }

  // No portfolio found — create one via SystemProgram.createAccount + InitPortfolio (tag 1).
  //
  // Account layout for InitPortfolio (v16_program.rs:6437-6442):
  //   [0] owner (signer, writable)
  //   [1] market (writable)
  //   [2] portfolio (writable, program-owned)
  //
  // The portfolio account must be pre-funded for FULL V17_PORTFOLIO_ACCOUNT_LEN (9347) bytes:
  // v16_program.rs:6457 calls realloc ONLY IF data_len < required — it does NOT add lamports,
  // so the account must already hold rent for the full size (9347). Create via SystemProgram.
  //
  // The market must be in Live mode (v16_program.rs:6450) for InitPortfolio to succeed.
  // AlreadyInitialized (v16_program.rs:6445) is treated as success (concurrent provision race).
  const portfolioKeypair = Keypair.generate();
  const inFlightKey = `provision:${marketKeyBase58}`;

  // Guard: if another async context is already provisioning this market, bail out.
  if ((provisionKeeperPortfolio as unknown as { _inflight?: Set<string> })._inflight?.has(inFlightKey)) {
    logger.debug("provisionKeeperPortfolio: in-flight for market, skipping duplicate provision", {
      market: marketKeyBase58.slice(0, 8),
    });
    return null;
  }
  const inFlight = (provisionKeeperPortfolio as unknown as { _inflight?: Set<string> })._inflight ??
    ((provisionKeeperPortfolio as unknown as { _inflight?: Set<string> })._inflight = new Set<string>());
  inFlight.add(inFlightKey);

  try {
    const rentLamports = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: keeperPublicKey,
      newAccountPubkey: portfolioKeypair.publicKey,
      lamports: rentLamports,
      space: V17_PORTFOLIO_ACCOUNT_LEN,
      programId,
    });

    const initPortfolioData = encodeInitUser();
    const initPortfolioIx = buildIx({
      programId,
      keys: [
        { pubkey: keeperPublicKey,           isSigner: true,  isWritable: true  },
        { pubkey: marketPubkey,              isSigner: false, isWritable: true  },
        { pubkey: portfolioKeypair.publicKey, isSigner: false, isWritable: true  },
      ],
      data: initPortfolioData,
    });

    const sendResult = await sharedTxQueue.enqueue("crank", () =>
      keeperSend(connection, [createAccountIx, initPortfolioIx], [keypair, portfolioKeypair], "crank", sharedBudget, 3, {
        skipPreflight: false,
        multiRpcBroadcast: false,
        simulateForCU: false,
      }, rentLamports),
    );

    if (!sendResult) {
      logger.warn("provisionKeeperPortfolio: send returned null", {
        market: marketKeyBase58.slice(0, 8),
      });
      return null;
    }

    logger.info("Keeper portfolio provisioned via InitPortfolio", {
      market: marketKeyBase58.slice(0, 8),
      portfolio: portfolioKeypair.publicKey.toBase58().slice(0, 8),
      signature: sendResult.signature,
    });
    return portfolioKeypair.publicKey;
  } catch (provisionErr) {
    const errMsg = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
    // AlreadyInitialized: a concurrent provision beat us; re-query for the existing portfolio.
    if (errMsg.includes("AlreadyInitialized") || errMsg.includes("custom program error: 0x0")) {
      logger.info("provisionKeeperPortfolio: AlreadyInitialized — re-querying for existing portfolio", {
        market: marketKeyBase58.slice(0, 8),
      });
      try {
        const existing2 = await withTimeout(
          connection.getProgramAccounts(programId, {
            filters: [
              { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
              { memcmp: { offset: V17_PORTFOLIO_MARKET_GROUP_MEMCMP_OFFSET, bytes: marketKeyBase58 } },
              { memcmp: { offset: V17_PORTFOLIO_OWNER_MEMCMP_OFFSET, bytes: keeperKeyBase58 } },
            ],
          }),
          RPC_TIMEOUT_MS,
          "provisionKeeperPortfolio:requery",
        );
        if (existing2.length > 0 && existing2[0]) {
          return existing2[0].pubkey;
        }
      } catch {
        // ignore — fall through to null
      }
    } else {
      logger.warn("provisionKeeperPortfolio: InitPortfolio failed", {
        market: marketKeyBase58.slice(0, 8),
        error: errMsg.slice(0, 200),
      });
    }
    return null;
  } finally {
    inFlight.delete(inFlightKey);
  }
}

/**
 * DESYNC-5 FIX: Submit LpVaultCrankFees (tag 78) for a market that has an LP vault.
 *
 * This instruction is permissionless and must be submitted periodically so LP
 * depositors receive their pro-rata fee share. Without this call the backing
 * domain ledger drifts from reality and redemption payouts are inaccurate.
 *
 * Account layout (verified against v16_program.rs handle_lp_vault_crank_fees):
 *   [0] cranker (signer, any key)
 *   [1] market (writable)
 *   [2] registry (writable, PDA ["lp_vault", market])
 *   [3] ledger (writable, PDA ["lp_backing_ledger", market, u16LE(domain)])
 *
 * The registry's domain field tells us which backing domain index to use.
 * Defaults to domain=0 for single-asset markets.
 *
 * Returns the tx signature on success, null on error or if no LP vault exists.
 */
async function crankLpVault(
  connection: Connection,
  programId: PublicKey,
  market: DiscoveredMarket,
  keypair: import("@solana/web3.js").Keypair,
): Promise<string | null> {
  const [registryPda] = deriveLpVaultRegistry(programId, market.slabAddress);

  // Check if the LP vault registry account exists
  let registryData: Uint8Array;
  try {
    const info = await withTimeout(
      connection.getAccountInfo(registryPda),
      RPC_TIMEOUT_MS,
      `getAccountInfo(lpVaultRegistry:${registryPda.toBase58().slice(0, 8)})`,
    );
    if (!info?.data) {
      // No LP vault for this market — that's normal, skip silently
      return null;
    }
    registryData = new Uint8Array(info.data);
  } catch (err) {
    logger.debug("crankLpVault: failed to fetch registry", {
      market: market.slabAddress.toBase58().slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Parse the registry to get the domain index
  let domainIdx = 0;
  try {
    const registry = parseLpVaultRegistry(registryData);
    domainIdx = registry.domain;
  } catch (parseErr) {
    logger.debug("crankLpVault: failed to parse LP vault registry", {
      market: market.slabAddress.toBase58().slice(0, 8),
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    // Default to domain 0 — matches single-asset market behavior
    domainIdx = 0;
  }

  const [ledgerPda] = deriveLpBackingLedger(programId, market.slabAddress, domainIdx);
  const data = encodeLpVaultCrankFees();
  const keys = [
    { pubkey: keypair.publicKey, isSigner: true,  isWritable: false },
    { pubkey: market.slabAddress, isSigner: false, isWritable: true  },
    { pubkey: registryPda,        isSigner: false, isWritable: true  },
    { pubkey: ledgerPda,          isSigner: false, isWritable: true  },
  ];
  const ix = buildIx({ programId, keys, data });

  try {
    const sendResult = await sharedTxQueue.enqueue("crank", () =>
      keeperSend(connection, [ix], [keypair], "crank", sharedBudget, 2, {
        skipPreflight: true,
        multiRpcBroadcast: false,
        simulateForCU: false,
      }),
    );
    if (!sendResult) return null;
    logger.info("LpVaultCrankFees sent", {
      market: market.slabAddress.toBase58().slice(0, 8),
      domain: domainIdx,
      signature: sendResult.signature,
    });
    return sendResult.signature;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // LpVaultNoFeesToCrank (Custom error) is expected when delta==0 — log at debug
    if (errMsg.includes("Custom") || errMsg.includes("custom program error")) {
      logger.debug("LpVaultCrankFees: no fees to crank (delta==0)", {
        market: market.slabAddress.toBase58().slice(0, 8),
      });
    } else {
      logger.warn("LpVaultCrankFees failed", {
        market: market.slabAddress.toBase58().slice(0, 8),
        error: errMsg.slice(0, 120),
      });
    }
    return null;
  }
}

// Silence unused-variable lint — V17_MAGIC_BYTES is used in discoverV17Markets but referenced
// inside a closure so TS may not see direct usage.
void V17_MAGIC_BYTES;

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
   * v17: The keeper's own portfolio account on this market.
   * Used as account[2] in PermissionlessCrank (FeeSweep) and appended as the
   * last oracle-tail account in PermissionlessCrank (Liquidate) to receive
   * the liquidation-cranker fee share.
   * Null until provisioned via InitPortfolio.
   */
  keeperPortfolio?: PublicKey | null;
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
  fn: (item: T) => Promise<CrankResult>,
): Promise<{ succeeded: number; failed: number; skipped: number; errors: Map<string, Error> }> {
  const errors = new Map<string, Error>();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    type ItemOutcome =
      | { kind: "res"; value: CrankResult }
      | { kind: "threw"; itemKey: string; error: Error };
    const outcomes: ItemOutcome[] = await Promise.all(
      batch.map(async (item): Promise<ItemOutcome> => {
        try {
          const res = await fn(item);
          return { kind: "res", value: res };
        } catch (err) {
          const itemKey = String(item);
          const errorObj = err instanceof Error ? err : new Error(String(err));
          return { kind: "threw", itemKey, error: errorObj };
        }
      }),
    );
    for (const o of outcomes) {
      if (o.kind === "res") {
        if (o.value === "success") succeeded++;
        else if (o.value === "skipped") skipped++;
        else failed++;
      } else {
        failed++;
        errors.set(o.itemKey, o.error);
        logger.error("Batch item failed", { item: o.itemKey, error: o.error.message });
      }
    }
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { succeeded, failed, skipped, errors };
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
  private _isRunning = false;
  private _cycling = false;
  private _cycleStartedAt = 0;
  // H4 (HIGH): wall-clock timestamp (ms) at which the watchdog first observed
  // the current cycle exceeding MAX_CYCLE_MS. 0 when the watchdog is disarmed.
  // The watchdog arms once, alerts once, and waits WATCHDOG_GRACE_MS before
  // calling process.exit(1) for supervisor restart. It does NOT reset
  // `_cycling` directly — flipping that flag while the in-flight cycle's
  // Promise.all is still awaiting allows the next interval tick to launch a
  // SECOND concurrent crankAll(), producing duplicate KeeperCrank txs +
  // doubled funding accrual + RPC storms. Cleared on natural cycle recovery
  // (the finally block) so transient slow cycles don't kill the process.
  private _watchdogArmedAt = 0;
  // M8: per-market in-flight guard. `_cycling` is a process-wide flag for
  // the timer-driven crankAll cycle, but other entry points (registerMarket
  // from the /register HTTP endpoint, and potentially LaserStream debounce
  // handlers) can call crankMarket directly — bypassing `_cycling`. Without
  // this guard, a /register HTTP arriving mid-cycle could fire crankMarket
  // concurrently with crankAll's fan-out on the same slab, producing
  // duplicate KeeperCrank txs for the same market. Set/delete at crankMarket
  // entry/exit so every code path that reaches crankMarket honors the same
  // in-flight invariant.
  private _inflightMarkets = new Set<string>();
  /** Per-market in-flight guard for LP-vault maintenance — mirrors _inflightMarkets. */
  private _inflightLpVaultMarkets = new Set<string>();
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
   * v17 markets need a keeper-owned portfolio before PermissionlessCrank can run.
   * Provisioning can fail transiently, so discovery calls this on first insert and
   * again on rediscovery while keeperPortfolio is still null.
   */
  private async ensureKeeperPortfolio(key: string, market: DiscoveredMarket): Promise<PublicKey | null> {
    try {
      const connection = getConnection();
      const keypair = this._keypair;
      const portfolio = await provisionKeeperPortfolio(
        connection,
        market.programId,
        market.slabAddress,
        keypair.publicKey,
        keypair,
      );
      const state = this.markets.get(key);
      if (state) {
        state.keeperPortfolio = portfolio;
        if (portfolio) {
          logger.info("Keeper portfolio provisioned", {
            market: key.slice(0, 8),
            portfolio: portfolio.toBase58().slice(0, 8),
          });
        }
      }
      return portfolio;
    } catch (provErr) {
      logger.debug("Portfolio provisioning deferred", {
        market: key.slice(0, 8),
        error: provErr instanceof Error ? provErr.message : String(provErr),
      });
      return null;
    }
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

  /**
   * M-1: the three recoverable-state transitions below only require the
   * market's own existing state (no fresh RPC discovery data), so they apply
   * equally whether a market was just refreshed via the LaserStream fast
   * path or via a full getProgramAccounts/MARKETS_FILTER rediscovery. They
   * were previously inlined only in the full-rediscover branch, so a market
   * stuck with elevated consecutiveFailures, foreignOracleSkipped=true, or in
   * permanentlySkipped cooldown would not self-heal via the fast path for up
   * to KEEPER_FULL_REDISCOVER_INTERVAL_MS (default 30 min) once LaserStream
   * is enabled. Dead-market eviction (missingDiscoveryCount) is deliberately
   * NOT included here -- it requires the full set of markets actually found
   * by this cycle's RPC discovery to know what's missing, which the fast
   * path (by design) never computes.
   */
  private _resetRecoverableMarketState(key: string, state: MarketCrankState): void {
    // P1 FIX: Reset consecutiveFailures so markets can recover.
    if (state.consecutiveFailures > 0) {
      logger.debug("Resetting consecutive failures on rediscovery", {
        slabAddress: key,
        previousFailures: state.consecutiveFailures,
      });
      state.consecutiveFailures = 0;
      state.isActive = true;
    }
    // GH#1508: Reset foreignOracleSkipped — oracle authority may have changed.
    // crankMarket() will re-check and re-set it if the keeper is still not the authority.
    if (state.foreignOracleSkipped) {
      state.foreignOracleSkipped = false;
      logger.debug("Re-checking foreign oracle skip on rediscovery", { slabAddress: key });
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
            const parsed = parseMarketFromAccountData(
              state.market.slabAddress,
              state.market.programId,
              entry.data,
            );
            if (parsed) {
              state.market.header = parsed.header;
              state.market.config = parsed.config;
              state.market.engine = parsed.engine;
              state.market.params = parsed.params;
              const parsedRawV17 = (parsed as DiscoveredMarket & {
                _rawV17Config?: ReturnType<typeof parseWrapperConfigV17>;
              })._rawV17Config;
              if (parsedRawV17) {
                (state.market as DiscoveredMarket & {
                  _rawV17Config?: ReturnType<typeof parseWrapperConfigV17>;
                })._rawV17Config = parsedRawV17;
              } else {
                delete (state.market as DiscoveredMarket & {
                  _rawV17Config?: ReturnType<typeof parseWrapperConfigV17>;
                })._rawV17Config;
              }
              cacheHits++;
            }
          }

          // v17 markets need a keeper-owned portfolio before PermissionlessCrank
          // can run. Normal rediscovery retries this when keeperPortfolio is
          // still null; keep the LaserStream fast path consistent so a transient
          // provisioning failure does not leave an already-known market
          // discovered-but-uncrankable until the next full rediscovery.
          const header = state.market.header as
            | { version?: number | bigint; kind?: number | bigint }
            | undefined;
          const isV17Market =
            Boolean((state.market as DiscoveredMarket & { _rawV17Config?: unknown })._rawV17Config) ||
            (header !== undefined && Number(header.version) === 16 && Number(header.kind) === 1);

          // Fix #332: do NOT eagerly provision here (LaserStream fast path).
          // Eager provisioning in the fast path drains keeper SOL on every
          // 30-second cache refresh even if the portfolio will never be needed.
          // The full discover path (every KEEPER_FULL_REDISCOVER_INTERVAL_MS)
          // calls ensureKeeperPortfolio and is the correct place for provisioning.
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
      // Mirror registerMarket()'s owner allow-list (crank.ts: knownIds check):
      // only track slabs owned by an allow-listed Percolator program, so the
      // keeper never signs txs against an account owned by an arbitrary program.
      const knownIds = new Set(config.allProgramIds);
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
          // Security (main hardening): reject slabs owned by a non-allow-listed program
          // before parsing — mirrors registerMarket. Prevents signing txs against a hostile program.
          if (!knownIds.has(info.owner.toBase58())) {
            logger.warn("MARKETS_FILTER: slab owned by non-allow-listed program — skipping", {
              slab: pubkey.toBase58().slice(0, 8),
              owner: info.owner.toBase58(),
            });
            continue;
          }
          // DESYNC-1 FIX: route v17 accounts through parseWrapperConfigV17,
          // legacy v12.x accounts through the standard parse pipeline.
          const data = new Uint8Array(info.data);
          const market = parseMarketFromAccountData(pubkey, info.owner, data);
          if (market) {
            allFound.push(market);
            succeededProgramIds.add(info.owner.toBase58());
          } else {
            logger.warn("MARKETS_FILTER: failed to parse slab", {
              slab: pubkey.toBase58().slice(0, 8),
              isV17: isV17Account(data),
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

      // DESYNC-1 FIX: Also discover v17 market group accounts for this program.
      // The SDK's discoverMarkets() only recognizes legacy TALOCREP magic and will
      // never return v17 accounts. We run a separate memcmp-filtered query here.
      try {
        const v17Found = await discoverV17Markets(discoveryConn, new PublicKey(id));
        if (v17Found.length > 0) {
          logger.info("v17 market discovery found accounts", { programId: id, count: v17Found.length });
          allFound.push(...v17Found);
          succeededProgramIds.add(id);
        }
      } catch (v17Err) {
        logger.debug("v17 market discovery error (non-fatal)", {
          programId: id,
          error: v17Err instanceof Error ? v17Err.message : String(v17Err),
        });
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

    // Fetch mainnet_ca from Supabase for price lookup overrides on devnet Quick Launch markets.
    const slabAddresses = discovered.map((m) => m.slabAddress.toBase58());
    let dbMarkets: Map<string, { mainnetCA?: string }> = new Map();
    try {
      const { data, error } = await getSupabase()
        .from("markets")
        .select("slab_address, mainnet_ca")
        .in("slab_address", slabAddresses);
      if (error) {
        logger.warn("Supabase market metadata query error", { error: error.message });
      }
      if (data) {
        const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
        // M3: Validate each field independently — don't discard the entire row
        // when only one field is invalid.
        for (const row of data) {
          let ca = row.mainnet_ca ?? undefined;
          if (ca && !base58Re.test(ca)) {
            logger.warn("Invalid mainnet_ca from Supabase, ignoring field", { slabAddress: row.slab_address, mainnetCA: ca });
            ca = undefined;
          }
          dbMarkets.set(row.slab_address, { mainnetCA: ca });
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
          mainnetCA: dbMeta?.mainnetCA,
          // v17: keeperPortfolio is null until provisioned via InitPortfolio.
          // crankMarket() skips the market if this is null.
          keeperPortfolio: null,
        });
        // DESYNC-2 FIX: Provision keeper portfolio for newly discovered v17 markets.
        // We fire this asynchronously so it doesn't block the discovery loop.
        // The provisioning result updates state.keeperPortfolio in place.
        // If provisioning fails (network error or portfolio already being created),
        // the market will be skipped this cycle and retried on next discovery.
        void this.ensureKeeperPortfolio(key, market);
      } else {
        const state = this.markets.get(key)!;
        state.market = market;
        if (!state.keeperPortfolio) {
          void this.ensureKeeperPortfolio(key, market);
        }
        // Update mainnetCA from Supabase on every discovery.
        // Use explicit undefined check so a DB null/removal clears stale values (not just truthy-set).
        if (dbMeta !== undefined) {
          state.mainnetCA = dbMeta.mainnetCA;
        }
        state.missingDiscoveryCount = 0;
        // M-1: P1 FIX / GH#1508 / PERC-381 transitions extracted into the
        // shared helper so the LaserStream fast path applies them too.
        this._resetRecoverableMarketState(key, state);
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
   * Resolve the Pyth oracle account for a market.
   * Returns the slab address itself for admin-oracle or zero-feed markets
   * (HYPERP oracle mode was removed in v17 — tag 34 is now ConfigureHybridOracle).
   */
  private async resolveOracleKey(market: DiscoveredMarket): Promise<PublicKey> {
    if (this.isAdminOracle(market)) {
      return market.slabAddress;
    }
    const feedBytes = market.config.indexFeedId.toBytes();
    const isZeroFeed = feedBytes.every((b: number) => b === 0);
    if (isZeroFeed) {
      // Zero feed — use slab as oracle placeholder (no separate oracle account).
      return market.slabAddress;
    }
    // #179: Pyth vs Chainlink is indistinguishable from config alone — resolve by the
    // on-chain feed account OWNER so a Chainlink market gets index_feed_id (the aggregator
    // account itself) rather than a wrong derived Pyth PDA, which would make it never
    // crank/liquidate. resolveExternalOracleAccount caches per feed and falls back to the
    // Pyth PDA on lookup failure, so Pyth markets are unaffected.
    return resolveExternalOracleAccount(market.config.indexFeedId, getConnection());
  }

  /**
   * v17: HYPERP oracle mode (UpdateHyperpMark) was removed in v17 — tag 34 is now
   * ConfigureHybridOracle. This stub always returns false to satisfy code paths from
   * main that reference isHyperpOracle but are dead in the v17 branch.
   */
  private isHyperpOracle(_market: DiscoveredMarket): boolean {
    return false;
  }

  /**
   * Build the account keys for PermissionlessCrank.
   *
   * v17 layout: [owner(s,w), market(w), portfolio(w), ...oracleTail(r)]
   *
   * The oracle tail (account_tail) contains one oracle account per leg, in order
   * (hybrid_effective_price_for_crank_view @v16.rs:13522 reads oracle_accounts[0..count]).
   * For HYBRID_AFTER_HOURS (mode=1) with oracle_leg_count>1, ALL legs must be appended
   * in order so the program can read each leg's price.
   * For MANUAL/EWMA_MARK/AUTH_MARK the single oracleKey (slab placeholder) is used.
   */
  private async buildPermissionlessCrankKeys(
    owner: PublicKey,
    market: DiscoveredMarket,
    portfolio: PublicKey,
    oracleKey: PublicKey,
  ): Promise<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]> {
    const fixed: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
      { pubkey: owner,                isSigner: true,  isWritable: true  },
      { pubkey: market.slabAddress,   isSigner: false, isWritable: true  },
      { pubkey: portfolio,            isSigner: false, isWritable: true  },
    ];

    const oracleTail = await resolveV17OracleTail(
      market as unknown as Parameters<typeof resolveV17OracleTail>[0],
      oracleKey,
      getConnection(),
    );
    for (const pubkey of oracleTail) {
      fixed.push({ pubkey, isSigner: false, isWritable: false });
    }

    return fixed;
  }

  /** Check if a market is due for cranking based on activity */
  private isDue(state: MarketCrankState): boolean {
    const interval = state.isActive ? this.intervalMs : this.inactiveIntervalMs;
    return Date.now() - state.lastCrankTime >= interval;
  }

  /**
   * RestartAssetOracle (tag 69) — permissionless oracle recovery path.
   *
   * Sends a RestartAssetOracle instruction to un-stick a stale or hung oracle
   * on a given market/asset. Anyone can call this instruction.
   *
   * v17 account layout: [authority(s), market(w)]
   *
   * This is a keeper-initiated recovery path: if the keeper detects that a
   * market's oracle has been stale for too long (e.g., OracleInvalid 0xc on
   * every crank), it can try to restart the oracle with the last known price.
   *
   * @param slabAddress  The market slab address.
   * @param assetIndex   Asset/domain index (default 0 for single-asset markets).
   * @param initialPrice Initial mark price in e6 units (from last known good price).
   * @returns The transaction signature, or null on failure.
   */
  async restartOracle(
    slabAddress: string,
    assetIndex = 0,
    initialPrice: bigint = 0n,
  ): Promise<string | null> {
    const state = this.markets.get(slabAddress);
    if (!state) {
      logger.warn("restartOracle: market not found", { slabAddress });
      return null;
    }
    const connection = getConnection();
    const keypair = this._keypair;
    const programId = state.market.programId;

    let nowSlot: bigint;
    try {
      nowSlot = BigInt(await withTimeout(
        connection.getSlot("processed"),
        RPC_TIMEOUT_MS,
        "getSlot(restartOracle)",
      ));
    } catch {
      nowSlot = 0n;
    }

    const data = encodeRestartAssetOracle({ assetIndex, nowSlot, initialPrice });
    const keys = [
      { pubkey: keypair.publicKey,          isSigner: true,  isWritable: false },
      { pubkey: state.market.slabAddress,   isSigner: false, isWritable: true  },
    ];
    const instruction = buildIx({ programId, keys, data });

    try {
      const sendResult = await sharedTxQueue.enqueue("crank", () =>
        keeperSend(connection, [instruction], [keypair], "crank", sharedBudget, 3, KEEPER_SEND_OPTS),
      );
      if (!sendResult) return null;
      logger.info("RestartAssetOracle sent", { slabAddress, assetIndex, initialPrice: initialPrice.toString(), signature: sendResult.signature });
      return sendResult.signature;
    } catch (err) {
      logger.error("RestartAssetOracle failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async crankMarket(slabAddress: string): Promise<CrankResult> {
    // M8: per-market in-flight guard. Bail immediately if another caller is
    // already running crankMarket for this slab. Closes the race where the
    // /register HTTP endpoint and the timer-driven crankAll fan-out both
    // dispatch crankMarket for the same market — pre-fix this could produce
    // duplicate KeeperCrank txs since `_cycling` only gates the overall
    // crankAll loop, not the per-market work.
    if (this._inflightMarkets.has(slabAddress)) {
      logger.debug("crankMarket: in-flight for slab, skipping concurrent call", { slabAddress });
      return "skipped";
    }

    const state = this.markets.get(slabAddress);
    if (!state) {
      logger.warn("Market not found", { slabAddress });
      return "skipped";
    }

    const { market } = state;

    this._inflightMarkets.add(slabAddress);
    try {
      const connection = getConnection();
      const keypair = this._keypair;
      const programId = market.programId;

      // v17: PermissionlessCrank (tag 5) — per-portfolio/per-asset Refresh model.
      //
      // The keeper cranks its own portfolio (action=FeeSweep=0) to keep the
      // market's fee accrual and funding-rate accounting current. One portfolio
      // per market is provisioned on first discovery (keeperPortfolio).
      //
      // Account layout: [owner(s,w), market(w), portfolio(w), ...oracleTail(r)]
      //
      // The oracle tail contains the resolved oracle account for asset_index=0
      // (Pyth PriceUpdateV2 PDA for Pyth-pinned markets; slab itself for admin
      // oracle or zero-feed assets). Additional assets would add more tail entries
      // but for the single-asset v17 baseline one oracle is sufficient.
      //
      // v17 CRITICAL: funding_rate_e9 is always hardcoded to 0n by the encoder.
      // The program hard-rejects any nonzero value with InvalidInstructionData.
      // Note: HYPERP oracle mode (UpdateHyperpMark) was removed in v17. isHyperpOracle()
      // always returns false so the HYPERP branch (M10 config refresh) is dead code.

      // Skip if we don't yet have a keeper portfolio for this market.
      // Portfolio provisioning is done at discover() time; log once per market.
      if (!state.keeperPortfolio) {
        logger.debug("Skipping crank — keeper portfolio not provisioned yet", { slabAddress });
        return "skipped";
      }

      const oracleKey = await this.resolveOracleKey(market);

      // Fetch current slot for nowSlot arg (crank freshness check).
      let nowSlot: bigint;
      try {
        nowSlot = BigInt(await withTimeout(
          connection.getSlot("processed"),
          RPC_TIMEOUT_MS,
          "getSlot",
        ));
      } catch (err) {
        logger.warn("getSlot failed — skipping crank submission", {
          slabAddress,
          error: err instanceof Error ? err.message : String(err),
        });
        return "skipped";
      }

      const crankData = encodePermissionlessCrank({
        action: CrankAction.FeeSweep,
        assetIndex: 0,
        nowSlot,
        closeQ: 0n,
        feeBps: 0n,
        recoveryReason: 0,
      });

      const crankKeys = await this.buildPermissionlessCrankKeys(
        keypair.publicKey,
        market,
        state.keeperPortfolio,
        oracleKey,
      );

      const instructions: TransactionInstruction[] = [
        buildIx({ programId, keys: crankKeys, data: crankData }),
      ];

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
          return "failed";
        }
        sig = sendResult.signature;
        this._resetRecoverableMarketState(slabAddress, state);
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

      state.lastCrankTime = Date.now();
      state.successCount++;
      state.consecutiveFailures = 0;
      state.alertedAt5 = false; // B1: reset alert latch on success
      state.isActive = true;
      // B10: preserve lifetime failureCount — only per-streak counter resets.

      eventBus.publish("crank.success", slabAddress, { signature: sig });
      return "success";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errLower = errMsg.toLowerCase();

      // N2: Classify transient RPC/network errors — these should not count toward
      // the consecutiveFailures threshold that deactivates markets. A burst of 429s
      // during RPC congestion should not disable a healthy market.
      const isTransient =
        errLower.includes("429") ||
        errLower.includes("too many requests") ||
        errLower.includes("rate limit") ||
        errLower.includes("timeout") ||
        errLower.includes("socket") ||
        errLower.includes("econnrefused") ||
        errLower.includes("econnreset") ||
        errLower.includes("502") ||
        errLower.includes("503") ||
        errLower.includes("block height exceeded");

      state.failureCount++;
      txSentTotal.inc({ result: "fail", type: "crank" });
      if (!isTransient) {
        state.consecutiveFailures++;
      } else {
        logger.warn("Crank transient error — not counting toward deactivation", {
          slabAddress,
          error: errMsg.slice(0, 120),
          consecutiveFailures: state.consecutiveFailures,
        });
      }
      // M9: advance lastCrankTime on FAILURE too, not just success. Pre-fix,
      // `isDue` checks `Date.now() - state.lastCrankTime >= interval`. With
      // lastCrankTime only updated on success, a market that's been failing
      // every cycle had a stale lastCrankTime (or 0 if it never succeeded),
      // so isDue was always true. After 10 consecutive failures isActive
      // flips to false and the keeper SHOULD back off from intervalMs (30s)
      // to inactiveIntervalMs (120s) — but since lastCrankTime was stale,
      // the back-off never fired. Advancing here makes the inactive interval
      // honored: active-failing markets still retry every intervalMs (30s);
      // deactivated markets retry every inactiveIntervalMs (120s) as designed.
      state.lastCrankTime = Date.now();

      // v17: Detect PermissionlessCrank-specific rejection (Custom 37 = LpVaultNoNewFees).
      // This is not a permanent skip but indicates LP vault crank is a no-op this cycle.
      if (errMsg.includes("Custom\":37") || errMsg.includes("custom program error: 0x25")) {
        logger.error("PermissionlessCrank rejected (Custom 37 = LpVaultNoNewFees) — market configuration issue.", {
          slabAddress,
          programId: market.programId.toBase58(),
          consecutiveFailures: state.consecutiveFailures,
        });
      }

      // P1 FIX: Detect InsufficientDexLiquidity (error 0x33 = 51) specifically.
      // Retained from main for completeness (dead in v17 since HYPERP was removed, but
      // harmless to keep as a diagnostic if the error appears for other reasons).
      if (errMsg.includes("Custom\":51") || errMsg.includes("custom program error: 0x33")) {
        logger.error("InsufficientDexLiquidity — DEX pool does not meet program minimum liquidity threshold. " +
          "Fix: use a pool with more liquidity, or redeploy the program with a lower MIN_DEX_QUOTE_LIQUIDITY.", {
          slabAddress,
          programId: market.programId.toBase58(),
          consecutiveFailures: state.consecutiveFailures,
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
        return "skipped";
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
      return "failed";
    } finally {
      // M8: always release the per-market guard, even if the body throws or
      // returns early. JavaScript runs finally after `return` in the try/catch
      // above, so this fires on every code path.
      this._inflightMarkets.delete(slabAddress);
    }
  }

  async crankAll(): Promise<{ success: number; failed: number; skipped: number }> {
  const _crankAllStart = Date.now();
  let success = 0;
  let failed = 0;

  // Split skipped into categories for observability.
  let skippedPermanent = 0;
  let skippedForeignOracle = 0;
  let skippedNoPortfolio = 0;
  let skippedStalePaused = 0;
  let skippedFailures = 0;
  let skippedNotDue = 0;

  const MAX_CONSECUTIVE_FAILURES = 10;

  // Load the keeper key once here so we can check oracle authority live.
  const keeperKey = this._keypair.publicKey;

  const toCrank: string[] = [];

  for (const [slabAddress, state] of this.markets) {
    if (state.permanentlySkipped) {
      skippedPermanent++;
      txSentTotal.inc({ result: "drop", type: "crank" });
      continue;
    }
    // v17: admin-oracle markets where the keeper is NOT the oracle authority
    // cannot be cranked — the program reads oracle data via oracleAuthority key.
    if (
      this.isAdminOracle(state.market) &&
      !keeperKey.equals(state.market.config.oracleAuthority)
    ) {
      if (!state.foreignOracleSkipped) {
        state.foreignOracleSkipped = true;
        logger.warn("crankAll: admin-oracle market skipped — keeper is NOT the oracle authority.", {
          slabAddress,
          marketOracleAuthority: state.market.config.oracleAuthority.toBase58(),
          keeperPublicKey: keeperKey.toBase58(),
        });
      }
      skippedForeignOracle++;
      continue;
    }

    // v17: skip markets where keeper portfolio is not yet provisioned.
    // crankMarket() would return false silently; count as skipped here instead.
    if (!state.keeperPortfolio) {
      skippedNoPortfolio++;
      continue;
    }

    // Skip markets paused due to stale oracle (>10min without price push).
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

  // Meaningful accounting check.
  const skipped = skippedPermanent + skippedForeignOracle + skippedNoPortfolio + skippedStalePaused + skippedFailures + skippedNotDue;
  const total = this.markets.size;
  const accounted = toCrank.length + skipped;

  if (accounted !== total) {
    logger.warn("Crank accounting mismatch", {
      totalMarkets: total,
      toCrank: toCrank.length,
      skipped,
      skippedPermanent,
      skippedForeignOracle,
      skippedNoPortfolio,
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
    const succeededSlabs = new Set<string>();
    const batchResult = await processBatched(
      toCrank,
      PARALLEL_CONCURRENCY,
      50,
      async (slabAddress) => {
        const result = await this.crankMarket(slabAddress);
        if (result === "success") succeededSlabs.add(slabAddress);
        return result;
      },
    );
    success = batchResult.succeeded;
    failed = batchResult.failed;
    const totalSkipped = skipped + batchResult.skipped;

    // DESYNC-5 FIX: LpVaultCrankFees (tag 78) — submit for each successfully
    // cranked market that has an LP vault. This advances the backing-domain
    // ledger so LP depositors receive their pro-rata fee share.
    // #339: LP-vault maintenance — tracked, guarded, shutdown-aware.
    // Only run for markets that were individually successful this cycle (not all
    // of toCrank, which includes markets whose own crank failed this batch).
    // Uses Promise.allSettled so failures don't block the cycle but work IS
    // tracked so shutdown can complete before new enqueues race the drain.
    if (succeededSlabs.size > 0 && this._isRunning) {
      const connection = getConnection();
      const keypair = this._keypair;
      const lpVaultTasks: Promise<void | string | null>[] = [];
      for (const slabAddress of succeededSlabs) {
        // #339: per-market in-flight guard — two cycles can't duplicate LP-vault
        // work for the same market (mirrors _inflightMarkets for crankMarket).
        if (this._inflightLpVaultMarkets.has(slabAddress)) {
          logger.debug("crankAll: LP-vault already in-flight for market, skipping duplicate", {
            slabAddress: slabAddress.slice(0, 8),
          });
          continue;
        }
        // #339: shutdown guard — don't start new LP-vault work if stop() was called
        // while the batch was in flight. Prevents post-drain enqueues.
        if (!this._isRunning) break;
        const state = this.markets.get(slabAddress);
        if (!state) continue;
        this._inflightLpVaultMarkets.add(slabAddress);
        const task = crankLpVault(connection, state.market.programId, state.market, keypair)
          .catch((err) => {
            logger.debug("crankLpVault threw (tracked)", {
              slabAddress: slabAddress.slice(0, 8),
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            this._inflightLpVaultMarkets.delete(slabAddress);
          });
        lpVaultTasks.push(task);
      }
      // Await all LP-vault work before the cycle exits so shutdown can reliably
      // drain the queue before accepting new enqueues.
      await Promise.allSettled(lpVaultTasks);
    }

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

    // P0 FIX: Always log cycle result with skip breakdown. Previously only logged
    // when failed > 0, causing skipped-only cycles to produce zero log output.
    logger.info("Crank cycle complete", {
      success, failed, skipped: totalSkipped,
      toCrank: toCrank.length,
      ...(skippedFailures > 0 && { skippedFailures }),
      ...(skippedForeignOracle > 0 && { skippedForeignOracle }),
      ...(skippedNoPortfolio > 0 && { skippedNoPortfolio }),
      ...(skippedPermanent > 0 && { skippedPermanent }),
      ...(skippedStalePaused > 0 && { skippedStalePaused }),
      ...(skippedNotDue > 0 && { skippedNotDue }),
    });

    cycleDurationSeconds.observe({ service: "crank" }, (Date.now() - _crankAllStart) / 1000);
    this.lastCycleResult = { success, failed, skipped: totalSkipped };
    return { success, failed, skipped: totalSkipped };
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
      const market = parseMarketFromAccountData(slabPubkey, programId, data);
      if (!market) {
        throw new Error("Unrecognized or unsupported market account layout");
      }
      const header = market.header as
        | { version?: number | bigint; kind?: number | bigint }
        | undefined;
      const isV17Market =
        Boolean((market as DiscoveredMarket & { _rawV17Config?: unknown })._rawV17Config) ||
        (header !== undefined && Number(header.version) === 16 && Number(header.kind) === 1);

      this.markets.set(slabAddress, {
        market,
        lastCrankTime: 0,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        isActive: true,
        missingDiscoveryCount: 0,
        mainnetCA,
        // v17: keeperPortfolio must be provisioned before this market can be cranked.
        keeperPortfolio: null,
      });

      logger.info("Hot-registered new market", { slabAddress, programId: programId.toBase58() });

      if (isV17Market) {
        await this.ensureKeeperPortfolio(slabAddress, market);
      }

      // Trigger immediate oracle push + crank so price is live within seconds
      const cranked = await this.crankMarket(slabAddress);
      if (!cranked) {
        return {
          success: true,
          message: "Market registered; initial crank was not executed",
        };
      }

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

    // H4 (HIGH): when the watchdog observes a cycle exceeding MAX_CYCLE_MS we
    // give it `WATCHDOG_GRACE_MS` more before exiting the process. A slow but
    // recovering cycle clears its own _cycling/_watchdogArmedAt via the
    // finally block; a truly hung cycle hits process.exit and the supervisor
    // restarts. Critically we never flip `_cycling=false` here — that was the
    // pre-fix bug that let the next interval tick start a second crankAll()
    // while the first was still mid-Sender-retry. See the field-comment on
    // `_watchdogArmedAt` for the full rationale.
    const WATCHDOG_GRACE_MS = 30_000;

    this.timer = setInterval(async () => {
      if (this._cycling) {
        const elapsed = Date.now() - this._cycleStartedAt;
        if (elapsed > MAX_CYCLE_MS) {
          if (this._watchdogArmedAt === 0) {
            // First tick observing the hang — alert once, start grace timer.
            this._watchdogArmedAt = Date.now();
            logger.error("Crank cycle watchdog: cycle hung, grace period started before process exit", {
              elapsedMs: elapsed,
              maxCycleMs: MAX_CYCLE_MS,
              graceMs: WATCHDOG_GRACE_MS,
            });
            sendCriticalAlert("Crank cycle hung — supervisor restart pending", [
              { name: "Elapsed", value: `${Math.round(elapsed / 1000)}s`, inline: true },
              { name: "Max", value: `${Math.round(MAX_CYCLE_MS / 1000)}s`, inline: true },
              { name: "Grace", value: `${Math.round(WATCHDOG_GRACE_MS / 1000)}s`, inline: true },
            ])?.catch(() => {});
          } else if (Date.now() - this._watchdogArmedAt > WATCHDOG_GRACE_MS) {
            // Grace expired, in-flight cycle did not recover — exit for supervisor restart.
            // This is safer than flipping _cycling=false (which would double-execute) and
            // safer than indefinite stall (which would silently halt the keeper).
            logger.error("Crank cycle still hung after grace period — exiting for supervisor restart", {
              elapsedMs: elapsed,
              graceElapsedMs: Date.now() - this._watchdogArmedAt,
            });
            process.exit(1);
          }
          // NOTE: do NOT reset _cycling here. See field-comment on _watchdogArmedAt.
        }
        return;
      }
      this._cycling = true;
      this._cycleStartedAt = Date.now();
      this._watchdogArmedAt = 0;
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
        logger.error("Crank cycle failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      } finally {
        this._cycling = false;
        // H4: disarm the watchdog on natural recovery so a transient slow
        // cycle doesn't carry a pending kill timer into the next cycle.
        this._watchdogArmedAt = 0;
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
