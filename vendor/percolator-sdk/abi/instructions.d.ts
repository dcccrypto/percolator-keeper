import { PublicKey } from "@solana/web3.js";
/**
 * Oracle price constraints.
 * Maximum oracle price that can be pushed to the on-chain oracle authority.
 */
export declare const MAX_ORACLE_PRICE = 1000000000000n;
/**
 * Instruction tags - exact match to Rust ix::Instruction::decode
 */
export declare const IX_TAG: {
    readonly InitMarket: 0;
    readonly InitUser: 1;
    readonly InitLP: 2;
    readonly DepositCollateral: 3;
    readonly WithdrawCollateral: 4;
    readonly KeeperCrank: 5;
    readonly TradeNoCpi: 6;
    readonly LiquidateAtOracle: 7;
    readonly CloseAccount: 8;
    readonly TopUpInsurance: 9;
    readonly TradeCpi: 10;
    readonly SetRiskThreshold: 11;
    readonly UpdateAdmin: 12;
    readonly CloseSlab: 13;
    readonly UpdateConfig: 14;
    readonly SetMaintenanceFee: 15;
    readonly SetOracleAuthority: 16;
    readonly PushOraclePrice: 17;
    readonly SetOraclePriceCap: 18;
    readonly ResolveMarket: 19;
    readonly WithdrawInsurance: 20;
    readonly AdminForceClose: 21;
    readonly UpdateRiskParams: 22;
    readonly RenounceAdmin: 23;
    readonly CreateInsuranceMint: 24;
    readonly DepositInsuranceLP: 25;
    readonly WithdrawInsuranceLP: 26;
    readonly PauseMarket: 27;
    readonly UnpauseMarket: 28;
    readonly AcceptAdmin: 29;
    readonly SetInsuranceWithdrawPolicy: 30;
    readonly WithdrawInsuranceLimited: 31;
    readonly SetPythOracle: 32;
    readonly UpdateMarkPrice: 33;
    readonly UpdateHyperpMark: 34;
    readonly TradeCpiV2: 35;
    readonly UnresolveMarket: 36;
    readonly CreateLpVault: 37;
    readonly LpVaultDeposit: 38;
    readonly LpVaultWithdraw: 39;
    readonly LpVaultCrankFees: 40;
    /** PERC-306: Fund per-market isolated insurance balance */
    readonly FundMarketInsurance: 41;
    /** PERC-306: Set insurance isolation BPS for a market */
    readonly SetInsuranceIsolation: 42;
    /** PERC-314: Challenge settlement price during dispute window */
    readonly ChallengeSettlement: 43;
    /** PERC-314: Resolve dispute (admin adjudication) */
    readonly ResolveDispute: 44;
    /** PERC-315: Deposit LP vault tokens as perp collateral */
    readonly DepositLpCollateral: 45;
    /** PERC-315: Withdraw LP collateral (position must be closed) */
    readonly WithdrawLpCollateral: 46;
    /** PERC-309: Queue a large LP withdrawal (user; creates withdraw_queue PDA). */
    readonly QueueWithdrawal: 47;
    /** PERC-309: Claim one epoch tranche from a queued LP withdrawal (user). */
    readonly ClaimQueuedWithdrawal: 48;
    /** PERC-309: Cancel a queued withdrawal, refund remaining LP tokens (user). */
    readonly CancelQueuedWithdrawal: 49;
    /** PERC-305: Auto-deleverage — surgically close profitable positions when PnL cap is exceeded (permissionless). */
    readonly ExecuteAdl: 50;
    /** Close a stale slab of an invalid/old layout and recover rent SOL (admin only). */
    readonly CloseStaleSlabs: 51;
    /** Reclaim rent from an uninitialised slab whose market creation failed mid-flow. Slab must sign. */
    readonly ReclaimSlabRent: 52;
    /** Permissionless on-chain audit crank: verifies conservation invariants and pauses market on violation. */
    readonly AuditCrank: 53;
    /** Cross-Market Portfolio Margining: SetOffsetPair */
    readonly SetOffsetPair: 54;
    /** Cross-Market Portfolio Margining: AttestCrossMargin */
    readonly AttestCrossMargin: 55;
    /** PERC-622: Advance oracle phase (permissionless crank) */
    readonly AdvanceOraclePhase: 56;
    /** PERC-623: Top up a market's keeper fund (permissionless) */
    readonly TopUpKeeperFund: 57;
    /** PERC-629: Slash a market creator's deposit (permissionless) */
    readonly SlashCreationDeposit: 58;
    /** PERC-628: Initialize the global shared vault (admin) */
    readonly InitSharedVault: 59;
    /** PERC-628: Allocate virtual liquidity to a market (admin) */
    readonly AllocateMarket: 60;
    /** PERC-628: Queue a withdrawal for the current epoch */
    readonly QueueWithdrawalSV: 61;
    /** PERC-628: Claim a queued withdrawal after epoch elapses */
    readonly ClaimEpochWithdrawal: 62;
    /** PERC-628: Advance the shared vault epoch (permissionless crank) */
    readonly AdvanceEpoch: 63;
    /** PERC-608: Mint a Position NFT for a user's open position. */
    readonly MintPositionNft: 64;
    /** PERC-608: Transfer position ownership via the NFT (keeper-gated). */
    readonly TransferPositionOwnership: 65;
    /** PERC-608: Burn the Position NFT when a position is closed. */
    readonly BurnPositionNft: 66;
    /** PERC-608: Keeper sets pending_settlement flag before a funding transfer. */
    readonly SetPendingSettlement: 67;
    /** PERC-608: Keeper clears pending_settlement flag after KeeperCrank. */
    readonly ClearPendingSettlement: 68;
    /** PERC-608: Internal CPI call from percolator-nft TransferHook to update on-chain owner. */
    readonly TransferOwnershipCpi: 69;
    /** PERC-8111: Set per-wallet position cap (admin only, cap_e6=0 disables). */
    readonly SetWalletCap: 70;
    /** PERC-8110: Set OI imbalance hard-block threshold (admin only). */
    readonly SetOiImbalanceHardBlock: 71;
    /** PERC-8270: Rescue orphan vault — recover tokens from a closed market's vault (admin). */
    readonly RescueOrphanVault: 72;
    /** PERC-8270: Close orphan slab — reclaim rent from a slab whose market closed unexpectedly (admin). */
    readonly CloseOrphanSlab: 73;
    /** PERC-SetDexPool: Pin admin-approved DEX pool address for a HYPERP market (admin). */
    readonly SetDexPool: 74;
};
/**
 * InitMarket instruction data (256 bytes total)
 * Layout: tag(1) + admin(32) + mint(32) + indexFeedId(32) +
 *         maxStaleSecs(8) + confFilter(2) + invert(1) + unitScale(4) +
 *         RiskParams(144)
 *
 * Note: indexFeedId is the Pyth Pull feed ID (32 bytes hex), NOT an oracle pubkey.
 * The program validates PriceUpdateV2 accounts against this feed ID at runtime.
 */
