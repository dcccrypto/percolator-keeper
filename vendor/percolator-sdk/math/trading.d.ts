/**
 * Coin-margined perpetual trade math utilities.
 *
 * On-chain PnL formula:
 *   mark_pnl = (oracle - entry) * abs_pos / oracle   (longs)
 *   mark_pnl = (entry - oracle) * abs_pos / oracle   (shorts)
 *
 * All prices are in e6 format (1 USD = 1_000_000).
 * All token amounts are in native units (e.g. lamports).
 */
/**
 * Compute mark-to-market PnL for an open position.
 *
 * @param positionSize - Signed position size (positive = long, negative = short).
 * @param entryPrice   - Entry price in e6 format (1 USD = 1_000_000).
 * @param oraclePrice  - Current oracle price in e6 format.
 * @returns PnL in native token units (positive = profit, negative = loss).
 *
 * @example
 * ```ts
 * // Long 10 SOL at $100, oracle now $110 → profit
 * const pnl = computeMarkPnl(10_000_000n, 100_000_000n, 110_000_000n);
 * ```
 */
export declare function computeMarkPnl(positionSize: bigint, entryPrice: bigint, oraclePrice: bigint): bigint;
/**
 * Compute liquidation price given entry, capital, position and maintenance margin.
 * Uses pure BigInt arithmetic for precision (no Number() truncation).
 *
 * @param entryPrice          - Entry price in e6 format.
 * @param capital             - Account capital in native token units.
 * @param positionSize        - Signed position size (positive = long, negative = short).
 * @param maintenanceMarginBps - Maintenance margin requirement in basis points (e.g. 500n = 5%).
 * @returns Liquidation price in e6 format. Returns 0n for longs that can't be liquidated,
 *          or max u64 for shorts with ≥100% maintenance margin.
 *
 * @example
 * ```ts
 * // Long 1 SOL at $100, $10 capital, 5% maintenance margin
 * const liqPrice = computeLiqPrice(100_000_000n, 10_000_000n, 1_000_000n, 500n);
 * ```
 */
export declare function computeLiqPrice(entryPrice: bigint, capital: bigint, positionSize: bigint, maintenanceMarginBps: bigint): bigint;
/**
 * Compute estimated liquidation price BEFORE opening a trade.
 * Accounts for trading fees reducing effective capital.
 *
 * @param oracleE6   - Current oracle price in e6 format (used as entry estimate).
 * @param margin     - Deposit margin in native token units.
 * @param posSize    - Intended position size (absolute value used internally).
 * @param maintBps   - Maintenance margin in basis points.
 * @param feeBps     - Trading fee in basis points.
 * @param direction  - Trade direction: `"long"` or `"short"`.
 * @returns Estimated liquidation price in e6 format.
 *
 * @example
 * ```ts
 * const liq = computePreTradeLiqPrice(
 *   100_000_000n, 10_000_000n, 1_000_000n, 500n, 30n, "long"
 * );
 * ```
 */
export declare function computePreTradeLiqPrice(oracleE6: bigint, margin: bigint, posSize: bigint, maintBps: bigint, feeBps: bigint, direction: "long" | "short"): bigint;
/**
 * Compute trading fee from notional value and fee rate in bps.
 *
 * @param notional      - Trade notional value in native token units.
 * @param tradingFeeBps - Fee rate in basis points (e.g. 30n = 0.30%).
 * @returns Fee amount in native token units.
 *
 * @example
 * ```ts
 * const fee = computeTradingFee(1_000_000_000n, 30n); // 0.30% of 1 SOL
 * ```
 */
export declare function computeTradingFee(notional: bigint, tradingFeeBps: bigint): bigint;
/**
 * Dynamic fee tier configuration.
 */
export interface FeeTierConfig {
    /** Base trading fee (Tier 1) in bps */
    baseBps: bigint;
    /** Tier 2 fee in bps (0 = disabled) */
    tier2Bps: bigint;
    /** Tier 3 fee in bps (0 = disabled) */
    tier3Bps: bigint;
    /** Notional threshold to enter Tier 2 (0 = tiered fees disabled) */
    tier2Threshold: bigint;
    /** Notional threshold to enter Tier 3 */
    tier3Threshold: bigint;
}
/**
 * Compute the effective fee rate in bps using the tiered fee schedule.
 *
 * Mirrors on-chain `compute_dynamic_fee_bps` logic:
 * - notional < tier2Threshold → baseBps (Tier 1)
 * - notional < tier3Threshold → tier2Bps (Tier 2)
 * - notional >= tier3Threshold → tier3Bps (Tier 3)
 *
 * If tier2Threshold == 0, tiered fees are disabled (flat baseBps).
 */
export declare function computeDynamicFeeBps(notional: bigint, config: FeeTierConfig): bigint;
/**
 * Compute the dynamic trading fee for a given notional and tier config.
 *
 * Uses ceiling division to match on-chain behavior (prevents fee evasion
 * via micro-trades).
 */
export declare function computeDynamicTradingFee(notional: bigint, config: FeeTierConfig): bigint;
/**
 * Fee split configuration.
 */
