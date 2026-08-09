import { describe, expect, it } from "vitest";
import {
  BACKING_BUCKET_LEN,
  BUCKET_EXPIRY_SLOT_OFF,
  BUCKET_FRESH_UNLIENED_OFF,
  BUCKET_STATUS_EMPTY,
  BUCKET_STATUS_EXPIRED,
  BUCKET_STATUS_FRESH,
  BUCKET_STATUS_IMPAIRED,
  BUCKET_STATUS_OFF,
  MG_CURRENT_SLOT_OFF,
  MG_C_TOT_OFF,
  MG_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL_OFF,
  MG_INSURANCE_OFF,
  MG_MATERIALIZED_PORTFOLIO_COUNT_OFF,
  MG_MODE_OFF,
  MG_SOURCE_INSURANCE_CREDIT_RESERVED_ATOMS_OFF,
  V16_CFG_MAX_MARKET_SLOTS_OFF,
  V17_ASSET_SLOTS_BASE_OFF,
  V17_MARKET_ASSET_SLOT_LEN,
  backingBucketOff,
  engineConfigFieldOff,
  marketGroupFieldOff,
} from "../../src/lib/v17-layout.js";
import {
  engineAvailableAtoms,
  findExpirableBuckets,
  findLapsingSoonBuckets,
  isBucketExpiryEligible,
  isLiveOnlyLegEligible,
  isProtocolFeeLegEligible,
  readBackingBuckets,
  readMarketGroupState,
  readU128LE,
  readU64LE,
} from "../../src/lib/v17-fee-state.js";

// ─── Synthetic v17 market account builder ─────────────────────────────────────
// Writes real bytes at the real offsets so the readers are exercised against
// the same layout they will see on chain. Nothing here duplicates an offset —
// every position comes from v17-layout.ts.

function writeU32LE(data: Uint8Array, off: number, value: number): void {
  for (let i = 0; i < 4; i++) data[off + i] = (value >>> (8 * i)) & 0xff;
}
function writeU64LE(data: Uint8Array, off: number, value: bigint): void {
  for (let i = 0; i < 8; i++) data[off + i] = Number((value >> (8n * BigInt(i))) & 0xffn);
}
function writeU128LE(data: Uint8Array, off: number, value: bigint): void {
  writeU64LE(data, off, value & ((1n << 64n) - 1n));
  writeU64LE(data, off + 8, value >> 64n);
}

interface BucketSpec {
  domain: number;
  status: number;
  expirySlot: bigint;
  freshUnliened?: bigint;
}

interface MarketSpec {
  mode?: number;
  currentSlot?: bigint;
  insurance?: bigint;
  cTot?: bigint;
  materializedPortfolioCount?: bigint;
  sourceInsuranceReserved?: bigint;
  insuranceDomainBudgetRemaining?: bigint;
  maxMarketSlots?: number;
  assetSlots?: number;
  buckets?: BucketSpec[];
}

function buildMarketAccount(spec: MarketSpec = {}): Uint8Array {
  const assetSlots = spec.assetSlots ?? 2;
  const data = new Uint8Array(V17_ASSET_SLOTS_BASE_OFF + assetSlots * V17_MARKET_ASSET_SLOT_LEN);

  writeU32LE(
    data,
    engineConfigFieldOff(V16_CFG_MAX_MARKET_SLOTS_OFF),
    spec.maxMarketSlots ?? assetSlots,
  );
  data[marketGroupFieldOff(MG_MODE_OFF)] = spec.mode ?? 0;
  writeU64LE(data, marketGroupFieldOff(MG_CURRENT_SLOT_OFF), spec.currentSlot ?? 0n);
  writeU128LE(data, marketGroupFieldOff(MG_INSURANCE_OFF), spec.insurance ?? 0n);
  writeU128LE(data, marketGroupFieldOff(MG_C_TOT_OFF), spec.cTot ?? 0n);
  writeU64LE(
    data,
    marketGroupFieldOff(MG_MATERIALIZED_PORTFOLIO_COUNT_OFF),
    spec.materializedPortfolioCount ?? 0n,
  );
  writeU128LE(
    data,
    marketGroupFieldOff(MG_SOURCE_INSURANCE_CREDIT_RESERVED_ATOMS_OFF),
    spec.sourceInsuranceReserved ?? 0n,
  );
  writeU128LE(
    data,
    marketGroupFieldOff(MG_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL_OFF),
    spec.insuranceDomainBudgetRemaining ?? 0n,
  );

  for (const bucket of spec.buckets ?? []) {
    const base = backingBucketOff(bucket.domain);
    data[base + BUCKET_STATUS_OFF] = bucket.status;
    writeU64LE(data, base + BUCKET_EXPIRY_SLOT_OFF, bucket.expirySlot);
    writeU128LE(data, base + BUCKET_FRESH_UNLIENED_OFF, bucket.freshUnliened ?? 0n);
  }

  return data;
}

