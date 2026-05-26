import { PublicKey, AccountMeta } from "@solana/web3.js";
/**
 * Account spec for building instruction account metas.
 * Each instruction has a fixed ordering that matches the Rust processor.
 */
export interface AccountSpec {
    name: string;
    signer: boolean;
    writable: boolean;
}
/**
 * InitMarket: 9 accounts (Pyth Pull - feed_id is in instruction data, not as accounts)
 */
export declare const ACCOUNTS_INIT_MARKET: readonly AccountSpec[];
/**
 * InitUser: 5 accounts (clock/oracle removed in commit 410f947)
 */
export declare const ACCOUNTS_INIT_USER: readonly AccountSpec[];
/**
 * InitLP: 5 accounts (clock/oracle removed in commit 410f947)
 */
export declare const ACCOUNTS_INIT_LP: readonly AccountSpec[];
/**
 * DepositCollateral: 6 accounts
 */
export declare const ACCOUNTS_DEPOSIT_COLLATERAL: readonly AccountSpec[];
/**
 * WithdrawCollateral: 8 accounts
 */
export declare const ACCOUNTS_WITHDRAW_COLLATERAL: readonly AccountSpec[];
/**
 * KeeperCrank: 4 accounts
 */
export declare const ACCOUNTS_KEEPER_CRANK: readonly AccountSpec[];
/**
 * TradeNoCpi: 4 accounts (PERC-199: clock sysvar removed — uses Clock::get() syscall)
 */
export declare const ACCOUNTS_TRADE_NOCPI: readonly AccountSpec[];
/**
 * LiquidateAtOracle: 4 accounts
 * Note: account[0] is unused but must be present
 */
export declare const ACCOUNTS_LIQUIDATE_AT_ORACLE: readonly AccountSpec[];
/**
 * CloseAccount: 8 accounts
 */
export declare const ACCOUNTS_CLOSE_ACCOUNT: readonly AccountSpec[];
/**
 * TopUpInsurance: 5 accounts
 */
export declare const ACCOUNTS_TOPUP_INSURANCE: readonly AccountSpec[];
/**
 * TradeCpi: 7 accounts (PERC-199: clock sysvar removed — uses Clock::get() syscall)
 */
export declare const ACCOUNTS_TRADE_CPI: readonly AccountSpec[];
/**
 * SetRiskThreshold: 2 accounts
 */
export declare const ACCOUNTS_SET_RISK_THRESHOLD: readonly AccountSpec[];
/**
 * UpdateAdmin: 2 accounts
 */
export declare const ACCOUNTS_UPDATE_ADMIN: readonly AccountSpec[];
/**
 * CloseSlab: 2 accounts
 */
export declare const ACCOUNTS_CLOSE_SLAB: readonly AccountSpec[];
/**
 * UpdateConfig: 2 accounts
 */
export declare const ACCOUNTS_UPDATE_CONFIG: readonly AccountSpec[];
/**
 * SetMaintenanceFee: 2 accounts
 */
export declare const ACCOUNTS_SET_MAINTENANCE_FEE: readonly AccountSpec[];
/**
 * SetOracleAuthority: 2 accounts
 * Sets the oracle price authority (admin only)
 */
export declare const ACCOUNTS_SET_ORACLE_AUTHORITY: readonly AccountSpec[];
/**
 * SetOraclePriceCap: 2 accounts
 * Set oracle price circuit breaker cap (admin only)
 */
export declare const ACCOUNTS_SET_ORACLE_PRICE_CAP: readonly AccountSpec[];
/**
 * PushOraclePrice: 2 accounts
 * Push oracle price (oracle authority only)
 */
export declare const ACCOUNTS_PUSH_ORACLE_PRICE: readonly AccountSpec[];
/**
 * ResolveMarket: 2 accounts
 * Resolves a binary/premarket (admin only)
 */
export declare const ACCOUNTS_RESOLVE_MARKET: readonly AccountSpec[];
/**
 * WithdrawInsurance: 6 accounts
 * Withdraw insurance fund after market resolution (admin only)
 */
