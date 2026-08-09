import { describe, it, expect } from "vitest";

// Offsets come from the PRODUCTION modules, not a local copy.
//
// This test used to mirror the constants "to keep the test self-contained",
// which made it a tautology: it computed an offset from its own copies and
// asserted the result equalled the same copies re-added by hand. It could not
// fail no matter what the keeper actually did, and it happily kept passing
// through the entire period when production was reading v17 markets at the
// stale 432-byte-config layout. Importing the real functions is what makes this
// a test rather than an arithmetic identity.
import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_ASSET_ORACLE_WRAPPER_LEN,
  V17_ASSET_SLOT_STRIDE,
  V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT,
} from "../../src/lib/v17-risk.js";
import { engineAssetSlotOff } from "../../src/lib/v17-layout.js";

function computeEffectivePriceOffset(assetIndex: number): number {
  return engineAssetSlotOff(assetIndex) + V17_EFFECTIVE_PRICE_OFF_IN_ASSET_SLOT;
}

function off0Expected(): number {
  return V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_WRAPPER_LEN + 25;
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
    // Post-fee-split: market group at 592 (was 448 under the stale 432-byte
    // wrapper config), + header 758 + oracle wrapper prefix 512 + 25 = 1887.
    expect(off0).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_ORACLE_WRAPPER_LEN + 25);
    expect(off0).toBe(1887);

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
    // One full stride (1797) past asset 0: 1887 + 1797 = 3684.
    expect(off1).toBe(off0Expected() + V17_ASSET_SLOT_STRIDE);
    expect(off1).toBe(3684);

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