describe("readMarketGroupState", () => {
  it("reads header fields from the post-fee-split offsets", () => {
    const data = buildMarketAccount({
      mode: 2,
      currentSlot: 123_456n,
      insurance: 9_000n,
      cTot: 77n,
      materializedPortfolioCount: 5n,
      maxMarketSlots: 4,
      assetSlots: 3,
    });
    const group = readMarketGroupState(data);
    expect(group.mode).toBe(2);
    expect(group.currentSlot).toBe(123_456n);
    expect(group.insurance).toBe(9_000n);
    expect(group.cTot).toBe(77n);
    expect(group.materializedPortfolioCount).toBe(5n);
    expect(group.maxMarketSlots).toBe(4);
    expect(group.assetSlotCount).toBe(3);
  });

  it("does not confuse adjacent u128 aggregates", () => {
    // insurance / c_tot / the two clamp operands are all u128 and adjacent-ish;
    // an off-by-16 read would silently swap them. Give each a unique value.
    const data = buildMarketAccount({
      insurance: 1n,
      cTot: 2n,
      sourceInsuranceReserved: 3n,
      insuranceDomainBudgetRemaining: 4n,
    });
    const group = readMarketGroupState(data);
    expect(group.insurance).toBe(1n);
    expect(group.cTot).toBe(2n);
    expect(group.sourceInsuranceCreditReservedTotalAtoms).toBe(3n);
    expect(group.insuranceDomainBudgetRemainingTotal).toBe(4n);
  });

  it("refuses a buffer too short to hold the market group header", () => {
    expect(() => readMarketGroupState(new Uint8Array(512))).toThrow(/too short/i);
    // The stale-432 layout would have thought 1206 bytes was enough.
    expect(() => readMarketGroupState(new Uint8Array(1206))).toThrow(/too short/i);
  });
});

describe("engineAvailableAtoms — the shared clamp all three fee legs draw against", () => {
  it("subtracts both reservations", () => {
    const group = readMarketGroupState(
      buildMarketAccount({
        insurance: 1_000n,
        sourceInsuranceReserved: 300n,
        insuranceDomainBudgetRemaining: 200n,
      }),
    );
    expect(engineAvailableAtoms(group)).toBe(500n);
  });

  it("saturates at zero rather than underflowing", () => {
    // A bigint underflow here would produce a negative number that then reads as
    // an enormous available pool — exactly the wrong direction to be wrong in.
    const group = readMarketGroupState(
      buildMarketAccount({
        insurance: 100n,
        sourceInsuranceReserved: 400n,
        insuranceDomainBudgetRemaining: 900n,
      }),
    );
    expect(engineAvailableAtoms(group)).toBe(0n);
  });
});

