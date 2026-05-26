import { Connection, PublicKey } from "@solana/web3.js";
/**
 * Full slab layout descriptor. Returned by detectSlabLayout().
 * All engine field offsets are relative to engineOff.
 */
export interface SlabLayout {
    version: 0 | 1 | 2;
    headerLen: number;
    configOffset: number;
    configLen: number;
    reservedOff: number;
    engineOff: number;
    accountSize: number;
    maxAccounts: number;
    bitmapWords: number;
    accountsOff: number;
    engineInsuranceOff: number;
    engineParamsOff: number;
    paramsSize: number;
    engineCurrentSlotOff: number;
    engineFundingIndexOff: number;
    engineLastFundingSlotOff: number;
    engineFundingRateBpsOff: number;
    engineMarkPriceOff: number;
    engineLastCrankSlotOff: number;
    engineMaxCrankStalenessOff: number;
    engineTotalOiOff: number;
    engineLongOiOff: number;
    engineShortOiOff: number;
    engineCTotOff: number;
    enginePnlPosTotOff: number;
    engineLiqCursorOff: number;
    engineGcCursorOff: number;
    engineLastSweepStartOff: number;
    engineLastSweepCompleteOff: number;
    engineCrankCursorOff: number;
    engineSweepStartIdxOff: number;
    engineLifetimeLiquidationsOff: number;
    engineLifetimeForceClosesOff: number;
    engineNetLpPosOff: number;
    engineLpSumAbsOff: number;
    engineLpMaxAbsOff: number;
    engineLpMaxAbsSweepOff: number;
    engineEmergencyOiModeOff: number;
    engineEmergencyStartSlotOff: number;
    engineLastBreakerSlotOff: number;
    engineBitmapOff: number;
    postBitmap: number;
    acctOwnerOff: number;
    hasInsuranceIsolation: boolean;
    engineInsuranceIsolatedOff: number;
    engineInsuranceIsolationBpsOff: number;
}
export declare const ENGINE_OFF = 600;
export declare const ENGINE_MARK_PRICE_OFF = 400;
/**
 * V2 slab tier sizes (small and large) for discovery.
 * V2 uses ENGINE_OFF=600, BITMAP_OFF=432, ACCOUNT_SIZE=248, postBitmap=18.
 * Sizes overlap with V1D (postBitmap=2) — disambiguation requires reading the version field.
 */
export declare const SLAB_TIERS_V2: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65088;
        readonly label: "Small";
        readonly description: "256 slots (V2 BPF intermediate)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025568;
        readonly label: "Large";
        readonly description: "4,096 slots (V2 BPF intermediate)";
    };
};
/**
 * V1M slab tier sizes — mainnet-deployed V1 program (ESa89R5).
 * ENGINE_OFF=640, BITMAP_OFF=726, ACCOUNT_SIZE=248, postBitmap=18.
 * Expanded RiskParams (336 bytes) and trade_twap runtime fields.
 * Confirmed by on-chain probing of slab 8NY7rvQ (SOL/USDC Perpetual, 257512 bytes).
 */
export declare const SLAB_TIERS_V1M: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V1M2 slab tier sizes — mainnet program with 312-byte accounts.
 * Same engine layout as V1M but larger accounts. Sizes match V_ADL exactly.
 */
export declare const SLAB_TIERS_V1M2: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1008, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account including alignment padding).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288320 bytes.
 */
export declare const SLAB_TIERS_V_ADL: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * V_SETDEXPOOL slab tier sizes — PERC-SetDexPool security fix.
 * ENGINE_OFF=632, BITMAP_OFF=1008, ACCOUNT_SIZE=312, CONFIG_LEN=528.
 * e.g. large (4096 accts) = 1288336 bytes.
 */