export interface InitMarketArgs {
    admin: PublicKey | string;
    collateralMint: PublicKey | string;
    indexFeedId: string;
    maxStalenessSecs: bigint | string;
    confFilterBps: number;
    invert: number;
    unitScale: number;
    initialMarkPriceE6: bigint | string;
    warmupPeriodSlots: bigint | string;
    maintenanceMarginBps: bigint | string;
    initialMarginBps: bigint | string;
    tradingFeeBps: bigint | string;
    maxAccounts: bigint | string;
    newAccountFee: bigint | string;
    riskReductionThreshold: bigint | string;
    maintenanceFeePerSlot: bigint | string;
    maxCrankStalenessSlots: bigint | string;
    liquidationFeeBps: bigint | string;
    liquidationFeeCap: bigint | string;
    liquidationBufferBps: bigint | string;
    minLiquidationAbs: bigint | string;
}
export declare function encodeInitMarket(args: InitMarketArgs): Uint8Array;
/**
 * InitUser instruction data (9 bytes)
 */
export interface InitUserArgs {
    feePayment: bigint | string;
}
export declare function encodeInitUser(args: InitUserArgs): Uint8Array;
/**
 * InitLP instruction data (73 bytes)
 */
export interface InitLPArgs {
    matcherProgram: PublicKey | string;
    matcherContext: PublicKey | string;
    feePayment: bigint | string;
}
export declare function encodeInitLP(args: InitLPArgs): Uint8Array;
/**
 * DepositCollateral instruction data (11 bytes)
 */
export interface DepositCollateralArgs {
    userIdx: number;
    amount: bigint | string;
}
export declare function encodeDepositCollateral(args: DepositCollateralArgs): Uint8Array;
/**
 * WithdrawCollateral instruction data (11 bytes)
 */
export interface WithdrawCollateralArgs {
    userIdx: number;
    amount: bigint | string;
}
export declare function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Uint8Array;
/**
 * KeeperCrank instruction data (4 bytes)
 * Funding rate is computed on-chain from LP inventory.
 */
export interface KeeperCrankArgs {
    callerIdx: number;
    allowPanic: boolean;
}
export declare function encodeKeeperCrank(args: KeeperCrankArgs): Uint8Array;
/**
 * TradeNoCpi instruction data (21 bytes)
 */
export interface TradeNoCpiArgs {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
}
export declare function encodeTradeNoCpi(args: TradeNoCpiArgs): Uint8Array;
/**
 * LiquidateAtOracle instruction data (3 bytes)
 */
export interface LiquidateAtOracleArgs {
    targetIdx: number;
}
export declare function encodeLiquidateAtOracle(args: LiquidateAtOracleArgs): Uint8Array;
/**
 * CloseAccount instruction data (3 bytes)
 */
export interface CloseAccountArgs {
    userIdx: number;
}
export declare function encodeCloseAccount(args: CloseAccountArgs): Uint8Array;
/**
 * TopUpInsurance instruction data (9 bytes)
 */
export interface TopUpInsuranceArgs {
    amount: bigint | string;
}
export declare function encodeTopUpInsurance(args: TopUpInsuranceArgs): Uint8Array;
/**
 * TradeCpi instruction data (21 bytes)
 */
export interface TradeCpiArgs {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
}
export declare function encodeTradeCpi(args: TradeCpiArgs): Uint8Array;
/**
 * TradeCpiV2 instruction data (22 bytes) — PERC-154 optimized trade CPI.
 *
 * Same as TradeCpi but includes a caller-provided PDA bump byte.
 * Uses create_program_address instead of find_program_address,
 * saving ~1500 CU per trade. The bump should be obtained once via
 * deriveLpPda() and cached for the lifetime of the market.
 */