describe("mode gates match the program's per-tag rules", () => {
  const live = readMarketGroupState(buildMarketAccount({ mode: 0 }));
  const recovery = readMarketGroupState(buildMarketAccount({ mode: 2 }));
  const resolvedWoundDown = readMarketGroupState(
    buildMarketAccount({ mode: 1, materializedPortfolioCount: 0n, cTot: 0n }),
  );
  const resolvedBusy = readMarketGroupState(
    buildMarketAccount({ mode: 1, materializedPortfolioCount: 3n, cTot: 0n }),
  );

  it("tags 78/87 are Live-only", () => {
    expect(isLiveOnlyLegEligible(live)).toBe(true);
    expect(isLiveOnlyLegEligible(recovery)).toBe(false);
    expect(isLiveOnlyLegEligible(resolvedWoundDown)).toBe(false);
  });

  it("tag 89 is Live-only", () => {
    expect(isBucketExpiryEligible(live)).toBe(true);
    expect(isBucketExpiryEligible(recovery)).toBe(false);
    expect(isBucketExpiryEligible(resolvedWoundDown)).toBe(false);
  });

  it("tag 84 additionally allows fully-wound-down Resolved (W12)", () => {
    expect(isProtocolFeeLegEligible(live)).toBe(true);
    expect(isProtocolFeeLegEligible(resolvedWoundDown)).toBe(true);
    // Resolved but still holding portfolios/capital: program returns EngineLockActive.
    expect(isProtocolFeeLegEligible(resolvedBusy)).toBe(false);
    // Recovery is never allowed for any leg.
    expect(isProtocolFeeLegEligible(recovery)).toBe(false);
  });

  it("rejects a Resolved market with outstanding c_tot", () => {
    const resolvedWithCapital = readMarketGroupState(
      buildMarketAccount({ mode: 1, materializedPortfolioCount: 0n, cTot: 1n }),
    );
    expect(isProtocolFeeLegEligible(resolvedWithCapital)).toBe(false);
  });
});

describe("readBackingBuckets — domain addressing", () => {
  it("reads each domain's bucket independently", () => {
    const data = buildMarketAccount({
      assetSlots: 2,
      maxMarketSlots: 2,
      buckets: [
        { domain: 0, status: BUCKET_STATUS_FRESH, expirySlot: 100n, freshUnliened: 11n },
        { domain: 1, status: BUCKET_STATUS_EXPIRED, expirySlot: 200n, freshUnliened: 22n },
        { domain: 2, status: BUCKET_STATUS_IMPAIRED, expirySlot: 300n, freshUnliened: 33n },
        { domain: 3, status: BUCKET_STATUS_EMPTY, expirySlot: 400n, freshUnliened: 44n },
      ],
    });
    const group = readMarketGroupState(data);
    const buckets = readBackingBuckets(data, group);

    expect(buckets).toHaveLength(4);
    expect(buckets[0]).toMatchObject({
      domain: 0, assetIndex: 0, side: "long",
      status: BUCKET_STATUS_FRESH, expirySlot: 100n, freshUnlienedBackingNum: 11n,
    });
    expect(buckets[1]).toMatchObject({ domain: 1, assetIndex: 0, side: "short", expirySlot: 200n });
    expect(buckets[2]).toMatchObject({ domain: 2, assetIndex: 1, side: "long", expirySlot: 300n });
    expect(buckets[3]).toMatchObject({ domain: 3, assetIndex: 1, side: "short", expirySlot: 400n });
  });

  it("writing one bucket does not bleed into its neighbour", () => {
    // Buckets are adjacent (long at +947, short at +1044, 97 bytes each). An
    // off-by-one in BACKING_BUCKET_LEN would make these overlap.
    const data = buildMarketAccount({
      assetSlots: 1, maxMarketSlots: 1,
      buckets: [{ domain: 0, status: BUCKET_STATUS_FRESH, expirySlot: 0xffff_ffffn, freshUnliened: (1n << 100n) }],
    });
    const group = readMarketGroupState(data);
    const buckets = readBackingBuckets(data, group);
    expect(buckets[0]!.expirySlot).toBe(0xffff_ffffn);
    expect(buckets[0]!.freshUnlienedBackingNum).toBe(1n << 100n);
    expect(buckets[1]!.status).toBe(BUCKET_STATUS_EMPTY);
    expect(buckets[1]!.expirySlot).toBe(0n);
  });

  it("iterates min(configured domains, physically present slots)", () => {
    // Configured for 8 assets but the account only holds 2 — reading on the
    // configured count alone would run past the buffer.
    const data = buildMarketAccount({ assetSlots: 2, maxMarketSlots: 8 });
    const group = readMarketGroupState(data);
    expect(readBackingBuckets(data, group)).toHaveLength(4); // 2 assets × 2 sides
  });

  it("stays in bounds when the account holds more slots than configured", () => {
    const data = buildMarketAccount({ assetSlots: 4, maxMarketSlots: 1 });
    const group = readMarketGroupState(data);
    expect(readBackingBuckets(data, group)).toHaveLength(2); // 1 asset × 2 sides
  });
});

