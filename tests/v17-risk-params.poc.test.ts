import { describe, expect, it } from "vitest";
import {
  parseV17RiskParams,
  V17_RISK_PARAMS_MIN_DATA_LEN,
  V17RiskParamsCorruptedError,
} from "../src/lib/v17-risk.js";

// Layout constants come from the SDK via v17-layout.ts. This test previously
// duplicated the stale `V17_WRAPPER_CONFIG_LEN = 432` literal, so it wrote its
// fixture bytes at exactly the same wrong offsets the parser read them from —
// the test passed while the parser was misreading every live account. A test
// that shares the bug under test cannot detect it; both sides now derive from
// one source.
import {
  MG_CONFIG_OFF,
  V17_HEADER_LEN,
  V17_MARKET_GROUP_OFF,
} from "../src/lib/v17-layout.js";

const V17_ENGINE_CONFIG_OFF = V17_MARKET_GROUP_OFF + MG_CONFIG_OFF;

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

  // H-8: a zero (or implausibly large) maintenanceMarginBps makes the
  // liquidation-candidacy comparison `marginRatioBps < maintenanceMarginBps`
  // unsatisfiable (0n<0n is always false) or trivially satisfied for every
  // position (>10000n), silently. The engine permits exactly 100% margin as
  // a fast-path config, so the valid parser range is (0, 10000].
  describe("H-8: maintenanceMarginBps sanity validation", () => {
    function buildData(maintenanceMarginBps: bigint): Uint8Array {
      const data = new Uint8Array(V17_RISK_PARAMS_MIN_DATA_LEN);
      writeU128LE(data, V17_HEADER_LEN + 96, 7n);
      writeU64LE(data, V17_ENGINE_CONFIG_OFF + 38, 100n);
      writeU64LE(data, V17_ENGINE_CONFIG_OFF + 46, 86_400n);
      writeU64LE(data, V17_ENGINE_CONFIG_OFF + 54, maintenanceMarginBps);
      writeU64LE(data, V17_ENGINE_CONFIG_OFF + 78, 75n);
      return data;
    }

    it("throws V17RiskParamsCorruptedError when maintenanceMarginBps decodes to 0", () => {
      expect(() => parseV17RiskParams(buildData(0n))).toThrow(V17RiskParamsCorruptedError);
      expect(() => parseV17RiskParams(buildData(0n))).toThrow(/maintenanceMarginBps=0/);
    });

    it("throws when maintenanceMarginBps decodes above 10_000 (> 100% margin)", () => {
      expect(() => parseV17RiskParams(buildData(10_001n))).toThrow(V17RiskParamsCorruptedError);
    });

    it("throws when maintenanceMarginBps decodes to an implausibly huge corrupted value", () => {
      expect(() => parseV17RiskParams(buildData(18_446_744_073_709_551_615n))).toThrow(
        V17RiskParamsCorruptedError,
      );
    });

    it("accepts the boundary values 1, 9999, and 10000 bps", () => {
      expect(parseV17RiskParams(buildData(1n)).maintenanceMarginBps).toBe(1n);
      expect(parseV17RiskParams(buildData(9_999n)).maintenanceMarginBps).toBe(9_999n);
      expect(parseV17RiskParams(buildData(10_000n)).maintenanceMarginBps).toBe(10_000n);
    });
  });
});

describe("M-8: warmupPeriodSlots/openInterestCap/adlFillCapBps/minPositionSize are documented stubs, not parsed values", () => {
  it("stay 0n regardless of surrounding non-zero data — they have no on-chain byte offset to read", () => {
    // Fill the whole buffer with non-zero bytes, including the real parsed
    // fields (overwritten with known values below) and everywhere else.
    // If any of the 4 stub fields were silently reading from some byte
    // range, this would surface it as a non-zero result.
    const data = new Uint8Array(V17_RISK_PARAMS_MIN_DATA_LEN).fill(0xff);

    writeU128LE(data, V17_HEADER_LEN + 96, 7n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 38, 100n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 46, 86_400n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 54, 1_000n);
    writeU64LE(data, V17_ENGINE_CONFIG_OFF + 78, 75n);

    const params = parseV17RiskParams(data);

    expect(params.warmupPeriodSlots).toBe(0n);
    expect(params.openInterestCap).toBe(0n);
    expect(params.adlFillCapBps).toBe(0n);
    expect(params.minPositionSize).toBe(0n);
    // Sanity check: the real fields DO pick up the non-zero fill, proving
    // the buffer construction above isn't accidentally all-zero.
    expect(params.maintenanceMarginBps).toBe(1_000n);
  });
});