export interface TradeCpiV2Args {
    lpIdx: number;
    userIdx: number;
    size: bigint | string;
    bump: number;
}
export declare function encodeTradeCpiV2(args: TradeCpiV2Args): Uint8Array;
/**
 * SetRiskThreshold instruction data (17 bytes)
 */
export interface SetRiskThresholdArgs {
    newThreshold: bigint | string;
}
export declare function encodeSetRiskThreshold(args: SetRiskThresholdArgs): Uint8Array;
/**
 * UpdateAdmin instruction data (33 bytes)
 */
export interface UpdateAdminArgs {
    newAdmin: PublicKey | string;
}
export declare function encodeUpdateAdmin(args: UpdateAdminArgs): Uint8Array;
/**
 * CloseSlab instruction data (1 byte)
 */
export declare function encodeCloseSlab(): Uint8Array;
/**
 * UpdateConfig instruction data
 * Updates funding and threshold parameters at runtime (admin only)
 */
export interface UpdateConfigArgs {
    fundingHorizonSlots: bigint | string;
    fundingKBps: bigint | string;
    fundingInvScaleNotionalE6: bigint | string;
    fundingMaxPremiumBps: bigint | string;
    fundingMaxBpsPerSlot: bigint | string;
    threshFloor: bigint | string;
    threshRiskBps: bigint | string;
    threshUpdateIntervalSlots: bigint | string;
    threshStepBps: bigint | string;
    threshAlphaBps: bigint | string;
    threshMin: bigint | string;
    threshMax: bigint | string;
    threshMinStep: bigint | string;
}
export declare function encodeUpdateConfig(args: UpdateConfigArgs): Uint8Array;
/**
 * SetMaintenanceFee instruction data (17 bytes)
 */
export interface SetMaintenanceFeeArgs {
    newFee: bigint | string;
}
export declare function encodeSetMaintenanceFee(args: SetMaintenanceFeeArgs): Uint8Array;
/**
 * SetOracleAuthority instruction data (33 bytes)
 * Sets the oracle price authority. Pass zero pubkey to disable and require Pyth/Chainlink.
 */
export interface SetOracleAuthorityArgs {
    newAuthority: PublicKey | string;
}
export declare function encodeSetOracleAuthority(args: SetOracleAuthorityArgs): Uint8Array;
/**
 * PushOraclePrice instruction data (17 bytes)
 * Push a new oracle price (oracle authority only).
 * The price should be in e6 format and already include any inversion/scaling.
 */
export interface PushOraclePriceArgs {
    priceE6: bigint | string;
    timestamp: bigint | string;
}
/**
 * Encode PushOraclePrice instruction data with validation.
 *
 * Validates oracle price constraints:
 * - Price cannot be zero (division by zero in on-chain engine)
 * - Price cannot exceed MAX_ORACLE_PRICE (prevents overflow in price math)
 *
 * @param args - PushOraclePrice arguments
 * @returns Encoded instruction data (17 bytes)
 * @throws Error if price is 0 or exceeds MAX_ORACLE_PRICE
 */
export declare function encodePushOraclePrice(args: PushOraclePriceArgs): Uint8Array;
/**
 * SetOraclePriceCap instruction data (9 bytes)
 * Set oracle price circuit breaker cap (admin only).
 *
 * max_change_e2bps: maximum oracle price movement per slot in 0.01 bps units.
 *   1_000_000 = 100% max move per slot.
 *
 * ⚠️ PERC-8191 (PR#150): cap=0 is NO LONGER accepted for admin-oracle markets.
 *   - Hyperp markets: rejected if cap < DEFAULT_HYPERP_PRICE_CAP_E2BPS (1000).
 *   - Admin-oracle markets: rejected if cap == 0 (circuit breaker bypass prevention).
 *   - Pyth-pinned markets: immune (oracle_authority zeroed), any value accepted.
 *
 * Use a non-zero cap for all admin-oracle and Hyperp markets.
 */
export interface SetOraclePriceCapArgs {
    maxChangeE2bps: bigint | string;
}
export declare function encodeSetOraclePriceCap(args: SetOraclePriceCapArgs): Uint8Array;
/**
 * ResolveMarket instruction data (1 byte)
 * Resolves a binary/premarket - sets RESOLVED flag, positions force-closed via crank.
 * Requires admin oracle price (authority_price_e6) to be set first.
 */
export declare function encodeResolveMarket(): Uint8Array;
/**
 * WithdrawInsurance instruction data (1 byte)
 * Withdraw insurance fund to admin (requires RESOLVED and all positions closed).
 */
export declare function encodeWithdrawInsurance(): Uint8Array;
/**
 * AdminForceClose instruction data (3 bytes)
 * Force-close any position at oracle price (admin only, skips margin checks).
 */
export interface AdminForceCloseArgs {
    targetIdx: number;
}
export declare function encodeAdminForceClose(args: AdminForceCloseArgs): Uint8Array;
/**
 * UpdateRiskParams instruction data (17 or 25 bytes)
 * Update initial and maintenance margin BPS (admin only).
 *
 * R2-S13: The Rust program uses `data.len() >= 25` to detect the optional
 * tradingFeeBps field, so variable-length encoding is safe. When tradingFeeBps
 * is omitted, the data is 17 bytes (tag + 2×u64). When included, 25 bytes.
 */
