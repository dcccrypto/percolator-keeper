const V17_HEADER_LEN = 16;
const V17_WRAPPER_CONFIG_LEN = 432;
// V17_MARKET_GROUP_OFF is exported below for use by callers (per-asset price reading).
const V17_MARKET_GROUP_ID_LEN = 32;

// ─── Exported layout constants ────────────────────────────────────────────────

export const V17_MARKET_GROUP_OFF = V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN; // 448
export const V17_MARKET_GROUP_LEN = 758; // MarketGroupV16HeaderAccount size
export const V17_ENGINE_ASSET_SLOT_LEN = 1285; // EngineAssetSlotV16Account size
export const V17_ASSET_ORACLE_WRAPPER_LEN = 512; // ASSET_ORACLE_WRAPPER_LEN constant
export const V17_ASSET_SLOT_STRIDE = 1797; // ASSET_ORACLE_WRAPPER_LEN + ENGINE_ASSET_SLOT_LEN
// offset of effective_price within EngineAssetSlotV16Account (after the ORACLE_WRAPPER prefix)
// = 8 (market_id) + 8 (retired_slot) + 1 (lifecycle) + 8 (raw_oracle_target_price) = 25
export const V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT = 25;
// #335: offset of raw_oracle_target_price within EngineAssetSlotV16Account (after the
// ORACLE_WRAPPER prefix). It is the field immediately BEFORE effective_price:
// = 8 (market_id) + 8 (retired_slot) + 1 (lifecycle) = 17.
// Verified against percolator engine AssetStateV16Account (src/v16.rs:4317): the Pod
// struct is #[repr(C)] over alignment-1 byte-array fields (V16PodU64 = [u8;8], no
// padding), so raw_oracle_target_price (V16PodU64) sits at byte 17 and effective_price
// at byte 25. (src/v16.rs:1168 target_effective_lag_adverse_delta consumes both.)
export const V17_RAW_ORACLE_TARGET_PRICE_OFF_IN_ASSET_SLOT = 17;
// absolute offset of min_nonzero_mm_req in the market account data
// = V17_ENGINE_CONFIG_OFF + V16PodU16(2) + V16PodU32(4) = 480 + 6 = 486
export const V17_MIN_NONZERO_MM_REQ_OFF = 486;

const V17_ENGINE_CONFIG_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_ID_LEN;

const V17_ENGINE_CONFIG_H_MIN_OFF = 38;
const V17_ENGINE_CONFIG_H_MAX_OFF = 46;
const V17_ENGINE_CONFIG_MAINTENANCE_MARGIN_BPS_OFF = 54;
const V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF = 78;

const V17_WRAPPER_MAINTENANCE_FEE_PER_SLOT_OFF = V17_HEADER_LEN + 96;

export const V17_RISK_PARAMS_MIN_DATA_LEN = Math.max(
  V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF + 8,
  V17_MIN_NONZERO_MM_REQ_OFF + 16,
);

export function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new Error(`readU64LE out of bounds at ${offset}`);
  }
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]!) << (8n * BigInt(i));
  }
  return value;
}

export function readU128LE(data: Uint8Array, offset: number): bigint {
  const lo = readU64LE(data, offset);
  const hi = readU64LE(data, offset + 8);
  return lo | (hi << 64n);
}

/**
 * Read the effective_price (u64 LE) for a given asset index from raw market account bytes.
 *
 * Layout (within the market account data, past the wrapper config + market group header):
 *   Per-asset slot starts at: V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + assetIndex * V17_ASSET_SLOT_STRIDE
 *   Within each slot: first V17_ASSET_ORACLE_WRAPPER_LEN bytes = oracle wrapper prefix,
 *     then V17_ENGINE_ASSET_SLOT_LEN bytes = EngineAssetSlotV16Account.
 *   effective_price is at offset V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT within the engine asset slot.
 *
 * Returns 0n if the buffer is too short to contain the field (safe fallback to caller-provided price).
 */
export function readEffectivePriceForAsset(data: Uint8Array, assetIndex: number): bigint {
  const off = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN
    + assetIndex * V17_ASSET_SLOT_STRIDE
    + V17_ASSET_ORACLE_WRAPPER_LEN
    + V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT;
  if (off + 8 > data.length) return 0n;
  return readU64LE(data, off);
}

/**
 * #335: Read the raw_oracle_target_price (u64 LE) for a given asset index from raw
 * market account bytes. Same per-asset slot layout as readEffectivePriceForAsset,
 * but at V17_RAW_ORACLE_TARGET_PRICE_OFF_IN_ASSET_SLOT (17) within the engine asset
 * slot. Needed to compute the engine's target/effective-price lag penalty
 * (src/v16.rs:1168 target_effective_lag_adverse_delta).
 *
 * Returns 0n if the buffer is too short to contain the field. Callers MUST treat
 * 0n as "unknown" — never as a real $0 target — so a missing read can only ever
 * OMIT the lag penalty (conservative: it never marks a portfolio healthier).
 */
export function readRawOracleTargetPriceForAsset(data: Uint8Array, assetIndex: number): bigint {
  const off = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN
    + assetIndex * V17_ASSET_SLOT_STRIDE
    + V17_ASSET_ORACLE_WRAPPER_LEN
    + V17_RAW_ORACLE_TARGET_PRICE_OFF_IN_ASSET_SLOT;
  if (off + 8 > data.length) return 0n;
  return readU64LE(data, off);
}

