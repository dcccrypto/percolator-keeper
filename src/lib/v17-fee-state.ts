/**
 * Pure readers over a v17 market account's raw bytes, for the fee/recovery cranks.
 *
 * Everything here is a total function from `Uint8Array` to plain data — no RPC,
 * no clock, no keypairs. That is deliberate: the decision "is there anything to
 * do on this market?" is the part that must be right, and it is the part that is
 * cheapest to test exhaustively if it never touches the network. The crank
 * service composes these; it does not re-derive any offset itself.
 *
 * All offsets come from `v17-layout.ts`, which derives them from the SDK. See
 * that file for why the keeper no longer hardcodes any of this.
 */

import { parseWrapperConfigV17 } from "@percolatorct/sdk";
import {
  BACKING_BUCKET_LEN,
  BUCKET_EXPIRY_SLOT_OFF,
  BUCKET_FRESH_UNLIENED_OFF,
  BUCKET_IMPAIRED_LIENED_OFF,
  BUCKET_STATUS_FRESH,
  BUCKET_STATUS_OFF,
  BUCKET_VALID_LIENED_OFF,
  MARKET_MODE_LIVE,
  MG_C_TOT_OFF,
  MG_CURRENT_SLOT_OFF,
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
} from "./v17-layout.js";

// ─── Primitive little-endian readers ──────────────────────────────────────────

export function readU8(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 1 > data.length) {
    throw new RangeError(`readU8 out of bounds at ${offset} (len ${data.length})`);
  }
  return data[offset]!;
}

export function readU32LE(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) {
    throw new RangeError(`readU32LE out of bounds at ${offset} (len ${data.length})`);
  }
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  ) >>> 0;
}