export interface UpdateRiskParamsArgs {
    initialMarginBps: bigint | string;
    maintenanceMarginBps: bigint | string;
    tradingFeeBps?: bigint | string;
}
export declare function encodeUpdateRiskParams(args: UpdateRiskParamsArgs): Uint8Array;
/**
 * On-chain confirmation code for RenounceAdmin (must match program constant).
 * ASCII "RENOUNCE" as u64 LE = 0x52454E4F554E4345.
 */
export declare const RENOUNCE_ADMIN_CONFIRMATION = 5928230587143701317n;
/**
 * On-chain confirmation code for UnresolveMarket (must match program constant).
 */
export declare const UNRESOLVE_CONFIRMATION = 16045690984503054900n;
/**
 * RenounceAdmin instruction data (9 bytes)
 * Irreversibly set admin to all zeros. After this, all admin-only instructions fail.
 *
 * Requires the confirmation code 0x52454E4F554E4345 ("RENOUNCE" as u64 LE)
 * to prevent accidental invocation.
 */
export declare function encodeRenounceAdmin(): Uint8Array;
/**
 * CreateInsuranceMint instruction data (1 byte)
 * Creates the SPL mint PDA for insurance LP tokens. Admin only, once per market.
 */
export declare function encodeCreateInsuranceMint(): Uint8Array;
/**
 * DepositInsuranceLP instruction data (9 bytes)
 * Deposit collateral into insurance fund, receive LP tokens proportional to share.
 */
export interface DepositInsuranceLPArgs {
    amount: bigint | string;
}
export declare function encodeDepositInsuranceLP(args: DepositInsuranceLPArgs): Uint8Array;
/**
 * WithdrawInsuranceLP instruction data (9 bytes)
 * Burn LP tokens and withdraw proportional share of insurance fund.
 */
export interface WithdrawInsuranceLPArgs {
    lpAmount: bigint | string;
}
export declare function encodeWithdrawInsuranceLP(args: WithdrawInsuranceLPArgs): Uint8Array;
/**
 * LpVaultWithdraw (Tag 39, PERC-627 / GH#1926 / PERC-8287) — burn LP vault tokens and
 * withdraw proportional collateral.
 *
 * **BREAKING (PR#170):** accounts[9] = creatorLockPda is now REQUIRED.
 * Always include `deriveCreatorLockPda(programId, slab)` at position 9.
 * Non-creator withdrawers pass the derived PDA; if no lock exists on-chain
 * the check is a no-op. Omitting this account causes `ExpectLenFailed` on-chain.
 *
 * Instruction data: tag(1) + lp_amount(8) = 9 bytes
 *
 * Accounts (use ACCOUNTS_LP_VAULT_WITHDRAW):
 *  [0] withdrawer        signer
 *  [1] slab              writable
 *  [2] withdrawerAta     writable
 *  [3] vault             writable
 *  [4] tokenProgram
 *  [5] lpVaultMint       writable
 *  [6] withdrawerLpAta   writable
 *  [7] vaultAuthority
 *  [8] lpVaultState      writable
 *  [9] creatorLockPda    writable  ← derive with deriveCreatorLockPda(programId, slab)
 *
 * @param lpAmount - Amount of LP vault tokens to burn.
 *
 * @example
 * ```ts
 * import { encodeLpVaultWithdraw, ACCOUNTS_LP_VAULT_WITHDRAW, buildAccountMetas } from "@percolator/sdk";
 * import { deriveCreatorLockPda, deriveVaultAuthority } from "@percolator/sdk";
 *
 * const [creatorLockPda] = deriveCreatorLockPda(PROGRAM_ID, slabKey);
 * const [vaultAuthority] = deriveVaultAuthority(PROGRAM_ID, slabKey);
 *
 * const data = encodeLpVaultWithdraw({ lpAmount: 1_000_000_000n });
 * const keys = buildAccountMetas(ACCOUNTS_LP_VAULT_WITHDRAW, {
 *   withdrawer, slab: slabKey, withdrawerAta, vault, tokenProgram: TOKEN_PROGRAM_ID,
 *   lpVaultMint, withdrawerLpAta, vaultAuthority, lpVaultState, creatorLockPda,
 * });
 * ```
 */
export interface LpVaultWithdrawArgs {
    /** Amount of LP vault tokens to burn. */
    lpAmount: bigint | string;
}
export declare function encodeLpVaultWithdraw(args: LpVaultWithdrawArgs): Uint8Array;
/**
 * PauseMarket instruction data (1 byte)
 * Pauses the market — disables trading, deposits, and withdrawals.
 */
export declare function encodePauseMarket(): Uint8Array;
/**
 * UnpauseMarket instruction data (1 byte)
 * Unpauses the market — re-enables trading, deposits, and withdrawals.
 */
export declare function encodeUnpauseMarket(): Uint8Array;
/**
 * SetPythOracle (Tag 32) — switch a market to Pyth-pinned mode.
 *
 * After this instruction:
 * - oracle_authority is cleared → PushOraclePrice is disabled
 * - index_feed_id is set to feed_id → validated on every price read
 * - max_staleness_secs and conf_filter_bps are updated
 * - All price reads go directly to read_pyth_price_e6() with on-chain
 *   staleness + confidence + feed-ID validation (no silent fallback)
 *
 * Instruction data: tag(1) + feed_id(32) + max_staleness_secs(8) + conf_filter_bps(2) = 43 bytes
 *
 * Accounts:
 *   0. [signer, writable] Admin
 *   1. [writable]         Slab
 */