export interface FeeSplitConfig {
    /** LP vault share in bps (0–10_000) */
    lpBps: bigint;
    /** Protocol treasury share in bps */
    protocolBps: bigint;
    /** Market creator share in bps */
    creatorBps: bigint;
}
/**
 * Compute fee split for a total fee amount.
 *
 * Returns [lpShare, protocolShare, creatorShare].
 * If all split params are 0, 100% goes to LP (legacy behavior).
 * Creator gets the rounding remainder to ensure total is preserved.
 */
export declare function computeFeeSplit(totalFee: bigint, config: FeeSplitConfig): [bigint, bigint, bigint];
/**
 * Compute PnL as a percentage of capital.
 *
 * Uses BigInt scaling to avoid precision loss from Number(bigint) conversion.
 * Number(bigint) silently truncates values above 2^53, which can produce
 * incorrect percentages for large positions (e.g., tokens with 9 decimals
 * where capital > ~9M tokens in native units exceeds MAX_SAFE_INTEGER).
 */
export declare function computePnlPercent(pnlTokens: bigint, capital: bigint): number;
/**
 * Estimate entry price including fee impact (slippage approximation).
 *
 * @param oracleE6      - Current oracle price in e6 format.
 * @param tradingFeeBps - Trading fee in basis points.
 * @param direction     - Trade direction: `"long"` or `"short"`.
 * @returns Estimated entry price in e6 format (higher for longs, lower for shorts).
 *
 * @example
 * ```ts
 * const entry = computeEstimatedEntryPrice(100_000_000n, 30n, "long");
 * // → 100_030_000n (oracle + 0.30% fee impact)
 * ```
 */
export declare function computeEstimatedEntryPrice(oracleE6: bigint, tradingFeeBps: bigint, direction: "long" | "short"): bigint;
/**
 * Convert per-slot funding rate (bps) to annualized percentage.
 *
 * @param fundingRateBpsPerSlot - Funding rate per slot in basis points (i64 from engine state).
 * @returns Annualized funding rate as a percentage (e.g. 12.5 = 12.5% APR).
 * @throws Error if the value exceeds Number.MAX_SAFE_INTEGER.
 *
 * @example
 * ```ts
 * const apr = computeFundingRateAnnualized(1n); // ~78.84% APR
 * ```
 */
export declare function computeFundingRateAnnualized(fundingRateBpsPerSlot: bigint): number;
/**
 * Compute margin required for a given notional and initial margin bps.
 *
 * @param notional         - Trade notional value in native token units.
 * @param initialMarginBps - Initial margin requirement in basis points (e.g. 1000n = 10%).
 * @returns Required margin in native token units.
 *
 * @example
 * ```ts
 * const margin = computeRequiredMargin(10_000_000_000n, 1000n); // 10% of notional
 * // → 1_000_000_000n
 * ```
 */
export declare function computeRequiredMargin(notional: bigint, initialMarginBps: bigint): bigint;
/**
 * Compute maximum leverage from initial margin bps.
 *
 * Formula: leverage = 10000 / initialMarginBps
 * Uses scaled arithmetic to preserve precision for fractional leverage values.
 *
 * @param initialMarginBps - Initial margin requirement in basis points (e.g. 500n = 5% → 20x).
 * @returns Maximum leverage as a number (e.g. 20 for 500 bps, 3.003 for 3333 bps).
 * @throws Error if initialMarginBps is zero (infinite leverage is undefined).
 *
 * @example
 * ```ts
 * const maxLev = computeMaxLeverage(500n); // → 20
 * const maxLev2 = computeMaxLeverage(1000n); // → 10
 * const maxLev3 = computeMaxLeverage(3333n); // → 3.003 (not truncated to 3)
 * ```
 */
export declare function computeMaxLeverage(initialMarginBps: bigint): number;
/**
 * Compute the maximum amount that can be withdrawn from a position.
 *
 * The withdrawable amount is the capital plus any matured (unreserved) PnL.
 * Reserved PnL is still locked and cannot be withdrawn until the warmup period elapses.
 *
 * Formula: max_withdrawable = capital + max(0, pnl - reserved_pnl)
 *
 * @param capital - Capital allocated to the position (in native token units)
 * @param pnl - Mark-to-market PnL (in native token units, can be negative)
 * @param reservedPnl - PnL that is still locked during warmup (always non-negative)
 * @returns The maximum amount in native units that can be withdrawn without closing the position
 *
 * @example
 * ```ts
 * // Position: 10 SOL capital, +2 SOL mark PnL, 0.5 SOL reserved
 * const max = computeMaxWithdrawable(
 *   10_000_000_000n,  // 10 SOL in lamports
 *   2_000_000_000n,   // +2 SOL in lamports
 *   500_000_000n      // 0.5 SOL reserved in lamports
 * );
 * // Returns: 11_500_000_000n (10 + (2 - 0.5) = 11.5 SOL in lamports)
 * ```
 */
export declare function computeMaxWithdrawable(capital: bigint, pnl: bigint, reservedPnl: bigint): bigint;
