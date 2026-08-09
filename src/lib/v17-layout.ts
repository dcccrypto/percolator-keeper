/**
 * v17 account layout — the ONE place the keeper learns where things live.
 *
 * ══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════════
 *
 * `v17-risk.ts` hardcoded `V17_WRAPPER_CONFIG_LEN = 432`. That constant has been
 * wrong for two generations of the wrapper:
 *
 *     432  →  496   (protocol-fee program change: +protocol_fee_authority,
 *                    +protocol_fee_accrued_atoms, +protocol_fee_withdrawn_atoms)
 *     496  →  576   (fee-collection split: +4×u128 fee counters, +3×u16 shares,
 *                    +10B explicit padding)
 *
 * Because `WrapperConfigV16` sits between the 16-byte account header and the
 * market-group header, EVERY derived offset past it moves when it grows. At 432
 * the keeper was reading the market-group header 144 bytes too early — so
 * `maintenance_margin_bps`, `h_min`, `h_max`, `liquidation_fee_bps` and
 * `min_nonzero_mm_req` were all being read out of the middle of the wrapper
 * config's oracle-leg arrays. The keeper is misreading live market accounts
 * today, entirely independent of the fee-split work.
 *
 * The fix is not "change 432 to 576" — that is how we got here. The fix is that
 * the keeper stops owning this number at all. `@percolatorct/sdk` derives it
 * from the program's own `WRAPPER_CONFIG_LEN`, which the program pins with a
 * compile-time `assert!(size_of::<WrapperConfigV16>() == WRAPPER_CONFIG_LEN)`
 * (v16_program.rs). The indexer already imports these constants
 * (`percolator-indexer/src/v17/discovery.ts`); this module converges the keeper
 * onto the same source of truth.
 *
 * ══ THE TRIPWIRE ═════════════════════════════════════════════════════════════
 *
 * Importing from the SDK is necessary but NOT sufficient: an SDK pinned to a
 * stale commit exports a stale constant, and the keeper would go on misreading
 * accounts just as silently as it does now. `assertV17LayoutGeneration()` below
 * refuses to start against an SDK whose layout generation does not match the
 * deployed wrapper. A wrong offset must be a loud startup crash, never a quiet
 * misread. See its doc comment for why the expected value is written down here
 * even though the offsets are not.
 *
 * ══ SUB-STRUCT OFFSETS ═══════════════════════════════════════════════════════
 *
 * The SDK exports the OUTER layout (header → wrapper config → market group →
 * asset slots) but not the engine sub-struct field offsets, so those are
 * derived here from the engine's `#[repr(C)]` struct definitions
 * (`percolator/src/v16.rs`). Every `V16PodU*` field is an align-1 `[u8; N]`
 * byte array and every struct derives `bytemuck::Pod` (which forbids implicit
 * padding), so field offsets are the running sum of field sizes with no
 * alignment gaps anywhere.
 *
 * Each derived block below ends with a total that is asserted against an
 * INDEPENDENTLY-SOURCED length (the SDK's `V17_MARKET_GROUP_LEN` /
 * `V17_MARKET_ASSET_SLOT_LEN`). That is a real check, not decoration: it is how
 * the offsets in this file were verified in the first place, and it is what
 * would have caught the 432 bug. If a struct gains a field upstream, the sum
 * stops matching and `assertV17LayoutGeneration()` throws at boot.
 */