export declare const SLAB_TIERS_V_SETDEXPOOL: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
/**
 * Detect the slab layout version from the raw account data length.
 * Returns the full SlabLayout descriptor, or null if the size is unrecognised.
 * Checks V_SETDEXPOOL, V_ADL, V1M, V0, V1D, V1D-legacy, V1, and V1-legacy sizes.
 *
 * When `data` is provided and the size matches V1D, the version field at offset 8 is read
 * to disambiguate V2 slabs (which produce identical sizes to V1D with postBitmap=2).
 * V2 slabs have version===2 at offset 8 (u32 LE).
 *
 * @param dataLen - The slab account data length in bytes
 * @param data    - Optional raw slab data for version-field disambiguation
 */
export declare function detectSlabLayout(dataLen: number, data?: Uint8Array): SlabLayout | null;
/**
 * Legacy detectLayout for backward compat.
 * Returns { bitmapWords, accountsOff, maxAccounts } or null.
 *
 * GH#1238: previously recomputed accountsOff with hardcoded postBitmap=18, which gave a value
 * 16 bytes too large for V1D slabs (which use postBitmap=2). Now delegates directly to the
 * SlabLayout descriptor so each variant uses its own correct accountsOff.
 */
export declare function detectLayout(dataLen: number): {
    bitmapWords: number;
    accountsOff: number;
    maxAccounts: number;
} | null;
export interface SlabHeader {
    magic: bigint;
    version: number;
    bump: number;
    flags: number;
    resolved: boolean;
    paused: boolean;
    admin: PublicKey;
    nonce: bigint;
    lastThrUpdateSlot: bigint;
}
export interface MarketConfig {
    collateralMint: PublicKey;
    vaultPubkey: PublicKey;
    indexFeedId: PublicKey;
    maxStalenessSlots: bigint;
    confFilterBps: number;
    vaultAuthorityBump: number;
    invert: number;
    unitScale: number;
    fundingHorizonSlots: bigint;
    fundingKBps: bigint;
    fundingInvScaleNotionalE6: bigint;
    fundingMaxPremiumBps: bigint;
    fundingMaxBpsPerSlot: bigint;
    fundingPremiumWeightBps: bigint;
    fundingSettlementIntervalSlots: bigint;
    fundingPremiumDampeningE6: bigint;
    fundingPremiumMaxBpsPerSlot: bigint;
    threshFloor: bigint;
    threshRiskBps: bigint;
    threshUpdateIntervalSlots: bigint;
    threshStepBps: bigint;
    threshAlphaBps: bigint;
    threshMin: bigint;
    threshMax: bigint;
    threshMinStep: bigint;
    oracleAuthority: PublicKey;
    authorityPriceE6: bigint;
    authorityTimestamp: bigint;
    oraclePriceCapE2bps: bigint;
    lastEffectivePriceE6: bigint;
    oiCapMultiplierBps: bigint;
    maxPnlCap: bigint;
    adaptiveFundingEnabled: boolean;
    adaptiveScaleBps: number;
    adaptiveMaxFundingBps: bigint;
    marketCreatedSlot: bigint;
    oiRampSlots: bigint;
    resolvedSlot: bigint;
    insuranceIsolationBps: number;
    /** PERC-622: Oracle phase (0=Nascent, 1=Growing, 2=Mature) */
    oraclePhase: number;
    /** PERC-622: Cumulative trade volume in e6 format */
    cumulativeVolumeE6: bigint;
    /** PERC-622: Slots elapsed from market creation to Phase 2 entry (u24) */
    phase2DeltaSlots: number;
    /**
     * PERC-SetDexPool: Admin-pinned DEX pool pubkey for HYPERP markets.
     * Null when reading old slabs (pre-SetDexPool configLen < 528) or when
     * SetDexPool has never been called (all-zero pubkey).
     */
    dexPool: PublicKey | null;
}
export interface InsuranceFund {
    balance: bigint;
    feeRevenue: bigint;
    isolatedBalance: bigint;
    isolationBps: number;
}
export interface RiskParams {
    warmupPeriodSlots: bigint;
    maintenanceMarginBps: bigint;
    initialMarginBps: bigint;
    tradingFeeBps: bigint;
    maxAccounts: bigint;
    newAccountFee: bigint;
    riskReductionThreshold: bigint;
    maintenanceFeePerSlot: bigint;
    maxCrankStalenessSlots: bigint;
    liquidationFeeBps: bigint;
    liquidationFeeCap: bigint;
    liquidationBufferBps: bigint;
    minLiquidationAbs: bigint;
}
export interface EngineState {
    vault: bigint;
    insuranceFund: InsuranceFund;
    currentSlot: bigint;
    fundingIndexQpbE6: bigint;
    lastFundingSlot: bigint;
    fundingRateBpsPerSlotLast: bigint;
    lastCrankSlot: bigint;
    maxCrankStalenessSlots: bigint;
    totalOpenInterest: bigint;
    longOi: bigint;
    shortOi: bigint;
    cTot: bigint;
    pnlPosTot: bigint;
    liqCursor: number;
    gcCursor: number;
    lastSweepStartSlot: bigint;
    lastSweepCompleteSlot: bigint;
    crankCursor: number;
    sweepStartIdx: number;
    lifetimeLiquidations: bigint;
    lifetimeForceCloses: bigint;
    netLpPos: bigint;
    lpSumAbs: bigint;
    lpMaxAbs: bigint;
    lpMaxAbsSweep: bigint;
    emergencyOiMode: boolean;
    emergencyStartSlot: bigint;
    lastBreakerSlot: bigint;
    numUsedAccounts: number;
    nextAccountId: bigint;
    markPriceE6: bigint;
}
export declare enum AccountKind {
    User = 0,
    LP = 1
}
export interface Account {
    kind: AccountKind;
    accountId: bigint;
    capital: bigint;
    pnl: bigint;
    reservedPnl: bigint;
    warmupStartedAtSlot: bigint;
    warmupSlopePerStep: bigint;
    positionSize: bigint;
    entryPrice: bigint;
    fundingIndex: bigint;
    matcherProgram: PublicKey;
    matcherContext: PublicKey;
    owner: PublicKey;
    feeCredits: bigint;
    lastFeeSlot: bigint;
}
export declare function fetchSlab(connection: Connection, slabPubkey: PublicKey): Promise<Uint8Array>;
export declare const RAMP_START_BPS = 1000n;
export declare const DEFAULT_OI_RAMP_SLOTS = 432000n;
export declare function computeEffectiveOiCapBps(config: MarketConfig, currentSlot: bigint): bigint;
export declare function readNonce(data: Uint8Array): bigint;
export declare function readLastThrUpdateSlot(data: Uint8Array): bigint;
/**
 * Parse slab header (first 72 bytes — layout-independent).
 */