describe("findExpirableBuckets — tag 89 detection", () => {
  const mk = (specs: BucketSpec[]) => {
    const data = buildMarketAccount({ assetSlots: 2, maxMarketSlots: 2, buckets: specs });
    return readBackingBuckets(data, readMarketGroupState(data));
  };

  it("selects Fresh buckets at or past their expiry slot", () => {
    const buckets = mk([
      { domain: 0, status: BUCKET_STATUS_FRESH, expirySlot: 100n }, // lapsed
      { domain: 1, status: BUCKET_STATUS_FRESH, expirySlot: 500n }, // not yet
      { domain: 2, status: BUCKET_STATUS_FRESH, expirySlot: 200n }, // exactly at expiry
    ]);
    const found = findExpirableBuckets(buckets, 200n, 0n);
    expect(found.map((b) => b.domain).sort()).toEqual([0, 2]);
  });

  it("ignores buckets that are not Fresh — the engine rejects those with Stale", () => {
    const buckets = mk([
      { domain: 0, status: BUCKET_STATUS_EMPTY, expirySlot: 1n },
      { domain: 1, status: BUCKET_STATUS_EXPIRED, expirySlot: 1n },
      { domain: 2, status: BUCKET_STATUS_IMPAIRED, expirySlot: 1n },
      { domain: 3, status: BUCKET_STATUS_FRESH, expirySlot: 1n },
    ]);
    expect(findExpirableBuckets(buckets, 9_999n, 0n).map((b) => b.domain)).toEqual([3]);
  });

  it("uses max(chainSlot, engineCurrentSlot), matching the program's now_slot", () => {
    const buckets = mk([{ domain: 0, status: BUCKET_STATUS_FRESH, expirySlot: 1_000n }]);
    // Chain slot behind, engine ahead: the program WOULD accept, so we must too.
    // Missing this means a bricked domain stays bricked.
    expect(findExpirableBuckets(buckets, 500n, 2_000n)).toHaveLength(1);
    // Engine behind, chain ahead: also accepted.
    expect(findExpirableBuckets(buckets, 2_000n, 500n)).toHaveLength(1);
    // Both behind: not yet due — sending would waste a fee on a Stale revert.
    expect(findExpirableBuckets(buckets, 500n, 900n)).toHaveLength(0);
  });

  it("finds nothing on a market with no backing activity (never cranks blind)", () => {
    const data = buildMarketAccount({ assetSlots: 2, maxMarketSlots: 2 });
    const buckets = readBackingBuckets(data, readMarketGroupState(data));
    expect(findExpirableBuckets(buckets, 10_000_000n, 10_000_000n)).toHaveLength(0);
  });
});

describe("findLapsingSoonBuckets — leading indicator for cadence", () => {
  it("flags Fresh buckets inside the horizon but not the already-lapsed ones", () => {
    const data = buildMarketAccount({
      assetSlots: 2, maxMarketSlots: 2,
      buckets: [
        { domain: 0, status: BUCKET_STATUS_FRESH, expirySlot: 900n },   // already lapsed
        { domain: 1, status: BUCKET_STATUS_FRESH, expirySlot: 1_500n }, // within horizon
        { domain: 2, status: BUCKET_STATUS_FRESH, expirySlot: 9_000n }, // beyond horizon
      ],
    });
    const buckets = readBackingBuckets(data, readMarketGroupState(data));
    const soon = findLapsingSoonBuckets(buckets, 1_000n, 0n, 1_000n);
    expect(soon.map((b) => b.domain)).toEqual([1]);
  });
});