export declare const ACCOUNTS_WITHDRAW_INSURANCE: readonly AccountSpec[];
/**
 * PauseMarket: 2 accounts
 */
export declare const ACCOUNTS_PAUSE_MARKET: readonly AccountSpec[];
/**
 * UnpauseMarket: 2 accounts
 */
export declare const ACCOUNTS_UNPAUSE_MARKET: readonly AccountSpec[];
/**
 * Build AccountMeta array from spec and provided pubkeys.
 *
 * Accepts either:
 *   - `PublicKey[]`  — ordered array, one entry per spec account (legacy form)
 *   - `Record<string, PublicKey>` — named map keyed by account `name` (preferred form)
 *
 * Named-map form resolves accounts by spec name so callers don't have to
 * remember the positional order, and errors clearly on missing names.
 */
export declare function buildAccountMetas(spec: readonly AccountSpec[], keys: PublicKey[] | Record<string, PublicKey>): AccountMeta[];
/**
 * CreateInsuranceMint: 9 accounts
 * Creates SPL mint PDA for insurance LP tokens. Admin only, once per market.
 */
export declare const ACCOUNTS_CREATE_INSURANCE_MINT: readonly AccountSpec[];
/**
 * DepositInsuranceLP: 8 accounts
 * Deposit collateral into insurance fund, receive LP tokens.
 */
export declare const ACCOUNTS_DEPOSIT_INSURANCE_LP: readonly AccountSpec[];
/**
 * WithdrawInsuranceLP: 8 accounts
 * Burn LP tokens and withdraw proportional share of insurance fund.
 */
export declare const ACCOUNTS_WITHDRAW_INSURANCE_LP: readonly AccountSpec[];
/**
 * LpVaultWithdraw: 10 accounts (tag 39, PERC-627 / GH#1926 / PERC-8287)
 *
 * Burn LP vault tokens and withdraw proportional collateral from the LP vault.
 *
 * accounts[9] = creatorLockPda is REQUIRED since percolator-prog PR#170.
 * Non-creator withdrawers must pass the derived PDA key; if no lock exists
 * on-chain the enforcement is a no-op. Omitting it was the bypass vector
 * fixed in GH#1926. Use `deriveCreatorLockPda(programId, slab)` to compute.
 *
 * Accounts:
 *  [0] withdrawer        signer, read-only
 *  [1] slab              writable
 *  [2] withdrawerAta     writable (collateral destination)
 *  [3] vault             writable (collateral source)
 *  [4] tokenProgram      read-only
 *  [5] lpVaultMint       writable (LP tokens burned from here)
 *  [6] withdrawerLpAta   writable (LP tokens source)
 *  [7] vaultAuthority    read-only (PDA that signs token transfers)
 *  [8] lpVaultState      writable
 *  [9] creatorLockPda    writable (REQUIRED — derived from ["creator_lock", slab])
 */
export declare const ACCOUNTS_LP_VAULT_WITHDRAW: readonly AccountSpec[];
/**
 * FundMarketInsurance: 5 accounts (PERC-306)
 * Fund per-market isolated insurance balance.
 */
export declare const ACCOUNTS_FUND_MARKET_INSURANCE: readonly AccountSpec[];
/**
 * SetInsuranceIsolation: 2 accounts (PERC-306)
 * Set max % of global fund this market can access.
 */
export declare const ACCOUNTS_SET_INSURANCE_ISOLATION: readonly AccountSpec[];
/**
 * QueueWithdrawal: 5 accounts (PERC-309)
 * User queues a large LP withdrawal. Creates withdraw_queue PDA.
 */
export declare const ACCOUNTS_QUEUE_WITHDRAWAL: readonly AccountSpec[];
/**
 * ClaimQueuedWithdrawal: 10 accounts (PERC-309)
 * Burns LP tokens and releases one epoch tranche of SOL.
 */
export declare const ACCOUNTS_CLAIM_QUEUED_WITHDRAWAL: readonly AccountSpec[];
/**
 * CancelQueuedWithdrawal: 3 accounts (PERC-309)
 * Cancels queue, closes withdraw_queue PDA, returns rent to user.
 */