export declare function parseHeader(data: Uint8Array): SlabHeader;
/**
 * Parse market config. Layout-version aware.
 * For V0 slabs, fields beyond the basic config are read if present in the data,
 * otherwise defaults are returned.
 *
 * @param data - Slab data (may be a partial slice for discovery; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
export declare function parseConfig(data: Uint8Array, layoutHint?: SlabLayout | null): MarketConfig;
/**
 * Parse RiskParams from engine data. Layout-version aware.
 * For V0 slabs, extended params (risk_threshold, maintenance_fee, etc.) are
 * not present on-chain, so defaults (0) are returned.
 *
 * @param data - Slab data (may be a partial slice; pass layoutHint in that case)
 * @param layoutHint - Pre-detected layout to use; if omitted, detected from data.length.
 */
export declare function parseParams(data: Uint8Array, layoutHint?: SlabLayout | null): RiskParams;
/**
 * Parse RiskEngine state (excluding accounts array). Layout-version aware.
 */
export declare function parseEngine(data: Uint8Array): EngineState;
/**
 * Read bitmap to get list of used account indices.
 */
/**
 * Return all account indices whose bitmap bit is set (i.e. slot is in use).
 * Uses the layout-aware bitmap offset so V1_LEGACY slabs (bitmap at rel+672) are handled correctly.
 */