import {
  V17_HEADER_LEN,
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";

// ─── Re-exports: SDK is the source of truth, this module is the front door ────
// Callers import from here rather than reaching into the SDK directly, so that
// the tripwire below is unavoidable and there is exactly one import site to
// audit when the layout moves again.

export {
  V17_HEADER_LEN,
  V17_WRAPPER_CONFIG_LEN,
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
};

/**
 * Expected `WRAPPER_CONFIG_LEN` for the currently-deployed wrapper
 * `DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj`
 * (sha256 6b2fda2363352aba0ef88abde0d398f9dd477b1208507e7e8393586ed5458931).
 *
 * ⚠ THIS IS A TRIPWIRE, NOT A DATA SOURCE. Nothing in this file — or anywhere
 * else in the keeper — computes an offset from this number. It exists only so
 * that a keeper running against an SDK from the wrong generation FAILS TO BOOT
 * instead of silently reading the wrong bytes. That distinction is the whole
 * lesson of the 432 bug: the old code used its stale constant as an offset
 * source, so being wrong was invisible.
 *
 * When the wrapper's config legitimately grows again, this bumps in the same
 * commit that repins the SDK, and the mismatch until then is the point.
 */
export const V17_EXPECTED_WRAPPER_CONFIG_LEN = 576;

// ─── MarketGroupV16HeaderAccount ──────────────────────────────────────────────
// Offsets are RELATIVE to V17_MARKET_GROUP_OFF. Derived from
// `percolator/src/v16.rs` `MarketGroupV16HeaderAccount`.

/** `market_group_id: [u8; 32]` */
export const MG_MARKET_GROUP_ID_OFF = 0;
export const MG_MARKET_GROUP_ID_LEN = 32;

/** `config: V16ConfigAccount` — see the V16_CFG_* offsets below. */
export const MG_CONFIG_OFF = MG_MARKET_GROUP_ID_OFF + MG_MARKET_GROUP_ID_LEN; // 32

// V16ConfigAccount field offsets, relative to MG_CONFIG_OFF.
export const V16_CFG_MAX_PORTFOLIO_ASSETS_OFF = 0; // u16
export const V16_CFG_MAX_MARKET_SLOTS_OFF = 2; // u32
export const V16_CFG_MIN_NONZERO_MM_REQ_OFF = 6; // u128
export const V16_CFG_MIN_NONZERO_IM_REQ_OFF = 22; // u128
export const V16_CFG_H_MIN_OFF = 38; // u64
export const V16_CFG_H_MAX_OFF = 46; // u64
export const V16_CFG_MAINTENANCE_MARGIN_BPS_OFF = 54; // u64
export const V16_CFG_INITIAL_MARGIN_BPS_OFF = 62; // u64
export const V16_CFG_MAX_TRADING_FEE_BPS_OFF = 70; // u64
export const V16_CFG_LIQUIDATION_FEE_BPS_OFF = 78; // u64
/**
 * `V16ConfigAccount` total size. Continues past liquidation_fee_bps with
 * liquidation_fee_cap(16) + min_liquidation_abs(16) + 8×u64(64) +
 * public_b_chunk_atoms(16) + 5×u64(40) + 11×u8(11) = 249.
 */
export const V16_CFG_LEN = 249;

export const MG_ASSET_SLOT_CAPACITY_OFF = MG_CONFIG_OFF + V16_CFG_LEN; // 281, u32
export const MG_VAULT_OFF = MG_ASSET_SLOT_CAPACITY_OFF + 4; // 285, u128
export const MG_INSURANCE_OFF = MG_VAULT_OFF + 16; // 301, u128
export const MG_C_TOT_OFF = MG_INSURANCE_OFF + 16; // 317, u128

// Seven u128 aggregates sit between c_tot and the two clamp operands:
// pnl_pos_tot(333) pnl_pos_bound_tot_num(349) pnl_pos_bound_tot(365)
// pnl_matured_pos_tot(381) backing_provider_earnings_total(397)
// source_claim_bound_total_num(413) source_fresh_backing_total_num(429).

// The two clamp operands every fee-withdraw leg (tags 78/84/87) draws against.
// All three legs share one pool:
//   insurance − source_insurance_credit_reserved_total_atoms
//             − insurance_domain_budget_remaining_total
// and each clamps its own claim to it, so a leg can partial-fill.
export const MG_SOURCE_INSURANCE_CREDIT_RESERVED_ATOMS_OFF = 445; // u128
export const MG_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL_OFF = 461; // u128

export const MG_RESOLVED_PAYOUT_BLOCKER_COUNT_OFF = 477; // u64
export const MG_STRESS_CONSUMPTION_OFF = 485; // u128
export const MG_STRESS_ENVELOPE_START_SLOT_OFF = 501; // u64
export const MG_STRESS_ENVELOPE_START_CREDIT_EPOCH_OFF = 509; // u64
export const MG_MATERIALIZED_PORTFOLIO_COUNT_OFF = 517; // u64
// stale_certificate_count(525) b_stale_account_count(533)
// negative_pnl_account_count(541) risk_epoch(549) asset_set_epoch(557)
// asset_activation_count(565) last_asset_activation_slot(573)
// next_market_id(581) oracle_epoch(589) funding_epoch(597) slot_last(605)
export const MG_CURRENT_SLOT_OFF = 613; // u64
// bankruptcy_hlock_active(621) threshold_stress_active(622) loss_stale_active(623)
// recovery_reason: V16OptionalRecoveryReasonAccount { present: u8, value: u8 } (624..626)
/** `mode`: 0 = Live, 1 = Resolved, 2 = Recovery. */
export const MG_MODE_OFF = 626; // u8
// resolved_slot(627) payout_snapshot(635) payout_snapshot_pnl_pos_tot(651)
// payout_snapshot_captured(667)
// resolved_payout_ledger: ResolvedPayoutLedgerV16Account = 5×u128 + u64 + 2×u8 = 90
export const MG_RESOLVED_PAYOUT_LEDGER_OFF = 668;
export const MG_RESOLVED_PAYOUT_LEDGER_LEN = 90;

/** Independently-derived total, asserted against the SDK's V17_MARKET_GROUP_LEN. */
export const MG_DERIVED_LEN = MG_RESOLVED_PAYOUT_LEDGER_OFF + MG_RESOLVED_PAYOUT_LEDGER_LEN; // 758

// ─── Per-asset slot ───────────────────────────────────────────────────────────
// Each asset slot in the market account is a 512-byte wrapper oracle-wrapper
// prefix followed by the engine's EngineAssetSlotV16Account.

/** Wrapper-side oracle prefix that precedes each `EngineAssetSlotV16Account`. */
export const ASSET_SLOT_WRAPPER_PREFIX_LEN = 512;

// AssetStateV16Account field offsets (relative to the engine asset slot start).
export const ASSET_MARKET_ID_OFF = 0; // u64
export const ASSET_RETIRED_SLOT_OFF = 8; // u64
export const ASSET_LIFECYCLE_OFF = 16; // u8
export const ASSET_RAW_ORACLE_TARGET_PRICE_OFF = 17; // u64
export const ASSET_EFFECTIVE_PRICE_OFF = 25; // u64
export const ASSET_FUND_PX_LAST_OFF = 33; // u64
export const ASSET_SLOT_LAST_OFF = 41; // u64
// a_long(49) a_short(65) k_long(81) k_short(97) f_long_num(113) f_short_num(129)
// k_epoch_start_long(145) k_epoch_start_short(161) f_epoch_start_long_num(177)
// f_epoch_start_short_num(193) b_long_num(209) b_short_num(225)
// b_epoch_start_long_num(241) b_epoch_start_short_num(257)
export const ASSET_OI_EFF_LONG_Q_OFF = 273; // u128
export const ASSET_OI_EFF_SHORT_Q_OFF = 289; // u128
// stored_pos_count_long(305) .. pending_obligation_count_short(345)
// loss_weight_sum_*(353,369) social_loss_remainder_*(385,401)
// social_loss_dust_*(417,433) explicit_unallocated_loss_*(449,465)
// epoch_long(481) epoch_short(489) mode_long(497) mode_short(498)
/** `AssetStateV16Account` total size. */
export const ASSET_STATE_LEN = 499;

// EngineAssetSlotV16Account field offsets (relative to the engine asset slot start).
export const SLOT_ASSET_OFF = 0;
export const SLOT_INSURANCE_DOMAIN_BUDGET_LONG_OFF = ASSET_STATE_LEN; // 499, u128
export const SLOT_INSURANCE_DOMAIN_BUDGET_SHORT_OFF = 515; // u128
export const SLOT_INSURANCE_DOMAIN_SPENT_LONG_OFF = 531; // u128
export const SLOT_INSURANCE_DOMAIN_SPENT_SHORT_OFF = 547; // u128
export const SLOT_PENDING_DOMAIN_LOSS_BARRIER_LONG_OFF = 563; // u64
export const SLOT_PENDING_DOMAIN_LOSS_BARRIER_SHORT_OFF = 571; // u64
/** `SourceCreditStateV16Account` = 11×u128 + u64 = 184. */
export const SOURCE_CREDIT_LEN = 184;
export const SLOT_SOURCE_CREDIT_LONG_OFF = 579;
export const SLOT_SOURCE_CREDIT_SHORT_OFF = SLOT_SOURCE_CREDIT_LONG_OFF + SOURCE_CREDIT_LEN; // 763

/**
 * `BackingBucketV16Account` = market_id(u64) + 5×u128 + expiry_slot(u64) +
 * status(u8) = 8 + 80 + 8 + 1 = 97.
 */
export const BACKING_BUCKET_LEN = 97;
export const SLOT_BACKING_LONG_OFF = SLOT_SOURCE_CREDIT_SHORT_OFF + SOURCE_CREDIT_LEN; // 947
export const SLOT_BACKING_SHORT_OFF = SLOT_BACKING_LONG_OFF + BACKING_BUCKET_LEN; // 1044

/** `InsuranceCreditReservationV16Account` = 4×u128 + u64 = 72. */
export const INSURANCE_RESERVATION_LEN = 72;
export const SLOT_INSURANCE_RESERVATION_LONG_OFF = SLOT_BACKING_SHORT_OFF + BACKING_BUCKET_LEN; // 1141
export const SLOT_INSURANCE_RESERVATION_SHORT_OFF =
  SLOT_INSURANCE_RESERVATION_LONG_OFF + INSURANCE_RESERVATION_LEN; // 1213

/** Independently-derived `EngineAssetSlotV16Account` size. */
export const ENGINE_ASSET_SLOT_DERIVED_LEN =
  SLOT_INSURANCE_RESERVATION_SHORT_OFF + INSURANCE_RESERVATION_LEN; // 1285

/** Independently-derived per-asset stride within the market account. */
export const ASSET_SLOT_DERIVED_STRIDE =
  ASSET_SLOT_WRAPPER_PREFIX_LEN + ENGINE_ASSET_SLOT_DERIVED_LEN; // 1797

// BackingBucketV16Account field offsets (relative to the bucket start).
export const BUCKET_MARKET_ID_OFF = 0; // u64
export const BUCKET_FRESH_UNLIENED_OFF = 8; // u128
export const BUCKET_VALID_LIENED_OFF = 24; // u128
export const BUCKET_CONSUMED_LIENED_OFF = 40; // u128
export const BUCKET_IMPAIRED_LIENED_OFF = 56; // u128
export const BUCKET_UTILIZATION_FEE_EARNINGS_OFF = 72; // u128
export const BUCKET_EXPIRY_SLOT_OFF = 88; // u64
export const BUCKET_STATUS_OFF = 96; // u8

/**
 * `BackingBucketStatusV16` discriminants, from `encode_backing_bucket_status`
 * (percolator/src/v16.rs).
 */
export const BUCKET_STATUS_EMPTY = 0;
export const BUCKET_STATUS_FRESH = 1;
export const BUCKET_STATUS_EXPIRED = 2;
export const BUCKET_STATUS_IMPAIRED = 3;

/** Market group `mode` discriminants. */
export const MARKET_MODE_LIVE = 0;
export const MARKET_MODE_RESOLVED = 1;
export const MARKET_MODE_RECOVERY = 2;

// ─── Derived absolute offsets ─────────────────────────────────────────────────

/** Absolute byte offset of the first asset slot in the market account. */
export const V17_ASSET_SLOTS_BASE_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;

/** Absolute byte offset of a market-group header field. */
export function marketGroupFieldOff(relativeOff: number): number {
  return V17_MARKET_GROUP_OFF + relativeOff;
}

/** Absolute byte offset of a `V16ConfigAccount` field. */
export function engineConfigFieldOff(relativeOff: number): number {
  return V17_MARKET_GROUP_OFF + MG_CONFIG_OFF + relativeOff;
}

/** Absolute byte offset of the `EngineAssetSlotV16Account` for `assetIndex`. */
export function engineAssetSlotOff(assetIndex: number): number {
  return (
    V17_ASSET_SLOTS_BASE_OFF +
    assetIndex * V17_MARKET_ASSET_SLOT_LEN +
    ASSET_SLOT_WRAPPER_PREFIX_LEN
  );
}

/**
 * Absolute byte offset of a backing bucket, addressed by DOMAIN index.
 *
 * The engine's `domain_asset_side` (v16.rs) maps domain → (asset, side) as
 * `asset_index = domain / 2` and `side = domain % 2 == 0 ? Long : Short`.
 * Tag 89 takes a domain, not an (asset, side) pair, so the keeper must speak
 * the same dialect or it will expire the wrong bucket.
 */
export function backingBucketOff(domain: number): number {
  const assetIndex = Math.floor(domain / 2);
  const sideOff = domain % 2 === 0 ? SLOT_BACKING_LONG_OFF : SLOT_BACKING_SHORT_OFF;
  return engineAssetSlotOff(assetIndex) + sideOff;
}

/**
 * Boot tripwire. Throws unless the SDK's layout matches the deployed wrapper
 * generation AND this module's independently-derived struct sizes agree with
 * the SDK's.
 *
 * Called from boot assertions so a stale/mismatched SDK is a startup crash.
 * The keeper reads market accounts by raw byte offset; there is no checksum,
 * no discriminator and no error return on a wrong-offset read — it just gets
 * plausible-looking garbage. Failing closed at boot is the only place this is
 * catchable.
 */
export function assertV17LayoutGeneration(): void {
  const problems: string[] = [];

  if (V17_WRAPPER_CONFIG_LEN !== V17_EXPECTED_WRAPPER_CONFIG_LEN) {
    problems.push(
      `@percolatorct/sdk exports V17_WRAPPER_CONFIG_LEN=${V17_WRAPPER_CONFIG_LEN} but the ` +
        `deployed wrapper uses ${V17_EXPECTED_WRAPPER_CONFIG_LEN}. The SDK pin is from the ` +
        `wrong generation (432 = pre-protocol-fee, 496 = pre-fee-split, 576 = current). ` +
        `Every offset past the wrapper config would be wrong by ` +
        `${V17_EXPECTED_WRAPPER_CONFIG_LEN - V17_WRAPPER_CONFIG_LEN} bytes.`,
    );
  }

  if (MG_DERIVED_LEN !== V17_MARKET_GROUP_LEN) {
    problems.push(
      `MarketGroupV16HeaderAccount field offsets sum to ${MG_DERIVED_LEN} but the SDK reports ` +
        `V17_MARKET_GROUP_LEN=${V17_MARKET_GROUP_LEN}. A field was added/removed/resized upstream ` +
        `and the offsets in v17-layout.ts are stale.`,
    );
  }

  if (ASSET_SLOT_DERIVED_STRIDE !== V17_MARKET_ASSET_SLOT_LEN) {
    problems.push(
      `EngineAssetSlotV16Account field offsets sum to a stride of ${ASSET_SLOT_DERIVED_STRIDE} ` +
        `but the SDK reports V17_MARKET_ASSET_SLOT_LEN=${V17_MARKET_ASSET_SLOT_LEN}. ` +
        `Per-asset reads (prices, backing buckets) would be misaligned.`,
    );
  }

  if (V17_MARKET_GROUP_OFF !== V17_HEADER_LEN + V17_WRAPPER_CONFIG_LEN) {
    problems.push(
      `SDK V17_MARKET_GROUP_OFF=${V17_MARKET_GROUP_OFF} != V17_HEADER_LEN(${V17_HEADER_LEN}) + ` +
        `V17_WRAPPER_CONFIG_LEN(${V17_WRAPPER_CONFIG_LEN}). The SDK's own constants disagree.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `v17 layout mismatch — refusing to start rather than misread market accounts:\n  - ` +
        problems.join("\n  - "),
    );
  }
}
