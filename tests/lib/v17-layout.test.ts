import { describe, expect, it } from "vitest";
import {
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
  V17_HEADER_LEN,
  V17_EXPECTED_WRAPPER_CONFIG_LEN,
  MG_DERIVED_LEN,
  ENGINE_ASSET_SLOT_DERIVED_LEN,
  ASSET_SLOT_DERIVED_STRIDE,
  MG_CONFIG_OFF,
  MG_VAULT_OFF,
  MG_INSURANCE_OFF,
  MG_C_TOT_OFF,
  MG_MODE_OFF,
  MG_CURRENT_SLOT_OFF,
  V16_CFG_LEN,
  V16_CFG_MAINTENANCE_MARGIN_BPS_OFF,
  BACKING_BUCKET_LEN,
  SOURCE_CREDIT_LEN,
  INSURANCE_RESERVATION_LEN,
  ASSET_STATE_LEN,
  SLOT_BACKING_LONG_OFF,
  SLOT_BACKING_SHORT_OFF,
  V17_ASSET_SLOTS_BASE_OFF,
  backingBucketOff,
  engineAssetSlotOff,
  assertV17LayoutGeneration,
} from "../../src/lib/v17-layout.js";

describe("v17 layout — SDK is the source of truth", () => {
  it("takes the wrapper config length from the SDK, not a local literal", () => {
    // The bug this whole module exists to prevent: the keeper hardcoded 432
    // while the deployed wrapper moved 432 -> 496 -> 576.
    expect(V17_WRAPPER_CONFIG_LEN).toBe(576);
    expect(V17_WRAPPER_CONFIG_LEN).not.toBe(432);
    expect(V17_WRAPPER_CONFIG_LEN).not.toBe(496);
  });

  it("puts the market group header 144 bytes later than the stale constant did", () => {
    expect(V17_MARKET_GROUP_OFF).toBe(V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN);
    expect(V17_MARKET_GROUP_OFF).toBe(592);
    // What the keeper was using before the fix:
    const staleMarketGroupOff = 16 + 432;
    expect(staleMarketGroupOff).toBe(448);
    expect(V17_MARKET_GROUP_OFF - staleMarketGroupOff).toBe(144);
  });

  it("agrees with the tripwire's expected generation", () => {
    expect(V17_WRAPPER_CONFIG_LEN).toBe(V17_EXPECTED_WRAPPER_CONFIG_LEN);
    expect(() => assertV17LayoutGeneration()).not.toThrow();
  });
});

describe("v17 layout — struct sizes derived independently, then cross-checked", () => {
  // These are the checks that actually caught the 432 bug: sum the field sizes
  // from the engine's #[repr(C)] structs and compare against a length the SDK
  // sourced separately. Two independent derivations agreeing is evidence; one
  // derivation agreeing with itself is not.

  it("MarketGroupV16HeaderAccount field offsets sum to the SDK's length", () => {
    expect(MG_DERIVED_LEN).toBe(V17_MARKET_GROUP_LEN);
    expect(MG_DERIVED_LEN).toBe(758);
  });

  it("EngineAssetSlotV16Account field offsets sum to the SDK's stride", () => {
    expect(ENGINE_ASSET_SLOT_DERIVED_LEN).toBe(1285);
    expect(ASSET_SLOT_DERIVED_STRIDE).toBe(V17_MARKET_ASSET_SLOT_LEN);
    expect(ASSET_SLOT_DERIVED_STRIDE).toBe(1797);
  });

  it("V16ConfigAccount length is consistent with the vault/insurance offsets", () => {
    // insurance sits at config_off + config_len + asset_slot_capacity(4) + vault(16).
    expect(MG_CONFIG_OFF + V16_CFG_LEN + 4).toBe(MG_VAULT_OFF);
    expect(MG_VAULT_OFF + 16).toBe(MG_INSURANCE_OFF);
    expect(MG_INSURANCE_OFF + 16).toBe(MG_C_TOT_OFF);
    expect(MG_INSURANCE_OFF).toBe(301); // matches percolator-indexer's independent reading
    expect(MG_C_TOT_OFF).toBe(317);
  });

  it("sub-struct sizes match the engine's Pod definitions", () => {
    expect(ASSET_STATE_LEN).toBe(499);
    expect(SOURCE_CREDIT_LEN).toBe(11 * 16 + 8); // 11×u128 + u64
    expect(BACKING_BUCKET_LEN).toBe(8 + 5 * 16 + 8 + 1); // market_id + 5×u128 + expiry + status
    expect(INSURANCE_RESERVATION_LEN).toBe(4 * 16 + 8);
    expect(SLOT_BACKING_SHORT_OFF - SLOT_BACKING_LONG_OFF).toBe(BACKING_BUCKET_LEN);
  });
});

describe("v17 layout — domain addressing", () => {
  it("maps domain to (asset, side) the way the engine does", () => {
    // engine domain_asset_side: asset = domain/2, side = domain%2 (0 = long).
    // Getting this backwards would expire the wrong bucket.
    expect(backingBucketOff(0)).toBe(engineAssetSlotOff(0) + SLOT_BACKING_LONG_OFF);
    expect(backingBucketOff(1)).toBe(engineAssetSlotOff(0) + SLOT_BACKING_SHORT_OFF);
    expect(backingBucketOff(2)).toBe(engineAssetSlotOff(1) + SLOT_BACKING_LONG_OFF);
    expect(backingBucketOff(3)).toBe(engineAssetSlotOff(1) + SLOT_BACKING_SHORT_OFF);
  });

  it("advances one full stride per asset", () => {
    expect(engineAssetSlotOff(1) - engineAssetSlotOff(0)).toBe(V17_MARKET_ASSET_SLOT_LEN);
    expect(backingBucketOff(2) - backingBucketOff(0)).toBe(V17_MARKET_ASSET_SLOT_LEN);
  });

  it("places asset slots immediately after the market group header", () => {
    expect(V17_ASSET_SLOTS_BASE_OFF).toBe(V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN);
    expect(V17_ASSET_SLOTS_BASE_OFF).toBe(1350);
  });

  it("locates mode and current_slot inside the header", () => {
    expect(MG_MODE_OFF).toBeLessThan(MG_DERIVED_LEN);
    expect(MG_CURRENT_SLOT_OFF).toBeLessThan(MG_MODE_OFF);
    expect(MG_CURRENT_SLOT_OFF + 8).toBeLessThanOrEqual(MG_MODE_OFF);
    expect(V16_CFG_MAINTENANCE_MARGIN_BPS_OFF).toBe(54);
  });
});