export declare function parseUsedIndices(data: Uint8Array): number[];
/**
 * Check if a specific account index is used.
 */
export declare function isAccountUsed(data: Uint8Array, idx: number): boolean;
/**
 * Calculate the maximum valid account index for a given slab size.
 */
export declare function maxAccountIndex(dataLen: number): number;
/**
 * Parse a single account by index.
 */
export declare function parseAccount(data: Uint8Array, idx: number): Account;
/**
 * Parse all used accounts.
 */
export declare function parseAllAccounts(data: Uint8Array): {
    idx: number;
    account: Account;
}[];
/**
 * Check if an account has a flat (zero) position size.
 *
 * A flat position has no open leverage and cannot be liquidated.
 * This is useful for filtering out unused or closed accounts from
 * the list of all slab accounts.
 *
 * @param account - The account to check
 * @returns true if the account's position size is exactly 0n
 *
 * @example
 * ```ts
 * const allAccounts = parseAllAccounts(slabData);
 * const openAccounts = allAccounts.filter(({ account }) => !isAccountFlat(account));
 * ```
 */
export declare function isAccountFlat(account: Account): boolean;
/**
 * Filter out flat (zero-size) positions from an account list.
 *
 * The "ghost position bug" in percolator-launch occurred because zero-sized
 * accounts were included in position lists, showing users non-existent positions.
 * This utility provides a canonical way to filter them out consistently across
 * all consumers of the SDK.
 *
 * @param accounts - Array of accounts (typically from parseAllAccounts or similar)
 * @returns Filtered array containing only accounts with non-zero position sizes
 *
 * @example
 * ```ts
 * const all = parseAllAccounts(slabData);
 * const openOnly = filterOpenPositions(all.map(a => a.account));
 * console.log(`${openOnly.length} open positions out of ${all.length} accounts`);
 * ```
 */
export declare function filterOpenPositions(accounts: Account[]): Account[];
/**
 * Market health status.
 * Helps applications decide whether to allow trading or show warnings.
 */
export type SlabHealth = "healthy" | "paused" | "resolved" | "adl-triggered" | "crank-stale" | "oracle-unavailable";
/**
 * Assess the health status of a market (slab).
 *
 * Different health states indicate different issues:
 * - **healthy**: Trading is normal, no issues detected.
 * - **paused**: Admin has paused the market; trading is disabled.
 * - **resolved**: Market was fully resolved (period ended); no more trading possible.
 * - **adl-triggered**: Auto-deleverage is active; insurance is depleted or PnL cap exceeded.
 *   This is a critical state where profitable positions may be force-closed.
 * - **crank-stale**: The keeper crank hasn't run recently. Risk parameters may be stale;
 *   liquidation engine state may not reflect current prices.
 * - **oracle-unavailable**: No recent oracle price is available. Cannot trust mark prices.
 *
 * Applications can use this to:
 * - Show warnings to traders ("Market is ADL-triggered")
 * - Disable trading UI buttons ("Market paused")
 * - Disable liquidations ("Oracle unavailable")
 * - Show "risk parameters may be stale" warning
 *
 * @param slabData - Raw slab account bytes
 * @param currentSlot - Current on-chain slot (from engine state, or from RPC)
 * @param maxCranknessSlots - Maximum acceptable staleness (default 200 slots ≈ 1 min 20 sec)
 * @returns The health status
 *
 * @example
 * ```ts
 * const slabData = await fetchSlab(connection, slabKey);
 * const health = getSlabHealth(slabData, currentSlot);
 *
 * if (health === "paused") {
 *   showWarning("Market is paused by admin");
 * } else if (health === "adl-triggered") {
 *   showError("Market ADL is active — positions may be force-closed");
 * } else if (health === "healthy") {
 *   enableTradingButtons();
 * }
 * ```
 */
export declare function getSlabHealth(slabData: Uint8Array, currentSlot: bigint, maxCranknessSlots?: bigint): SlabHealth;