export interface SetPythOracleArgs {
    /** 32-byte Pyth feed ID. All zeros is invalid (reserved for Hyperp mode). */
    feedId: Uint8Array;
    /** Maximum age of Pyth price in seconds before OracleStale is returned. Must be > 0. */
    maxStalenessSecs: bigint;
    /** Max confidence/price ratio in bps (0 = no confidence check). */
    confFilterBps: number;
}
export declare function encodeSetPythOracle(args: SetPythOracleArgs): Uint8Array;
/**
 * Derive the expected Pyth PriceUpdateV2 account address for a given feed ID.
 * Uses PDA seeds: [shard_id(2), feed_id(32)] under the Pyth Receiver program.
 *
 * @param feedId  32-byte Pyth feed ID
 * @param shardId Shard index (default 0 for mainnet/devnet)
 */
export declare const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export declare function derivePythPriceUpdateAccount(feedId: Uint8Array, shardId?: number): Promise<string>;
/**
 * UpdateMarkPrice (Tag 33) — permissionless EMA mark price crank.
 *
 * Reads the current oracle price on-chain, applies 8-hour EMA smoothing
 * with circuit breaker, and writes result to authority_price_e6.
 *
 * Instruction data: 1 byte (tag only — all params read from on-chain state)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         Oracle account (Pyth PriceUpdateV2 / Chainlink / DEX AMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (PumpSwap vaults, etc. if needed)
 */
export declare function encodeUpdateMarkPrice(): Uint8Array;
/**
 * Mark price EMA parameters (must match program/src/percolator.rs constants).
 */
export declare const MARK_PRICE_EMA_WINDOW_SLOTS = 72000n;
export declare const MARK_PRICE_EMA_ALPHA_E6: bigint;
/**
 * Compute the next EMA mark price step (TypeScript mirror of the on-chain function).
 */
export declare function computeEmaMarkPrice(markPrevE6: bigint, oracleE6: bigint, dtSlots: bigint, alphaE6?: bigint, capE2bps?: bigint): bigint;
/**
 * UpdateHyperpMark (Tag 34) — permissionless Hyperp EMA oracle crank.
 *
 * Reads the spot price from a PumpSwap, Raydium CLMM, or Meteora DLMM pool,
 * applies 8-hour EMA smoothing with circuit breaker, and writes the new mark
 * to authority_price_e6 on the slab.
 *
 * This is the core mechanism for permissionless token markets — no Pyth or
 * Chainlink feed is needed. The DEX AMM IS the oracle.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 *   1. []         DEX pool account (PumpSwap / Raydium CLMM / Meteora DLMM)
 *   2. []         Clock sysvar (SysvarC1ock11111111111111111111111111111111)
 *   3..N []       Remaining accounts (e.g. PumpSwap vault0 + vault1)
 */
export declare function encodeUpdateHyperpMark(): Uint8Array;
/**
 * Fund per-market isolated insurance balance.
 * Accounts: [admin(signer,writable), slab(writable), admin_ata(writable), vault(writable), token_program]
 */
export declare function encodeFundMarketInsurance(args: {
    amount: bigint;
}): Uint8Array;
/**
 * Set insurance isolation BPS for a market.
 * Accounts: [admin(signer), slab(writable)]
 */
export declare function encodeSetInsuranceIsolation(args: {
    bps: number;
}): Uint8Array;
/**
 * QueueWithdrawal (Tag 47, PERC-309) — queue a large LP withdrawal.
 *
 * Creates a withdraw_queue PDA. The LP tokens are claimed in epoch tranches
 * via ClaimQueuedWithdrawal. Call CancelQueuedWithdrawal to abort.
 *
 * Accounts: [user(signer,writable), slab(writable), lpVaultState, withdrawQueue(writable), systemProgram]
 *
 * @param lpAmount - Amount of LP tokens to queue for withdrawal.
 *
 * @example
 * ```ts
 * const data = encodeQueueWithdrawal({ lpAmount: 1_000_000_000n });
 * ```
 */
export declare function encodeQueueWithdrawal(args: {
    lpAmount: bigint | string;
}): Uint8Array;
/**
 * ClaimQueuedWithdrawal (Tag 48, PERC-309) — claim one epoch tranche from a queued withdrawal.
 *
 * Burns LP tokens and releases one tranche of SOL to the user.
 * Call once per epoch until epochs_remaining == 0.
 *
 * Accounts: [user(signer,writable), slab(writable), withdrawQueue(writable),
 *            lpVaultMint(writable), userLpAta(writable), vault(writable),
 *            userAta(writable), vaultAuthority, tokenProgram, lpVaultState(writable)]
 */
export declare function encodeClaimQueuedWithdrawal(): Uint8Array;
/**
 * CancelQueuedWithdrawal (Tag 49, PERC-309) — cancel a queued withdrawal, refund remaining LP.
 *
 * Closes the withdraw_queue PDA and returns its rent lamports to the user.
 * The queued LP amount that was not yet claimed is NOT refunded — it is burned.
 * Use only to abandon a partial withdrawal.
 *
 * Accounts: [user(signer,writable), slab, withdrawQueue(writable)]
 */
