import { describe, it, expect } from "vitest";

// Constants from v17-risk.ts (mirrored here to keep test self-contained)
const V17_MARKET_GROUP_OFF = 448;
const V17_MARKET_GROUP_LEN = 758;
const V17_ASSET_ORACLE_WRAPPER_LEN = 512;
const V17_ENGINE_ASSET_SLOT_LEN = 1285;
const V17_ASSET_SLOT_STRIDE = V17_ASSET_ORACLE_WRAPPER_LEN + V17_ENGINE_ASSET_SLOT_LEN;
const V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT = 25;

function computeEffectivePriceOffset(assetIndex: number): number {
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN
    + assetIndex * V17_ASSET_SLOT_STRIDE
    + V17_ASSET_ORACLE_WRAPPER_LEN
    + V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]!) << (8n * BigInt(i));
  }
  return value;
}

describe("issue-331: per-asset effective_price byte offset", () => {
  it("reads effective_price at correct offset for asset 0", () => {
    const off0 = computeEffectivePriceOffset(0);
    expect(off0).toBe(448 + 758 + 512 + 25); // 1743

    // Build a mock market data buffer with a known price at that offset
    const bufLen = off0 + 8;
    const buf = new Uint8Array(bufLen);
    const expectedPrice = 1_500_000n; // $1.5 in e6
    const priceBytes = new DataView(buf.buffer);
    priceBytes.setBigUint64(off0, expectedPrice, true); // little-endian

    const readBack = readU64LE(buf, off0);
    expect(readBack).toBe(expectedPrice);
  });

  it("reads effective_price at correct offset for asset 1", () => {
    const off1 = computeEffectivePriceOffset(1);
    expect(off1).toBe(448 + 758 + 1797 + 512 + 25); // 1743 + 1797 = 3540

    const bufLen = off1 + 8;
    const buf = new Uint8Array(bufLen);
    const expectedPrice = 2_000_000n; // $2 in e6
    const priceBytes = new DataView(buf.buffer);
    priceBytes.setBigUint64(off1, expectedPrice, true);

    const readBack = readU64LE(buf, off1);
    expect(readBack).toBe(expectedPrice);
  });

  it("stride between assets is 1797 bytes (512 oracle wrapper + 1285 engine slot)", () => {
    const off0 = computeEffectivePriceOffset(0);
    const off1 = computeEffectivePriceOffset(1);
    expect(off1 - off0).toBe(V17_ASSET_SLOT_STRIDE);
    expect(V17_ASSET_SLOT_STRIDE).toBe(1797);
  });

  it("returns 0n when buffer is too short", async () => {
    const { readEffectivePriceForAsset } = await import("../../src/lib/v17-risk.js");
    const tooShort = new Uint8Array(10);
    expect(readEffectivePriceForAsset(tooShort, 0)).toBe(0n);
  });
});