export function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > data.length) {
    throw new RangeError(`readU64LE out of bounds at ${offset} (len ${data.length})`);
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

// ─── Market group header ──────────────────────────────────────────────────────

/**
 * Minimum bytes needed before any market-group field read is in bounds.
 * Callers should check this once and skip the market rather than let individual
 * reads throw.
 */
export const V17_MARKET_GROUP_MIN_LEN = V17_ASSET_SLOTS_BASE_OFF;

export interface V17MarketGroupState {
  /** 0 = Live, 1 = Resolved, 2 = Recovery. */
  mode: number;
  /** The engine's own advancing slot counter (`header.current_slot`). */
  currentSlot: bigint;
  insurance: bigint;
  cTot: bigint;
  materializedPortfolioCount: bigint;
  sourceInsuranceCreditReservedTotalAtoms: bigint;
  insuranceDomainBudgetRemainingTotal: bigint;
  /** `config.max_market_slots` — domain count is exactly 2× this. */
  maxMarketSlots: number;
  /** Asset slots physically present in the account, from its length. */
  assetSlotCount: number;
}

export function readMarketGroupState(data: Uint8Array): V17MarketGroupState {
  if (data.length < V17_MARKET_GROUP_MIN_LEN) {
    throw new RangeError(
      `readMarketGroupState: account too short — need >= ${V17_MARKET_GROUP_MIN_LEN} bytes, got ${data.length}`,
    );
  }
  return {
    mode: readU8(data, marketGroupFieldOff(MG_MODE_OFF)),
    currentSlot: readU64LE(data, marketGroupFieldOff(MG_CURRENT_SLOT_OFF)),
    insurance: readU128LE(data, marketGroupFieldOff(MG_INSURANCE_OFF)),
    cTot: readU128LE(data, marketGroupFieldOff(MG_C_TOT_OFF)),
    materializedPortfolioCount: readU64LE(
      data,
      marketGroupFieldOff(MG_MATERIALIZED_PORTFOLIO_COUNT_OFF),
    ),
    sourceInsuranceCreditReservedTotalAtoms: readU128LE(
      data,
      marketGroupFieldOff(MG_SOURCE_INSURANCE_CREDIT_RESERVED_ATOMS_OFF),
    ),
    insuranceDomainBudgetRemainingTotal: readU128LE(
      data,
      marketGroupFieldOff(MG_INSURANCE_DOMAIN_BUDGET_REMAINING_TOTAL_OFF),
    ),
    maxMarketSlots: readU32LE(data, engineConfigFieldOff(V16_CFG_MAX_MARKET_SLOTS_OFF)),
    assetSlotCount: Math.floor(
      (data.length - V17_ASSET_SLOTS_BASE_OFF) / V17_MARKET_ASSET_SLOT_LEN,
    ),
  };
}

/**
 * The shared withdrawable pool that tags 78, 84 and 87 all clamp against
 * (`handle_withdraw_protocol_fee`'s §1.3/N2 clamp and its two mirrors):
 *
 *     insurance − source_insurance_credit_reserved_total_atoms
 *               − insurance_domain_budget_remaining_total
 *
 * Saturating, exactly as the program does it. A leg whose wrapper-side claim
 * exceeds this does not fail — it partial-fills and leaves the remainder
 * claimable — so the keeper uses this to report expected vs. actual movement
 * rather than to gate the send.
 */
export function engineAvailableAtoms(group: V17MarketGroupState): bigint {
  const afterReserved =
    group.insurance > group.sourceInsuranceCreditReservedTotalAtoms
      ? group.insurance - group.sourceInsuranceCreditReservedTotalAtoms
      : 0n;
  return afterReserved > group.insuranceDomainBudgetRemainingTotal
    ? afterReserved - group.insuranceDomainBudgetRemainingTotal
    : 0n;
}

// ─── Fee legs ─────────────────────────────────────────────────────────────────

export type FeeLeg = "lp" | "insuranceReserve" | "protocol";

export interface V17FeeLegClaims {
  /** Tag 78 `LpVaultCrankFees`. */
  lp: bigint;
  /** Tag 87 `WithdrawInsuranceReserveToStake`. */
  insuranceReserve: bigint;
  /** Tag 84 `WithdrawProtocolFee`. */
  protocol: bigint;
}

/**
 * Outstanding (accrued − withdrawn) claim per fee leg, read from the wrapper
 * config's fee-split tail. These counters are what make "is there anything to
 * do?" answerable WITHOUT sending a transaction — the whole reason the crank
 * does not fire blindly.
 *
 * Each counter pair is monotonic with withdrawn <= accrued (enforced program
 * side), but this subtracts saturatingly anyway: a negative claim from a
 * misread would otherwise become an enormous unsigned number and look like a
 * huge pending sweep.
 */
export function readFeeLegClaims(data: Uint8Array): V17FeeLegClaims {
  const cfg = parseWrapperConfigV17(data);
  const sat = (accrued: bigint, withdrawn: bigint): bigint =>
    accrued > withdrawn ? accrued - withdrawn : 0n;
  return {
    lp: sat(cfg.lpFeeAccruedAtoms, cfg.lpFeeWithdrawnAtoms),
    insuranceReserve: sat(
      cfg.insuranceReserveAccruedAtoms,
      cfg.insuranceReserveWithdrawnAtoms,
    ),
    protocol: sat(cfg.protocolFeeAccruedAtoms, cfg.protocolFeeWithdrawnAtoms),
  };
}

// ─── Backing buckets (tag 89) ─────────────────────────────────────────────────

export interface V17BackingBucket {
  /** Engine domain index. `asset = domain / 2`, `side = domain % 2` (0 long). */
  domain: number;
  assetIndex: number;
  side: "long" | "short";
  status: number;
  expirySlot: bigint;
  freshUnlienedBackingNum: bigint;
  validLienedBackingNum: bigint;
  impairedLienedBackingNum: bigint;
}

/**
 * Read every configured backing bucket.
 *
 * Domain count is `config.max_market_slots × 2` (the program's own bound in
 * `handle_expire_backing_bucket`), but the account only physically contains
 * `assetSlotCount` slots — a market can be configured for more slots than its
 * account was sized for. Iterating on the configured count alone would read
 * past the buffer; iterating on the physical count alone could address a domain
 * the program rejects as `InvalidInstruction`. So this takes the min.
 */
export function readBackingBuckets(
  data: Uint8Array,
  group: V17MarketGroupState,
): V17BackingBucket[] {
  const configuredAssets = group.maxMarketSlots;
  const assetCount = Math.min(configuredAssets, group.assetSlotCount);
  const buckets: V17BackingBucket[] = [];

  for (let assetIndex = 0; assetIndex < assetCount; assetIndex++) {
    for (const side of [0, 1] as const) {
      const domain = assetIndex * 2 + side;
      const base = backingBucketOff(domain);
      if (base + BACKING_BUCKET_LEN > data.length) continue;
      buckets.push({
        domain,
        assetIndex,
        side: side === 0 ? "long" : "short",
        status: readU8(data, base + BUCKET_STATUS_OFF),
        expirySlot: readU64LE(data, base + BUCKET_EXPIRY_SLOT_OFF),
        freshUnlienedBackingNum: readU128LE(data, base + BUCKET_FRESH_UNLIENED_OFF),
        validLienedBackingNum: readU128LE(data, base + BUCKET_VALID_LIENED_OFF),
        impairedLienedBackingNum: readU128LE(data, base + BUCKET_IMPAIRED_LIENED_OFF),
      });
    }
  }
  return buckets;
}

/**
 * Buckets that tag 89 `ExpireBackingBucket` would accept right now.
 *
 * The engine's `expire_source_backing_bucket_not_atomic` accepts exactly
 * `status == Fresh && now_slot >= expiry_slot`, and rejects everything else
 * with `Stale`. `now_slot` is
 * `max(Clock::get().slot, header.current_slot)` — never caller-supplied — so a
 * bucket is expirable iff EITHER clock reaches the expiry or the engine's own
 * counter already has.
 *
 * Using the max here (rather than just the chain slot) matters in the direction
 * that costs money: `header.current_slot` can legitimately run AHEAD of the
 * chain slot the keeper last observed, and a bucket that the program would
 * accept but the keeper skips is a domain that stays bricked. It cannot produce
 * a false positive, because the program recomputes the same max itself and a
 * caller cannot lower it.
 *
 * WHY THIS IS ROUTINE, NOT AN EDGE CASE. A bucket's `expiry_slot` is fixed when
 * the bucket opens and is NEVER extended while it stays `Fresh`
 * (`fresh_counterparty_backing_expiry_slot` returns the stored value unchanged
 * on a live bucket). Every backed market therefore lapses eventually — a longer
 * horizon defers the lapse, it does not avoid it. Once lapsed the domain is a
 * dead end in all three directions: settling a gain returns `EngineStale`
 * (Custom 19), reserving a further loss returns `EngineLockActive` (Custom 21),
 * and `TopUpBackingBucket` to re-fund it returns 21 as well — it cannot even be
 * paid to come back. Tag 89 is the only exit.
 */
export function findExpirableBuckets(
  buckets: readonly V17BackingBucket[],
  chainSlot: bigint,
  engineCurrentSlot: bigint,
): V17BackingBucket[] {
  const nowSlot = chainSlot > engineCurrentSlot ? chainSlot : engineCurrentSlot;
  return buckets.filter(
    (b) => b.status === BUCKET_STATUS_FRESH && nowSlot >= b.expirySlot,
  );
}

/**
 * Buckets that are `Fresh` and will lapse within `horizonSlots`. Purely
 * observational — surfaced as a metric so an operator can see the lapse coming
 * and size the crank cadence, rather than discovering it when an account fails
 * to settle.
 */
export function findLapsingSoonBuckets(
  buckets: readonly V17BackingBucket[],
  chainSlot: bigint,
  engineCurrentSlot: bigint,
  horizonSlots: bigint,
): V17BackingBucket[] {
  const nowSlot = chainSlot > engineCurrentSlot ? chainSlot : engineCurrentSlot;
  return buckets.filter(
    (b) =>
      b.status === BUCKET_STATUS_FRESH &&
      b.expirySlot > nowSlot &&
      b.expirySlot - nowSlot <= horizonSlots,
  );
}

// ─── Mode gates ───────────────────────────────────────────────────────────────

/**
 * Tags 78 and 87 are Live-only by design, and additionally refuse on a
 * "matured Live" market (one past its permissionless-resolve horizon, via
 * `reject_permissionless_resolve_matured_live_view`). The keeper cannot cheaply
 * evaluate the matured-Live predicate off-chain, so it gates on mode only and
 * treats the program's rejection of a matured market as a by-design outcome.
 */
export function isLiveOnlyLegEligible(group: V17MarketGroupState): boolean {
  return group.mode === MARKET_MODE_LIVE;
}

/**
 * Tag 84 is Live OR fully-wound-down Resolved — `handle_withdraw_protocol_fee`
 * permits Resolved only when `materialized_portfolio_count == 0 && c_tot == 0`.
 * W12: `ResolveMarket` is one-way and tag 84 is the protocol claim's ONLY exit,
 * which is why it gets the wider gate that tag 87 deliberately does not.
 */
export function isProtocolFeeLegEligible(group: V17MarketGroupState): boolean {
  if (group.mode === MARKET_MODE_LIVE) return true;
  if (group.mode !== 1) return false;
  return group.materializedPortfolioCount === 0n && group.cTot === 0n;
}

/**
 * Tag 89 is Live-only: a resolved/wound-down market already reaches the same
 * transition through the engine's own resolved-close sweep
 * (`realize_source_backed_claims_for_resolved_close_not_atomic`), so
 * re-entering it from outside would be a second unsequenced mutation of a
 * terminal ledger. The program returns `EngineLockActive` (Custom 21) otherwise.
 */
export function isBucketExpiryEligible(group: V17MarketGroupState): boolean {
  return group.mode === MARKET_MODE_LIVE;
}