export declare function encodeCancelQueuedWithdrawal(): Uint8Array;
/**
 * ExecuteAdl (Tag 50, PERC-305) — auto-deleverage the most profitable position.
 *
 * Permissionless. Surgically closes or reduces `targetIdx` position when
 * `pnl_pos_tot > max_pnl_cap` on the market. The caller receives no reward —
 * the incentive is unblocking the market for normal trading.
 *
 * Requires `UpdateRiskParams.max_pnl_cap > 0` on the market.
 *
 * Accounts: [caller(signer), slab(writable), clock, oracle, ...backupOracles?]
 *
 * @param targetIdx - Account index of the position to deleverage.
 *
 * @example
 * ```ts
 * const data = encodeExecuteAdl({ targetIdx: 5 });
 * ```
 */
export interface ExecuteAdlArgs {
    targetIdx: number;
}
export declare function encodeExecuteAdl(args: ExecuteAdlArgs): Uint8Array;
/**
 * CloseStaleSlabs (Tag 51) — close a slab of an invalid/old layout and recover rent SOL.
 *
 * Admin only. Skips slab_guard; validates header magic + admin authority instead.
 * Use for slabs created by old program layouts (e.g. pre-PERC-120 devnet deploys)
 * whose size does not match any current valid tier.
 *
 * Accounts: [dest(signer,writable), slab(writable)]
 */
export declare function encodeCloseStaleSlabs(): Uint8Array;
/**
 * ReclaimSlabRent (Tag 52) — reclaim rent from an uninitialised slab.
 *
 * For use when market creation failed mid-flow (slab funded but InitMarket not called).
 * The slab account must sign (proves the caller holds the slab keypair).
 * Cannot close an initialised slab (magic == PERCOLAT) — use CloseSlab (tag 13).
 *
 * Accounts: [dest(signer,writable), slab(signer,writable)]
 */
export declare function encodeReclaimSlabRent(): Uint8Array;
/**
 * AuditCrank (Tag 53) — verify conservation invariants on-chain (permissionless).
 *
 * Walks all accounts and verifies: capital sum, pnl_pos_tot, total_oi, LP consistency,
 * and solvency. Sets FLAG_PAUSED on violation (with a 150-slot cooldown guard to
 * prevent DoS from transient failures).
 *
 * Accounts: [slab(writable)]
 *
 * @example
 * ```ts
 * const data = encodeAuditCrank();
 * ```
 */
export declare function encodeAuditCrank(): Uint8Array;
/**
 * Parsed vAMM matcher parameters (from on-chain matcher context account)
 */
export interface VammMatcherParams {
    mode: number;
    tradingFeeBps: number;
    baseSpreadBps: number;
    maxTotalBps: number;
    impactKBps: number;
    liquidityNotionalE6: bigint;
}
/** Magic bytes identifying a vAMM matcher context: "PERCMATC" as u64 LE */
export declare const VAMM_MAGIC = 5784119745439683651n;
/** Offset into matcher context where vAMM params start */
export declare const CTX_VAMM_OFFSET = 64;
/**
 * Compute execution price for a given LP quote.
 * For buys (isLong=true): price above oracle.
 * For sells (isLong=false): price below oracle.
 */
export declare function computeVammQuote(params: VammMatcherParams, oraclePriceE6: bigint, tradeSize: bigint, isLong: boolean): bigint;
/**
 * AdvanceOraclePhase (Tag 56) — permissionless oracle phase advancement.
 *
 * Checks if a market should transition from Phase 0→1→2 based on
 * time elapsed and cumulative volume. Anyone can call this.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [writable] Slab
 */
export declare function encodeAdvanceOraclePhase(): Uint8Array;
/** Oracle phase constants matching on-chain values */
export declare const ORACLE_PHASE_NASCENT = 0;
export declare const ORACLE_PHASE_GROWING = 1;
export declare const ORACLE_PHASE_MATURE = 2;
/** Phase transition thresholds (must match program constants) */
export declare const PHASE1_MIN_SLOTS = 648000n;
export declare const PHASE1_VOLUME_MIN_SLOTS = 36000n;
export declare const PHASE2_VOLUME_THRESHOLD = 100000000000n;
export declare const PHASE2_MATURITY_SLOTS = 3024000n;
/**
 * Check if an oracle phase transition is due (TypeScript mirror of on-chain logic).
 *
 * @returns [newPhase, shouldTransition]
 */
export declare function checkPhaseTransition(currentSlot: bigint, marketCreatedSlot: bigint, oraclePhase: number, cumulativeVolumeE6: bigint, phase2DeltaSlots: number, hasMatureOracle: boolean): [number, boolean];
/**
 * TopUpKeeperFund (Tag 57) — permissionless keeper fund top-up.
 *
 * Instruction data: tag(1) + amount(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer, writable] Funder
 *   1. [writable]         Slab
 *   2. [writable]         Keeper fund PDA
 *   3. []                 System program
 */
export interface TopUpKeeperFundArgs {
    amount: bigint | string;
}
export declare function encodeTopUpKeeperFund(args: TopUpKeeperFundArgs): Uint8Array;
/**
 * SlashCreationDeposit (Tag 58) — permissionless: slash a market creator's deposit
 * after the spam grace period has elapsed (PERC-629).
 *
 * **WARNING**: Tag 58 is reserved in tags.rs but has NO instruction decoder or
 * handler in the on-chain program. Sending this instruction will fail with
 * `InvalidInstructionData`. Do not use until the on-chain handler is deployed.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. []                 Slab
 *   2. [writable]         Creator history PDA
 *   3. [writable]         Insurance vault
 *   4. [writable]         Treasury
 *   5. []                 System program
 *
 * @deprecated Not yet implemented on-chain — will fail with InvalidInstructionData.
 */
