import { describe, expect, it } from "vitest";
import { parseV17RiskParams, V17_RISK_PARAMS_MIN_DATA_LEN } from "../src/lib/v17-risk.js";

const V17_HEADER_LEN = 16;
const V17_WRAPPER_CONFIG_LEN = 432;
const V17_MARKET_GROUP_OFF = V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN;
const V17_MARKET_GROUP_ID_LEN = 32;
const V17_ENGINE_CONFIG_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_ID_LEN;

function writeU64LE(data: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    data[offset + i] = Number((value >> (8n * BigInt(i))) & 0xffn);
  }
}

function writeU128LE(data: Uint8Array, offset: number, value: bigint): void {
  writeU64LE(data, offset, value & ((1n << 64n) - 1n));
  writeU64LE(data, offset + 8, value >> 64n);
}

describe("PoC: v17 risk params are parsed from the market-group header", () => {
  it("proves the previous 512-byte discovery slice cannot include maintenance_margin_bps", () => {
    expect(() => parseV17RiskParams(new Uint8Array(512))).toThrow(/data too short/i);
    expect(V17_RISK_PARAMS_MIN_DATA_LEN).toBeGreaterThan(512);
  });

  it("decodes the actual on-chain maintenance margin instead of assuming 500 bps", () => {
    const data = new Uint8Array(V17_RISK_PARAMS_MIN_DATA_LEN);

    writeU128LE(data, V17_HEADER_LEN + 96, 7n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 38, 100n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 46, 86_400n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 54, 1_000n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 78, 75n);

    const params = parseV17RiskParams(data);

    expect(params.maintenanceMarginBps).toBe(1_000n);
    expect(params.maintenanceMarginBps).not.toBe(500n);
    expect(params.hMin).toBe(100n);
    expect(params.hMax).toBe(86_400n);
    expect(params.maintenanceFeePerSlot).toBe(7n);
    expect(params.liquidationFeeShareBps).toBe(75n);
  });
});
