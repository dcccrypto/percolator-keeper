/**
 * Warmup leverage cap utilities.
 *
 * During the market warmup period, capital is released linearly over
 * `warmupPeriodSlots` slots, which constrains the effective leverage
 * and maximum position size available to traders.
 */
/**
 * Compute unlocked capital during the warmup period.
 *
 * Capital is released linearly over `warmupPeriodSlots` slots starting from
 * `warmupStartedAtSlot`. Before warmup starts (startSlot === 0) or if the
 * warmup period is 0, all capital is considered unlocked.
 *
 * @param totalCapital    - Total deposited capital (native units).
 * @param currentSlot     - The current on-chain slot.
 * @param warmupStartSlot - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots - Total slots in the warmup period.
 * @returns The amount of capital currently unlocked.
 */
export declare function computeWarmupUnlockedCapital(totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): bigint;
/**
 * Compute the effective maximum leverage during the warmup period.
 *
 * During warmup, only unlocked capital can be used as margin. The effective
 * leverage relative to *total* capital is therefore capped at:
 *
 *   effectiveMaxLeverage = maxLeverage × (unlockedCapital / totalCapital)
 *
 * This returns a floored integer value (leverage is always a whole number
 * in the UI), with a minimum of 1x if any capital is unlocked.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns The effective maximum leverage (integer, ≥ 1).
 */
export declare function computeWarmupLeverageCap(initialMarginBps: bigint, totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): number;
/**
 * Compute the maximum position size allowed during warmup.
 *
 * This is the unlocked capital multiplied by the base max leverage.
 * Unlike `computeWarmupLeverageCap` (which gives effective leverage
 * relative to total capital), this gives the absolute notional cap.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns Maximum position size in native units.
 */
export declare function computeWarmupMaxPositionSize(initialMarginBps: bigint, totalCapital: bigint, currentSlot: bigint, warmupStartSlot: bigint, warmupPeriodSlots: bigint): bigint;
/**
 * Warmup progress information for a position.
 */
export interface WarmupProgress {
    /** PnL available for withdrawal right now (not locked by warmup). */
    maturedPnl: bigint;
    /** PnL still locked until warmup completes. */
    reservedPnl: bigint;
    /** Progress toward full warmup as a basis point (0–10,000). */
    progressBps: bigint;
    /** Slots remaining until full warmup (0 if fully matured). */
    slotsRemaining: bigint;
}
/**
 * Compute PnL warmup progress for a position.
 *
 * During the warmup period, a position's unrealized PnL is linearly released.
 * The portion available for withdrawal grows over time. This utility shows:
 * - How much PnL is currently available (matured)
 * - How much is still locked (reserved)
 * - Progress toward full maturation (as %)
 * - Slots remaining
 *
 * Users can display a progress bar or "unlocks in X slots" message to give
 * transparency into when their PnL becomes withdrawable.
 *
 * @param currentSlot        - Current on-chain slot (from engine state).
 * @param warmupStartedAtSlot - Slot when this position's warmup started.
 * @param warmupPeriodSlots  - Total warmup duration in slots (from market config).
 * @param pnl                - Total realized + unrealized PnL (from account).
 * @param reservedPnl        - PnL locked during warmup (from account).
 * @returns WarmupProgress with matured/reserved PnL, progress %, and slots remaining.
 *
 * @example
 * ```ts
 * const progress = computeWarmupProgress(
 *   10000n,      // current slot
 *   9000n,       // warmup started at slot 9000
 *   2000n,       // warmup period = 2000 slots
 *   1000000000n, // pnl = 1 SOL
 *   600000000n   // reserved = 0.6 SOL (60% still locked)
 * );
 * // Returns:
 * // maturedPnl: 400000000n    (0.4 SOL available)
 * // reservedPnl: 600000000n   (0.6 SOL locked)
 * // progressBps: 5000n        (50% complete)
 * // slotsRemaining: 1000n     (1000 slots until fully mature)
 * ```
 */
export declare function computeWarmupProgress(currentSlot: bigint, warmupStartedAtSlot: bigint, warmupPeriodSlots: bigint, pnl: bigint, reservedPnl: bigint): WarmupProgress;