export declare function encodeSlashCreationDeposit(): Uint8Array;
/**
 * InitSharedVault (Tag 59) — admin: create the global shared vault PDA (PERC-628).
 *
 * Instruction data: tag(1) + epochDurationSlots(8) + maxMarketExposureBps(2) = 11 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. [writable]         Shared vault PDA
 *   2. []                 System program
 */
export interface InitSharedVaultArgs {
    epochDurationSlots: bigint | string;
    maxMarketExposureBps: number;
}
export declare function encodeInitSharedVault(args: InitSharedVaultArgs): Uint8Array;
/**
 * AllocateMarket (Tag 60) — admin: allocate virtual liquidity from the shared vault
 * to a market (PERC-628).
 *
 * Instruction data: tag(1) + amount(16) = 17 bytes
 *
 * Accounts:
 *   0. [signer]           Admin
 *   1. []                 Slab
 *   2. [writable]         Shared vault PDA
 *   3. [writable]         Market alloc PDA
 *   4. []                 System program
 */
export interface AllocateMarketArgs {
    amount: bigint | string;
}
export declare function encodeAllocateMarket(args: AllocateMarketArgs): Uint8Array;
/**
 * QueueWithdrawalSV (Tag 61) — user: queue a withdrawal request for the current
 * epoch (PERC-628). Tokens are locked until the epoch elapses.
 *
 * Instruction data: tag(1) + lpAmount(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 System program
 */
export interface QueueWithdrawalSVArgs {
    lpAmount: bigint | string;
}
export declare function encodeQueueWithdrawalSV(args: QueueWithdrawalSVArgs): Uint8Array;
/**
 * ClaimEpochWithdrawal (Tag 62) — user: claim a queued withdrawal after the epoch
 * has elapsed (PERC-628). Receives pro-rata collateral from the vault.
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           User
 *   1. [writable]         Shared vault PDA
 *   2. [writable]         Withdraw request PDA
 *   3. []                 Slab
 *   4. [writable]         Vault
 *   5. [writable]         User ATA
 *   6. []                 Vault authority
 *   7. []                 Token program
 */
export declare function encodeClaimEpochWithdrawal(): Uint8Array;
/**
 * AdvanceEpoch (Tag 63) — permissionless crank: move the shared vault to the next
 * epoch once `epoch_duration_slots` have elapsed (PERC-628).
 *
 * Instruction data: 1 byte (tag only)
 *
 * Accounts:
 *   0. [signer]           Caller (anyone)
 *   1. [writable]         Shared vault PDA
 */
export declare function encodeAdvanceEpoch(): Uint8Array;
/**
 * SetOiImbalanceHardBlock (Tag 71, PERC-8110) — set OI imbalance hard-block threshold (admin only).
 *
 * When `|long_oi − short_oi| / total_oi * 10_000 >= threshold_bps`, any new trade that would
 * *increase* the imbalance is rejected with `OiImbalanceHardBlock` (error code 59).
 *
 * - `threshold_bps = 0`: hard block disabled.
 * - `threshold_bps = 8_000`: block trades that push skew above 80%.
 * - `threshold_bps = 10_000`: never allow >100% skew (always blocks one side when oi > 0).
 *
 * Instruction data layout: tag(1) + threshold_bps(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK, { admin, slab }),
 *   data: Buffer.from(encodeSetOiImbalanceHardBlock({ thresholdBps: 8_000 })),
 * });
 * ```
 */
export declare function encodeSetOiImbalanceHardBlock(args: {
    thresholdBps: number;
}): Uint8Array;
/**
 * MintPositionNft (Tag 64, PERC-608) — mint a Token-2022 NFT representing a position.
 *
 * Creates a PositionNft PDA + Token-2022 mint with metadata, then mints 1 NFT to the
 * position owner's ATA. The NFT represents ownership of `user_idx` in the slab.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] payer
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA  (created — seeds: ["position_nft", slab, user_idx])
 *   3. [writable]         nft_mint PDA      (created)
 *   4. [writable]         owner_ata         (Token-2022 ATA for owner)
 *   5. [signer]           owner             (must match engine account owner)
 *   6. []                 vault_authority PDA
 *   7. []                 token_2022_program
 *   8. []                 system_program
 *   9. []                 rent sysvar
 *
 * @example
 * ```ts
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_MINT_POSITION_NFT, [payer, slab, nftPda, nftMint, ownerAta, owner, vaultAuth, TOKEN_2022_PROGRAM_ID, SystemProgram.programId, SYSVAR_RENT_PUBKEY]),
 *   data: Buffer.from(encodeMintPositionNft({ userIdx: 5 })),
 * });
 * ```
 */
export interface MintPositionNftArgs {
    userIdx: number;
}
export declare function encodeMintPositionNft(args: MintPositionNftArgs): Uint8Array;
/**
 * TransferPositionOwnership (Tag 65, PERC-608) — transfer an open position to a new owner.
 *
 * Transfers the Token-2022 NFT from current owner to new owner and updates the on-chain
 * engine account's owner field. Requires `pending_settlement == 0`.
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] current_owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA
 *   3. [writable]         nft_mint PDA
 *   4. [writable]         current_owner_ata  (source Token-2022 ATA)
 *   5. [writable]         new_owner_ata      (destination Token-2022 ATA)
 *   6. []                 new_owner
 *   7. []                 token_2022_program
 */