/**
 * #335: target/effective-price lag penalty, mirroring the engine exactly.
 *
 * Engine (verified):
 *   src/v16.rs:1168 target_effective_lag_adverse_delta(side, effective, raw_target):
 *     long  → effective - raw_target   when raw_target <  effective (strict)
 *     short → raw_target - effective   when raw_target >  effective (strict)
 *     else  → 0
 *   src/v16.rs:1157 target_effective_lag_loss_penalty:
 *     penalty = risk_notional_ceil(abs_pos_q, adverse_delta)
 *             = ceil(abs_pos_q * adverse_delta / POS_SCALE)   (POS_SCALE = 1_000_000, lib.rs:15)
 *   src/v16.rs:1207 health_requirements_from_base_and_target_lag:
 *     leg_maintenance = base_maintenance + target_lag_penalty   (ADDED at face value)
 *
 * `side`: +1 for long (basisPosQ > 0), -1 for short (basisPosQ < 0).
 * `absPos`: abs(basisPosQ). `effectivePrice`/`rawTargetPrice`: per-asset prices (E6).
 *
 * Returns 0n (no penalty) when rawTargetPrice is 0n ("unknown") so a missing
 * read can only ever under-penalize toward MORE liquidations, never mask one.
 */
export function targetEffectiveLagPenalty(
  absPos: bigint,
  side: 1 | -1,
  effectivePrice: bigint,
  rawTargetPrice: bigint,
): bigint {
  // 0n target means we couldn't read it — omit the penalty (never mark healthier).
  if (rawTargetPrice <= 0n || effectivePrice <= 0n || absPos <= 0n) return 0n;
  let adverseDelta = 0n;
  if (side === 1) {
    // long: adverse when effective > raw_target
    if (rawTargetPrice < effectivePrice) adverseDelta = effectivePrice - rawTargetPrice;
  } else {
    // short: adverse when raw_target > effective
    if (rawTargetPrice > effectivePrice) adverseDelta = rawTargetPrice - effectivePrice;
  }
  if (adverseDelta === 0n) return 0n;
  // ceil(absPos * adverseDelta / POS_SCALE), POS_SCALE = 1_000_000
  const POS_SCALE = 1_000_000n;
  return (absPos * adverseDelta + POS_SCALE - 1n) / POS_SCALE;
}

/**
 * H-8: maintenanceMarginBps gates the only line that decides whether a v17
 * position is liquidatable (`marginRatioBps < maintenanceMarginBps` in
 * liquidation.ts). computeMarginRatioBps() clamps marginRatioBps to exactly
 * 0n whenever notional===0n or equity<=0n, so if maintenanceMarginBps is
 * itself 0n -- an uninitialized account, a future on-chain layout change
 * shifting this field's byte offset without a matching keeper update, or
 * corrupted/zeroed bytes -- `0n < 0n` is always false: no position in that
 * market, however underwater, is ever flagged liquidatable, silently. A
 * value >= 10_000 bps (>=100% margin requirement) is equally not a coherent
 * on-chain config and would cause the opposite failure: every position with
 * any notional would immediately appear liquidatable. Neither is a real
 * market configuration -- treat both as corrupted data and refuse to parse.
 */
export class V17RiskParamsCorruptedError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: bigint,
  ) {
    super(
      `parseV17RiskParams: ${field}=${value} is out of the valid (0, 10000) bps range ` +
        `(suspected corrupted/misaligned read)`,
    );
    this.name = "V17RiskParamsCorruptedError";
  }
}

/**
 * M-8: four fields below are hardcoded to 0n, not parsed from on-chain bytes.
 * Verified against percolator-prog's v16_program.rs (the v16/v17 engine
 * config struct) and percolator-sdk — neither defines openInterestCap,
 * adlFillCapBps, or minPositionSize anywhere; there is no on-chain byte
 * layout for them to parse. warmupPeriodSlots is a real field, but only on
 * pre-v12.15 slabs — v12.15+ (including every v17 market) replaced it with
 * hMin/hMax, which ARE parsed below. A caller must not treat any of these
 * four 0n values as a meaningful on-chain reading (e.g. "no cap"); they are
 * placeholders kept for return-type shape compatibility only.
 */
export function parseV17RiskParams(data: Uint8Array): {
  warmupPeriodSlots: bigint;
  maintenanceMarginBps: bigint;
  hMin: bigint;
  hMax: bigint;
  openInterestCap: bigint;
  maintenanceFeePerSlot: bigint;
  liquidationFeeShareBps: bigint;
  adlFillCapBps: bigint;
  minPositionSize: bigint;
  minNonzeroMmReq: bigint;
} {
  if (data.length < V17_RISK_PARAMS_MIN_DATA_LEN) {
    throw new Error(
      `parseV17RiskParams: data too short — need ${V17_RISK_PARAMS_MIN_DATA_LEN} bytes, got ${data.length}`,
    );
  }

  const maintenanceMarginBps = readU64LE(
    data,
    V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_MAINTENANCE_MARGIN_BPS_OFF,
  );
  if (maintenanceMarginBps <= 0n || maintenanceMarginBps > 10_000n) {
    throw new V17RiskParamsCorruptedError("maintenanceMarginBps", maintenanceMarginBps);
  }

  return {
    warmupPeriodSlots: 0n, // not present on v17 slabs — see function doc comment
    maintenanceMarginBps,
    hMin: readU64LE(data, V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_H_MIN_OFF),
    hMax: readU64LE(data, V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_H_MAX_OFF),
    openInterestCap: 0n, // no on-chain field exists — see function doc comment
    maintenanceFeePerSlot: readU128LE(data, V17_WRAPPER_MAINTENANCE_FEE_PER_SLOT_OFF),
    liquidationFeeShareBps: readU64LE(
      data,
      V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF,
    ),
    adlFillCapBps: 0n, // no on-chain field exists — see function doc comment
    minPositionSize: 0n, // no on-chain field exists — see function doc comment
    minNonzeroMmReq: readU128LE(data, V17_MIN_NONZERO_MM_REQ_OFF),
  };
}