describe("primitive readers", () => {
  it("round-trips u64 and u128 little-endian", () => {
    const data = new Uint8Array(64);
    writeU64LE(data, 0, 0xdead_beef_cafe_baben);
    writeU128LE(data, 16, (1n << 127n) - 1n);
    expect(readU64LE(data, 0)).toBe(0xdead_beef_cafe_baben);
    expect(readU128LE(data, 16)).toBe((1n << 127n) - 1n);
  });

  it("throws rather than returning garbage when out of bounds", () => {
    const data = new Uint8Array(8);
    expect(() => readU64LE(data, 4)).toThrow(/out of bounds/i);
    expect(() => readU128LE(data, 0)).toThrow(/out of bounds/i);
  });
});

describe("bucket layout constant", () => {
  it("BACKING_BUCKET_LEN matches the engine struct", () => {
    expect(BACKING_BUCKET_LEN).toBe(97);
    expect(BUCKET_STATUS_OFF).toBe(96);
    expect(BUCKET_EXPIRY_SLOT_OFF).toBe(88);
  });
});

// ─── Cross-implementation check against the SDK's own parser ──────────────────
// The strongest verification available without a live market: the SDK parses
// the same market-group header independently (its own offset table, written by
// a different author for a different purpose). If bytes written at MY offsets
// read back correctly through ITS parser, both derivations agree — and this
// module's readers are not merely self-consistent.

describe("cross-check: bytes written at our offsets parse correctly via the SDK", () => {
  it("SDK parseMarketGroupV17OI reads the insurance balance we wrote", async () => {
    const { parseMarketGroupV17OI, isV17MarketAccount, V17_MAGIC, V17_KIND_OFF, V17_KIND_MARKET } =
      await import("@percolatorct/sdk");

    const data = buildMarketAccount({ assetSlots: 2, maxMarketSlots: 2, insurance: 424_242n });

    // Stamp the v17 account header so the SDK accepts the buffer: magic u64 LE
    // at 0, version at 8, kind at V17_KIND_OFF.
    writeU64LE(data, 0, V17_MAGIC);
    data[8] = 17;
    data[V17_KIND_OFF] = V17_KIND_MARKET;
    expect(isV17MarketAccount(data)).toBe(true);

    const oi = parseMarketGroupV17OI(data);
    expect(oi.insuranceBalance).toBe(424_242n);
  });

  it("SDK reads per-asset OI written at our engine-asset-slot offsets", async () => {
    const { parseMarketGroupV17OI, V17_MAGIC, V17_KIND_OFF, V17_KIND_MARKET } =
      await import("@percolatorct/sdk");
    const { engineAssetSlotOff, ASSET_OI_EFF_LONG_Q_OFF, ASSET_OI_EFF_SHORT_Q_OFF } =
      await import("../../src/lib/v17-layout.js");

    const data = buildMarketAccount({ assetSlots: 2, maxMarketSlots: 2 });
    writeU64LE(data, 0, V17_MAGIC);
    data[8] = 17;
    data[V17_KIND_OFF] = V17_KIND_MARKET;

    // Asset 1's short OI is the most offset-sensitive field available: it needs
    // the market-group offset, the header length, a full asset stride and the
    // wrapper prefix to all be right simultaneously.
    writeU128LE(data, engineAssetSlotOff(0) + ASSET_OI_EFF_LONG_Q_OFF, 111n);
    writeU128LE(data, engineAssetSlotOff(1) + ASSET_OI_EFF_SHORT_Q_OFF, 999n);

    const oi = parseMarketGroupV17OI(data);
    expect(oi.totalLongOiQ).toBe(111n);
    expect(oi.totalShortOiQ).toBe(999n);
    expect(oi.assets).toEqual([
      { assetIndex: 0, oiEffLongQ: 111n, oiEffShortQ: 0n },
      { assetIndex: 1, oiEffLongQ: 0n, oiEffShortQ: 999n },
    ]);
  });
});