export interface TransferPositionOwnershipArgs {
    userIdx: number;
}
export declare function encodeTransferPositionOwnership(args: TransferPositionOwnershipArgs): Uint8Array;
/**
 * BurnPositionNft (Tag 66, PERC-608) — burn the Position NFT when a position is closed.
 *
 * Burns the NFT, closes the PositionNft PDA and the mint PDA, returning rent to the owner.
 * Can only be called after the position is fully closed (size == 0).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer, writable] owner
 *   1. [writable]         slab
 *   2. [writable]         position_nft PDA  (closed — rent to owner)
 *   3. [writable]         nft_mint PDA      (closed via Token-2022 close_account)
 *   4. [writable]         owner_ata         (Token-2022 ATA, balance burned)
 *   5. []                 vault_authority PDA
 *   6. []                 token_2022_program
 */
export interface BurnPositionNftArgs {
    userIdx: number;
}
export declare function encodeBurnPositionNft(args: BurnPositionNftArgs): Uint8Array;
/**
 * SetPendingSettlement (Tag 67, PERC-608) — keeper sets the pending_settlement flag.
 *
 * Called by the keeper/admin before performing a funding settlement transfer.
 * Blocks NFT transfers until ClearPendingSettlement is called.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
export interface SetPendingSettlementArgs {
    userIdx: number;
}
export declare function encodeSetPendingSettlement(args: SetPendingSettlementArgs): Uint8Array;
/**
 * ClearPendingSettlement (Tag 68, PERC-608) — keeper clears the pending_settlement flag.
 *
 * Called by the keeper/admin after KeeperCrank has run and funding is settled.
 * Admin-only (protected by GH#1475 keeper allowlist guard).
 *
 * Instruction data layout: tag(1) + user_idx(2) = 3 bytes
 *
 * Accounts:
 *   0. [signer]   keeper / admin
 *   1. []         slab  (read — for PDA verification + admin check)
 *   2. [writable] position_nft PDA
 */
export interface ClearPendingSettlementArgs {
    userIdx: number;
}
export declare function encodeClearPendingSettlement(args: ClearPendingSettlementArgs): Uint8Array;
/**
 * TransferOwnershipCpi (Tag 69, PERC-608) — internal CPI target for percolator-nft TransferHook.
 *
 * Called by the Token-2022 TransferHook on the percolator-nft program during an NFT transfer.
 * Updates the engine account's owner field to the new_owner public key.
 * NOT intended for direct external use — always called via Token-2022 CPI.
 *
 * Instruction data layout: tag(1) + user_idx(2) + new_owner(32) = 35 bytes
 *
 * Accounts:
 *   0. [signer]   nft TransferHook program (CPI caller)
 *   1. [writable] slab
 *   (remaining accounts per Token-2022 ExtraAccountMeta spec)
 */
export interface TransferOwnershipCpiArgs {
    userIdx: number;
    newOwner: PublicKey | string;
}
export declare function encodeTransferOwnershipCpi(args: TransferOwnershipCpiArgs): Uint8Array;
/**
 * SetWalletCap (Tag 70, PERC-8111) — set the per-wallet position cap (admin only).
 *
 * Limits the maximum absolute position size any single wallet may hold on this market.
 * Enforced on every trade (TradeNoCpi + TradeCpi) after execute_trade.
 *
 * - `capE6 = 0`: disable per-wallet cap (no limit, default).
 * - `capE6 > 0`: max |position_size| in e6 units ($1 = 1_000_000).
 *   Phase 1 launch value: 1_000_000_000n ($1,000).
 *
 * When a trade would breach the cap, the on-chain error `WalletPositionCapExceeded`
 * (error code 58) is returned.
 *
 * Instruction data layout: tag(1) + cap_e6(8) = 9 bytes
 *
 * Accounts:
 *   0. [signer]   admin
 *   1. [writable] slab
 *
 * @example
 * ```ts
 * // Set $1K per-wallet cap
 * const ix = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 1_000_000_000n })),
 * });
 *
 * // Disable cap
 * const disableIx = new TransactionInstruction({
 *   programId: PROGRAM_ID,
 *   keys: buildAccountMetas(ACCOUNTS_SET_WALLET_CAP, [admin, slab]),
 *   data: Buffer.from(encodeSetWalletCap({ capE6: 0n })),
 * });
 * ```
 */
export interface SetWalletCapArgs {
    /** Max position size in e6 units. 0 = disabled. $1 = 1_000_000n, $1K = 1_000_000_000n. */
    capE6: bigint | string;
}
export declare function encodeSetWalletCap(args: SetWalletCapArgs): Uint8Array;
/**
 * SetDexPool (Tag 74, PERC-SetDexPool) — admin pins the approved DEX pool address.
 *
 * Only valid for HYPERP markets (indexFeedId == all-zeros). The program validates
 * the pool account before storing: it must be owned by Raydium CLMM, PumpSwap, or
 * Meteora DLMM, and must contain the market's collateral mint.
 *
 * After this call, UpdateHyperpMark rejects any pool that does not match the
 * stored address.
 *
 * Instruction data layout: tag(1) + pool(32) = 33 bytes
 */
export interface SetDexPoolArgs {
    /** The approved DEX pool account pubkey to pin for this HYPERP market. */
    pool: PublicKey | string;
}
export declare function encodeSetDexPool(args: SetDexPoolArgs): Uint8Array;