export declare const ACCOUNTS_CANCEL_QUEUED_WITHDRAWAL: readonly AccountSpec[];
/**
 * ExecuteAdl: 4+ accounts (PERC-305, tag 50)
 * Permissionless — surgically close/reduce the most profitable position
 * when pnl_pos_tot > max_pnl_cap. For non-Hyperp markets with backup oracles,
 * pass additional oracle accounts at accounts[4..].
 */
export declare const ACCOUNTS_EXECUTE_ADL: readonly AccountSpec[];
/**
 * CloseStaleSlabs: 2 accounts (tag 51)
 * Admin closes a slab of an invalid/old layout and recovers rent SOL.
 */
export declare const ACCOUNTS_CLOSE_STALE_SLABS: readonly AccountSpec[];
/**
 * ReclaimSlabRent: 2 accounts (tag 52)
 * Reclaim rent from an uninitialised slab. Both dest and slab must sign.
 */
export declare const ACCOUNTS_RECLAIM_SLAB_RENT: readonly AccountSpec[];
/**
 * AuditCrank: 1 account (tag 53)
 * Permissionless. Verifies conservation invariants; pauses market on violation.
 */
export declare const ACCOUNTS_AUDIT_CRANK: readonly AccountSpec[];
/**
 * AdvanceOraclePhase: 1 account
 * Permissionless — no signer required beyond fee payer.
 */
export declare const ACCOUNTS_ADVANCE_ORACLE_PHASE: readonly AccountSpec[];
/**
 * TopUpKeeperFund: 3 accounts
 * Permissionless — anyone can fund. Transfers lamports directly (no system program).
 */
export declare const ACCOUNTS_TOPUP_KEEPER_FUND: readonly AccountSpec[];
/**
 * SetOiImbalanceHardBlock: 2 accounts
 * Sets the OI imbalance hard-block threshold (admin only)
 */
export declare const ACCOUNTS_SET_OI_IMBALANCE_HARD_BLOCK: readonly AccountSpec[];
/**
 * MintPositionNft: 10 accounts
 * Creates a Token-2022 position NFT for an open position.
 */
export declare const ACCOUNTS_MINT_POSITION_NFT: readonly AccountSpec[];
/**
 * TransferPositionOwnership: 8 accounts
 * Transfer position NFT and update on-chain owner. Requires pending_settlement == 0.
 */
export declare const ACCOUNTS_TRANSFER_POSITION_OWNERSHIP: readonly AccountSpec[];
/**
 * BurnPositionNft: 7 accounts
 * Burns NFT and closes PositionNft + mint PDAs after position is closed.
 */
export declare const ACCOUNTS_BURN_POSITION_NFT: readonly AccountSpec[];
/**
 * SetPendingSettlement: 3 accounts
 * Keeper/admin sets pending_settlement flag before funding transfer.
 * Protected by admin allowlist (GH#1475).
 */
export declare const ACCOUNTS_SET_PENDING_SETTLEMENT: readonly AccountSpec[];
/**
 * ClearPendingSettlement: 3 accounts
 * Keeper/admin clears pending_settlement flag after KeeperCrank.
 * Protected by admin allowlist (GH#1475).
 */
export declare const ACCOUNTS_CLEAR_PENDING_SETTLEMENT: readonly AccountSpec[];
/**
 * SetWalletCap: 2 accounts
 * Sets the per-wallet position cap (admin only). capE6=0 disables.
 */
export declare const ACCOUNTS_SET_WALLET_CAP: readonly AccountSpec[];
/**
 * SetDexPool: 3 accounts
 * Admin pins the approved DEX pool address for a HYPERP market.
 * After this call, UpdateHyperpMark rejects any pool that does not match.
 */
export declare const ACCOUNTS_SET_DEX_POOL: readonly AccountSpec[];
export declare const WELL_KNOWN: {
    readonly tokenProgram: PublicKey;
    readonly clock: PublicKey;
    readonly rent: PublicKey;
    readonly systemProgram: PublicKey;
};
