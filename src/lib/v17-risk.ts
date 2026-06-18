const V17_HEADER_LEN = 16;
const V17_WRAPPER_CONFIG_LEN = 432;
const V17_MARKET_GROUP_OFF = V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN;
const V17_MARKET_GROUP_ID_LEN = 32;
const V17_ENGINE_CONFIG_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_ID_LEN;

const V17_ENGINE_CONFIG_H_MIN_OFF = 38;
const V17_ENGINE_CONFIG_H_MAX_OFF = 46;
const V17_ENGINE_CONFIG_MAINTENANCE_MARGIN_BPS_OFF = 54;
const V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF = 78;

const V17_WRAPPER_MAINTENANCE_FEE_PER_SLOT_OFF = V17_HEADER_LEN + 96;

export const V17_RISK_PARAMS_MIN_DATA_LEN =
  V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF + 8;

function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new Error(`readU64LE out of bounds at ${offset}`);
  }
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]!) << (8n * BigInt(i));
  }
  return value;
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  const lo = readU64LE(data, offset);
  const hi = readU64LE(data, offset + 8);
  return lo | (hi << 64n);
}

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
} {
  if (data.length < V17_RISK_PARAMS_MIN_DATA_LEN) {
    throw new Error(
      `parseV17RiskParams: data too short — need ${V17_RISK_PARAMS_MIN_DATA_LEN} bytes, got ${data.length}`,
    );
  }

  return {
    warmupPeriodSlots: 0n,
    maintenanceMarginBps: readU64LE(
      data,
      V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_MAINTENANCE_MARGIN_BPS_OFF,
    ),
    hMin: readU64LE(data, V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_H_MIN_OFF),
    hMax: readU64LE(data, V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_H_MAX_OFF),
    openInterestCap: 0n,
    maintenanceFeePerSlot: readU128LE(data, V17_WRAPPER_MAINTENANCE_FEE_PER_SLOT_OFF),
    liquidationFeeShareBps: readU64LE(
      data,
      V17_ENGINE_CONFIG_OFF + V17_ENGINE_CONFIG_LIQUIDATION_FEE_BPS_OFF,
    ),
    adlFillCapBps: 0n,
    minPositionSize: 0n,
  };
}
