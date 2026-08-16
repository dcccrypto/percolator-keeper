/**
 * v17 fee-split + backing-bucket-recovery crank.
 *
 * ══ WHAT THIS SERVICE IS FOR ═════════════════════════════════════════════════
 *
 * The v17 fee split routes every trade fee four ways, and the backing engine
 * parks counterparty capital in per-domain buckets. Both mechanisms accrue into
 * pots that only a permissionless crank can empty, and until this service
 * existed nothing cranked them:
 *
 *   tag 89  ExpireBackingBucket             — lapsed bucket recovery  (LIVENESS)
 *   tag 78  LpVaultCrankFees                — LP fee leg              (REVENUE)
 *   tag 87  WithdrawInsuranceReserveToStake — staker fee leg          (REVENUE)
 *   tag 84  WithdrawProtocolFee             — protocol fee leg        (REVENUE)
 *
 * Tag 89 is the one that is not optional. The other three leak revenue if they
 * never run; tag 89 STRANDS USER FUNDS. See `describeBucketExpiryUrgency()`.
 *
 * ══ WHY ONE LOOP AND NOT FOUR ════════════════════════════════════════════════
 *
 * All four cranks have the same shape: read some counter out of the market
 * account, compare it to a threshold, send one instruction if it clears. They
 * differ only in which counter, which threshold, which accounts, and which
 * mode gate. Four separate loops would mean four copies of the
 * failure-isolation, rejection-classification, metrics and backoff logic —
 * four places for them to drift apart, and four independent account fetches of
 * the same market per cycle.
 *
 * So there is one `CrankLeg` description per tag and one driver
 * (`runFeeCrankCycle`) that fetches each market ONCE and evaluates every leg
 * against that single snapshot.
 *
 * ══ NEVER CRANK BLIND ════════════════════════════════════════════════════════
 *
 * Every leg's `detect()` reads on-chain state and returns `null` when there is
 * nothing to do. A transaction is only ever built for a leg that reported
 * pending work. This is a correction to the previous `crankLpVault()` in
 * `crank.ts`, which fired tag 78 at every market every cycle and classified the
 * resulting failure as "no fees to crank" — burning SOL on a guaranteed-revert
 * transaction each time, and swallowing genuine faults (authority mismatch,
 * zero LP shares, wrong mode) under the same debug line.
 *
 * ══ FAILURE ISOLATION ════════════════════════════════════════════════════════
 *
 * Isolation is per (market, leg), not per market: a market whose LP leg throws
 * still gets its tag-89 bucket sweep in the same cycle. Every leg body is
 * wrapped, results are collected via `Promise.allSettled`, and no leg can
 * abort the cycle for any other market or any other leg.
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import {
  buildIx,
  decodeStakePool,
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  deriveStakePool,
  getStakeProgramId,
  deriveCanonicalVault,
  deriveVaultAuthority,
  encodeExpireBackingBucket,
  encodeLpVaultCrankFees,
  encodeWithdrawInsuranceReserveToStake,
  encodeWithdrawProtocolFee,
  parseLpVaultRegistry,
  parseWrapperConfigV17,
} from "@percolatorct/sdk";
import { createLogger } from "@percolatorct/shared";
import { isMainnet } from "../config/network.js";
import { keeperSend, sharedBudget } from "../lib/keeper-send.js";
import { sharedTxQueue } from "../lib/tx-queue.js";
import {
  engineAvailableAtoms,
  findExpirableBuckets,
  findLapsingSoonBuckets,
  isBucketExpiryEligible,
  isLiveOnlyLegEligible,
  isProtocolFeeLegEligible,
  readBackingBuckets,
  readFeeLegClaims,
  readMarketGroupState,
  V17_MARKET_GROUP_MIN_LEN,
  type V17BackingBucket,
  type V17MarketGroupState,
} from "../lib/v17-fee-state.js";
import {
  feeCrankLegAttemptsTotal,
  feeCrankLegBenignRejectsTotal,
  feeCrankLegErrorsTotal,
  feeCrankLegSkippedTotal,
  feeCrankAtomsMovedTotal,
  feeCrankPendingClaimAtoms,
  feeCrankBucketsExpiredTotal,
  feeCrankBucketsLapsedGauge,
  feeCrankBucketsLapsingSoonGauge,
} from "../lib/metrics.js";

const logger = createLogger("keeper:fee-crank");

// ─── Tunables ─────────────────────────────────────────────────────────────────

/**
 * A sweep must be worth more than it costs to send. Base fee is 5,000 lamports
 * and priority fees push a realistic landed cost toward ~50k lamports; at that
 * price a sweep of a few hundred atoms is strictly value-destroying.
 *
 * Thresholds are in COLLATERAL ATOMS, so the right value depends on the
 * collateral mint's decimals. The defaults assume a 6-decimal stablecoin
 * (1 atom = 1e-6 units), making the default protocol threshold 1.0 token.
 */
function envBigint(name: string, fallback: bigint): bigint {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  try {
    const parsed = BigInt(raw);
    if (parsed < 0n) {
      logger.warn("negative fee-crank threshold ignored, using default", {
        name,
        raw,
        fallback: fallback.toString(),
      });
      return fallback;
    }
    return parsed;
  } catch {
    logger.warn("unparseable fee-crank threshold, using default", {
      name,
      raw,
      fallback: fallback.toString(),
    });
    return fallback;
  }
}

export interface FeeCrankThresholds {
  /** Tag 84 — the leg the brief explicitly requires be threshold-gated. */
  protocolAtoms: bigint;
  /** Tag 78. */
  lpAtoms: bigint;
  /** Tag 87. */
  insuranceReserveAtoms: bigint;
  /**
   * Tag 89 has NO economic threshold — see `describeBucketExpiryUrgency()`.
   * This is only the observability horizon for the "lapsing soon" gauge.
   */
  bucketLapseWarnHorizonSlots: bigint;
}

export function loadFeeCrankThresholds(): FeeCrankThresholds {
  return {
    protocolAtoms: envBigint("KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS", 1_000_000n),
    lpAtoms: envBigint("KEEPER_LP_FEE_CRANK_MIN_ATOMS", 100_000n),
    insuranceReserveAtoms: envBigint("KEEPER_STAKE_FEE_SWEEP_MIN_ATOMS", 100_000n),
    bucketLapseWarnHorizonSlots: envBigint("KEEPER_BUCKET_LAPSE_WARN_SLOTS", 5_000n),
  };
}

// ─── By-design rejections vs. real errors ─────────────────────────────────────

/**
 * Custom program error codes this crank expects to see and must NOT alarm on.
 *
 * Detection reads a snapshot; the chain moves. A leg can be genuinely pending
 * when we look and genuinely satisfied by the time the transaction lands —
 * another keeper cranked it, the market resolved, a bucket got expired by
 * someone else. Those are races the design anticipates, not faults.
 *
 * Treating them as errors would be actively harmful: a permissionless crank
 * that pages on "someone else did the work first" trains operators to ignore
 * its alerts, and the one time the alert is real it gets ignored too.
 */
export const BENIGN_PROGRAM_ERRORS: ReadonlyMap<number, string> = new Map([
  [
    19,
    "EngineStale — bucket/domain ledger not current (tag 89 raced, or bucket not yet lapsed)",
  ],
  [
    21,
    "EngineLockActive — market mode gate (tags 78/87/89 are Live-only; 84 needs Live or wound-down Resolved)",
  ],
  [27, "mode gate — market not in an eligible mode for this leg"],
  [38, "LpVaultNoFeesToCrank — LP leg already drained (tag 78)"],
  [41, "LpVaultZeroSharesMinted — no LP shares outstanding to claim the fees (tag 78)"],
  [53, "no insurance reserve available (tag 87)"],
  [61, "backing bucket not Fresh-and-lapsed — already expired or not yet due (tag 89)"],
]);

/** Extract a Solana `Custom(N)` / `custom program error: 0xN` code, if present. */
export function extractCustomErrorCode(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const decimal = /Custom(?:\s*[:(]\s*|\s+)(\d+)/i.exec(msg);
  if (decimal?.[1] !== undefined) return Number.parseInt(decimal[1], 10);
  const hex = /custom program error:\s*0x([0-9a-f]+)/i.exec(msg);
  if (hex?.[1] !== undefined) return Number.parseInt(hex[1], 16);
  return null;
}

export interface RejectionClassification {
  benign: boolean;
  code: number | null;
  reason: string;
}

/**
 * Classify a send failure as a by-design rejection (log at debug) or a real
 * error (log at warn and count toward the error metric).
 *
 * Deliberately conservative: only a RECOGNISED custom code is benign. An
 * unrecognised custom code, an RPC failure, a signature error or a thrown
 * exception all classify as real. The previous LP-vault crank did the
 * opposite — any message containing "Custom" was written off as "no fees to
 * crank" — which meant a market misconfigured badly enough to reject every
 * crank looked identical to a market with nothing to do.
 */
export function classifyRejection(err: unknown): RejectionClassification {
  const code = extractCustomErrorCode(err);
  if (code === null) {
    return {
      benign: false,
      code: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const benignReason = BENIGN_PROGRAM_ERRORS.get(code);
  if (benignReason !== undefined) {
    return { benign: true, code, reason: benignReason };
  }
  return { benign: false, code, reason: `unexpected program error Custom(${code})` };
}

// ─── Leg model ────────────────────────────────────────────────────────────────

export type LegName = "expireBackingBucket" | "lpVaultCrankFees" | "insuranceReserveToStake" | "protocolFee";

/** One unit of pending work discovered by a leg's detector. */
export interface PendingWork {
  /** Human-readable reason, for the log line and the runbook. */
  reason: string;
  /**
   * Atoms this send is expected to move, when the leg moves atoms.
   * `null` for tag 89, which moves no tokens at all — it only advances a
   * bucket's status so settlement can proceed.
   */
  expectedAtoms: bigint | null;
  /** Instructions to send as one transaction. */
  instructions: TransactionInstruction[];
  /** Extra structured detail for logs/metrics (e.g. the domain for tag 89). */
  detail?: Record<string, string | number>;
}

export interface MarketSnapshot {
  address: PublicKey;
  programId: PublicKey;
  data: Uint8Array;
  group: V17MarketGroupState;
  chainSlot: bigint;
}

export interface LegContext {
  connection: Connection;
  keypair: Keypair;
  thresholds: FeeCrankThresholds;
}

export interface CrankLeg {
  name: LegName;
  tag: number;
  /**
   * Read state and return every unit of work that should be sent right now.
   * MUST return an empty array when there is nothing to do — the driver never
   * sends speculatively.
   */
  detect(snapshot: MarketSnapshot, ctx: LegContext): Promise<PendingWork[]>;
}

// ─── Tag 89: ExpireBackingBucket ──────────────────────────────────────────────

/**
 * Why tag 89 has no economic threshold and runs on every cycle.
 *
 * A backing bucket's `expiry_slot` is fixed when the bucket opens and is never
 * extended while it stays `Fresh`. EVERY backed market therefore lapses — a
 * longer horizon defers the lapse, it does not avoid it. This is routine
 * maintenance, not an edge case.
 *
 * Once lapsed, the domain is a dead end in all three directions, permanently:
 *   - settling a LOSS against it    -> EngineLockActive (Custom 21)
 *   - settling a GAIN against it    -> EngineStale      (Custom 19)
 *   - TopUpBackingBucket to re-fund -> EngineLockActive (Custom 21)
 * It cannot even be paid to come back. Tag 89 is the only exit, and it is
 * permissionless precisely so that any keeper can perform the repair.
 *
 * So the "threshold" for tag 89 is simply: the bucket is Fresh and lapsed.
 * Skipping it to save a transaction fee would be trading a few thousand
 * lamports against user funds that cannot be recovered by any other means.
 */
export function describeBucketExpiryUrgency(): string {
  return (
    "tag 89 is liveness-critical: a lapsed bucket permanently bricks its domain " +
    "(loss->Custom21, gain->Custom19, top-up->Custom21) and tag 89 is the only exit"
  );
}

export const expireBackingBucketLeg: CrankLeg = {
  name: "expireBackingBucket",
  tag: 89,
  async detect(snapshot, ctx) {
    const { group, data, address, programId, chainSlot } = snapshot;

    if (!isBucketExpiryEligible(group)) {
      // Live-only. On a Resolved market the engine's own resolved-close sweep
      // reaches the same transition, so there is nothing for us to repair.
      return [];
    }

    const buckets = readBackingBuckets(data, group);
    const expirable = findExpirableBuckets(buckets, chainSlot, group.currentSlot);
    const lapsingSoon = findLapsingSoonBuckets(
      buckets,
      chainSlot,
      group.currentSlot,
      ctx.thresholds.bucketLapseWarnHorizonSlots,
    );

    const marketLabel = address.toBase58().slice(0, 8);
    feeCrankBucketsLapsedGauge.set({ market: marketLabel }, expirable.length);
    feeCrankBucketsLapsingSoonGauge.set({ market: marketLabel }, lapsingSoon.length);

    if (lapsingSoon.length > 0) {
      logger.info("backing buckets approaching lapse", {
        market: marketLabel,
        count: lapsingSoon.length,
        horizonSlots: ctx.thresholds.bucketLapseWarnHorizonSlots.toString(),
        domains: lapsingSoon.map((b) => b.domain).join(","),
      });
    }

    // One instruction per domain, sent as separate transactions so that a
    // domain the program refuses cannot block the others in the same market.
    return expirable.map((bucket) => buildExpireBucketWork(programId, address, bucket));
  },
};

function buildExpireBucketWork(
  programId: PublicKey,
  market: PublicKey,
  bucket: V17BackingBucket,
): PendingWork {
  const data = encodeExpireBackingBucket({ domain: bucket.domain });
  const ix = buildIx({
    programId,
    // handle_expire_backing_bucket takes exactly one account: the market,
    // writable, owned by the program. No signer beyond the fee payer, no
    // token accounts — it moves no tokens.
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data,
  });
  return {
    reason:
      `backing bucket domain ${bucket.domain} (asset ${bucket.assetIndex} ${bucket.side}) ` +
      `is Fresh and lapsed at slot ${bucket.expirySlot}`,
    // Tag 89 moves NO tokens. It forfeits the lapsed principal to the junior
    // pool as the engine's documented expiry semantics — the alternative being
    // that the account never settles at all.
    expectedAtoms: null,
    instructions: [ix],
    detail: {
      domain: bucket.domain,
      assetIndex: bucket.assetIndex,
      side: bucket.side,
      expirySlot: bucket.expirySlot.toString(),
      freshUnliened: bucket.freshUnlienedBackingNum.toString(),
      validLiened: bucket.validLienedBackingNum.toString(),
    },
  };
}

// ─── Tag 78: LpVaultCrankFees ─────────────────────────────────────────────────

export const lpVaultCrankFeesLeg: CrankLeg = {
  name: "lpVaultCrankFees",
  tag: 78,
  async detect(snapshot, ctx) {
    const { group, data, address, programId } = snapshot;

    // Live-only by design (stricter than tag 84): this crank CONVERTS senior
    // insurance into a junior LP claim that must still be paid out later, so
    // "safe to drain now" does not transfer to Resolved/Recovery.
    if (!isLiveOnlyLegEligible(group)) return [];

    const claims = readFeeLegClaims(data);
    feeCrankPendingClaimAtoms.set(
      { market: address.toBase58().slice(0, 8), leg: "lp" },
      Number(claims.lp),
    );
    if (claims.lp < ctx.thresholds.lpAtoms) return [];

    // The vault registry must exist AND still hold real shares. The program
    // rejects with LpVaultZeroSharesMinted (41) when outstanding shares are at
    // or below the dead-share floor, because crediting principal that no share
    // can claim strands the atoms. Check it here so we don't pay for a revert.
    const [registryPda] = deriveLpVaultRegistry(programId, address);
    const registryInfo = await ctx.connection.getAccountInfo(registryPda);
    if (registryInfo === null) return [];

    let domainIdx: number;
    let sharesOutstanding: bigint;
    try {
      const registry = parseLpVaultRegistry(new Uint8Array(registryInfo.data));
      domainIdx = Number(registry.domain);
      sharesOutstanding = BigInt(registry.totalLpSharesOutstanding);
    } catch (err) {
      logger.debug("LP vault registry unparseable, skipping tag 78", {
        market: address.toBase58().slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    if (sharesOutstanding <= LP_VAULT_MINIMUM_LIQUIDITY) {
      logger.debug("LP vault has no real shares outstanding, skipping tag 78", {
        market: address.toBase58().slice(0, 8),
        sharesOutstanding: sharesOutstanding.toString(),
      });
      return [];
    }

    // v17 dual-domain: the vault can hold backing in EITHER pot of its asset,
    // so tag 78 now names the pot the fees land in and needs both ledgers. We
    // credit the registry's own domain — fees become backing there, and a
    // rebalance (tag 91) can move them if the house needs the other pot.
    // The sibling ledger may not exist yet; the program creates the target
    // ledger on first use, which is why the cranker must be writable (it pays
    // the rent) and the system program is required.
    const [ledgerPda] = deriveLpBackingLedger(programId, address, domainIdx);
    const [siblingLedgerPda] = deriveLpBackingLedger(programId, address, domainIdx ^ 1);
    const ix = buildIx({
      programId,
      keys: [
        { pubkey: ctx.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: ledgerPda, isSigner: false, isWritable: true },
        { pubkey: siblingLedgerPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: encodeLpVaultCrankFees({ domain: domainIdx }),
    });

    return [
      {
        reason: `LP fee leg has ${claims.lp} atoms outstanding`,
        expectedAtoms: claims.lp,
        instructions: [ix],
        detail: { domain: domainIdx, sharesOutstanding: sharesOutstanding.toString() },
      },
    ];
  },
};

/**
 * `LP_VAULT_MINIMUM_LIQUIDITY` — the irreducible dead-share floor that is never
 * minted and never redeemable. The program compares
 * `total_lp_shares_outstanding <= LP_VAULT_MINIMUM_LIQUIDITY` and rejects.
 *
 * ⚠ Mirrored from `percolator-prog` `constants::LP_VAULT_MINIMUM_LIQUIDITY`
 * because the SDK does not export it. If the SDK gains an export, import it
 * instead of this literal. Being wrong here is benign in one direction only:
 * too LOW and we pay for an occasional revert that classifies as benign
 * Custom(41); too HIGH and we silently skip legitimate LP fee cranks.
 */
const LP_VAULT_MINIMUM_LIQUIDITY = 1_000n;

// ─── Tag 87: WithdrawInsuranceReserveToStake ──────────────────────────────────

export const insuranceReserveToStakeLeg: CrankLeg = {
  name: "insuranceReserveToStake",
  tag: 87,
  async detect(snapshot, ctx) {
    const { group, data, address, programId } = snapshot;

    // Live-only, and deliberately stricter than tag 84 — this leg carries no
    // authority signature at all, so allowing it in a terminal state would
    // hand a permissionless drain to anyone. See the runbook warning below.
    if (!isLiveOnlyLegEligible(group)) return [];

    const claims = readFeeLegClaims(data);
    feeCrankPendingClaimAtoms.set(
      { market: address.toBase58().slice(0, 8), leg: "insuranceReserve" },
      Number(claims.insuranceReserve),
    );
    if (claims.insuranceReserve < ctx.thresholds.insuranceReserveAtoms) return [];

    // Destination is derived, never caller-chosen: the pool at
    // ["stake_pool", market] under the pinned stake program, and `pool.vault`
    // out of that pool's own bytes. We re-derive it here only to know whether
    // the market has a bound pool at all — an unbound market can never satisfy
    // this instruction and sending would be a guaranteed revert.
    // Pass the stake program EXPLICITLY. deriveStakePool falls back to
    // getStakeProgramId() when no programId is given, and that resolver refuses to
    // guess an ambiguous network rather than defaulting — the keeper runs with
    // NETWORK unset in local/devnet operation, so the bare form throws. The throw
    // is swallowed by the leg's try/catch below, which would silently degrade tag 87
    // (WithdrawInsuranceReserveToStake) to status:"error" every cycle and stall an
    // insurance-reserve -> stake money movement behind a log line.
    const stakeProgramId = getStakeProgramId(isMainnet() ? "mainnet" : "devnet");
    const [stakePoolPda] = deriveStakePool(address, stakeProgramId);
    const poolInfo = await ctx.connection.getAccountInfo(stakePoolPda);
    if (poolInfo === null) {
      logger.debug("no stake pool bound to market, skipping tag 87", {
        market: address.toBase58().slice(0, 8),
      });
      return [];
    }

    let stakeVault: PublicKey;
    try {
      stakeVault = decodeStakePool(new Uint8Array(poolInfo.data)).vault;
    } catch (err) {
      logger.debug("stake pool unparseable, skipping tag 87", {
        market: address.toBase58().slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const cfg = parseWrapperConfigV17(data);
    const [vaultAuthority] = deriveVaultAuthority(programId, address);
    const marketVaultToken = resolveMarketVaultToken(programId, address, cfg);

    const ix = buildIx({
      programId,
      keys: [
        { pubkey: ctx.keypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: stakePoolPda, isSigner: false, isWritable: false },
        { pubkey: stakeVault, isSigner: false, isWritable: true },
        { pubkey: marketVaultToken, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encodeWithdrawInsuranceReserveToStake(),
    });

    return [
      {
        reason: `staker fee leg has ${claims.insuranceReserve} atoms outstanding`,
        expectedAtoms: claims.insuranceReserve,
        instructions: [ix],
        detail: { stakePool: stakePoolPda.toBase58().slice(0, 8) },
      },
    ];
  },
};

// ─── Tag 84: WithdrawProtocolFee ──────────────────────────────────────────────

export const protocolFeeLeg: CrankLeg = {
  name: "protocolFee",
  tag: 84,
  async detect(snapshot, ctx) {
    const { group, data, address, programId } = snapshot;

    // Live OR fully-wound-down Resolved. Wider than tags 78/87 because tag 84
    // is signer-gated AND is the protocol claim's only exit (W12).
    if (!isProtocolFeeLegEligible(group)) return [];

    const cfg = parseWrapperConfigV17(data);

    // NOT permissionless: requires the protocol fee authority's signature.
    // If this keeper does not hold that key, there is nothing to do — sending
    // would revert with Unauthorized, which is NOT in the benign set and would
    // (correctly) alarm every cycle.
    if (!cfg.protocolFeeAuthority.equals(ctx.keypair.publicKey)) {
      return [];
    }

    const claims = readFeeLegClaims(data);
    feeCrankPendingClaimAtoms.set(
      { market: address.toBase58().slice(0, 8), leg: "protocol" },
      Number(claims.protocol),
    );

    // Threshold-gated so a sweep is never net-negative against transaction cost.
    if (claims.protocol < ctx.thresholds.protocolAtoms) return [];

    const destination = resolveProtocolFeeDestination();
    if (destination === null) {
      logger.warn(
        "protocol fee sweep pending but KEEPER_PROTOCOL_FEE_DESTINATION is unset — skipping",
        { market: address.toBase58().slice(0, 8), pendingAtoms: claims.protocol.toString() },
      );
      return [];
    }

    const marketVaultToken = resolveMarketVaultToken(programId, address, cfg);
    const [vaultAuthority] = deriveVaultAuthority(programId, address);

    const ix = buildIx({
      programId,
      keys: [
        { pubkey: ctx.keypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: marketVaultToken, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      // amount 0 = "withdraw all currently-available capacity". The program
      // clamps to what is actually available and marks only the ACTUALLY
      // transferred amount as withdrawn, so a partial fill leaves the
      // remainder claimable next cycle rather than marking it paid.
      data: encodeWithdrawProtocolFee({ amount: 0n }),
    });

    return [
      {
        reason: `protocol fee leg has ${claims.protocol} atoms outstanding (threshold ${ctx.thresholds.protocolAtoms})`,
        expectedAtoms: claims.protocol,
        instructions: [ix],
        detail: { destination: destination.toBase58().slice(0, 8) },
      },
    ];
  },
};

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function resolveProtocolFeeDestination(): PublicKey | null {
  const raw = (process.env.KEEPER_PROTOCOL_FEE_DESTINATION ?? "").trim();
  if (raw === "") return null;
  try {
    return new PublicKey(raw);
  } catch {
    logger.warn("KEEPER_PROTOCOL_FEE_DESTINATION is not a valid pubkey", { raw });
    return null;
  }
}

/**
 * The market's collateral vault token account — DERIVED, per market.
 *
 * The v17 wrapper config does not store the vault token pubkey; the program
 * computes it (`canonical_vault_address`, v16_program.rs) as the Associated
 * Token Account of the market's `["vault", market]` authority PDA for the
 * collateral mint, and pins the market to that single address (F-VAULT-FRAG) in
 * `verify_withdrawable_token_accounts`. `deriveCanonicalVault` (SDK >= 4.2.0)
 * reproduces that derivation seed-for-seed, so we derive it here rather than
 * being told it.
 *
 * There is no Token-2022 branch to handle: `verify_token_program` rejects any
 * token program that is not `spl_token::ID`, and `unpack_token_account` rejects
 * any token account not OWNED by `spl_token::ID`, so the ATA's middle seed is
 * always legacy SPL Token. The SDK pins the same constant.
 *
 * PREVIOUSLY this read a single global `KEEPER_MARKET_VAULT_TOKEN` env var and
 * returned null when unset. That was wrong in two ways, both observed on the
 * first real v17 market:
 *   1. Unset (the default) silently disabled BOTH revenue legs — tags 84 and 87
 *      no-opped forever while fees accrued, with only a debug line.
 *   2. Set, it is a per-PROCESS constant standing in for a per-MARKET address.
 *      With more than one market it would send some other market's vault, which
 *      the F-VAULT-FRAG pin rejects as InvalidVaultAccount (12) — a guaranteed
 *      revert on every market but one.
 */
function resolveMarketVaultToken(
  programId: PublicKey,
  market: PublicKey,
  cfg: ReturnType<typeof parseWrapperConfigV17>,
): PublicKey {
  const [vaultToken] = deriveCanonicalVault(programId, market, cfg.collateralMint);
  return vaultToken;
}

// ─── The driver ───────────────────────────────────────────────────────────────

export const ALL_LEGS: readonly CrankLeg[] = [
  // Liveness first: a bricked domain is worse than an unswept fee pot, and if
  // the cycle is going to run out of budget it should run out on revenue, not
  // on user funds.
  expireBackingBucketLeg,
  lpVaultCrankFeesLeg,
  insuranceReserveToStakeLeg,
  protocolFeeLeg,
];

export interface LegOutcome {
  market: string;
  leg: LegName;
  tag: number;
  status: "sent" | "benign-reject" | "error" | "idle";
  signature?: string;
  atomsMoved?: bigint;
  reason?: string;
}

/**
 * Evaluate every leg against one market snapshot and send whatever is pending.
 *
 * Each (market, leg) is isolated: a throw anywhere inside a leg is caught,
 * classified, counted and logged, and the next leg still runs.
 */
export async function runLegsForMarket(
  snapshot: MarketSnapshot,
  ctx: LegContext,
  legs: readonly CrankLeg[] = ALL_LEGS,
): Promise<LegOutcome[]> {
  const marketLabel = snapshot.address.toBase58().slice(0, 8);
  const outcomes: LegOutcome[] = [];

  for (const leg of legs) {
    let pending: PendingWork[];
    try {
      pending = await leg.detect(snapshot, ctx);
    } catch (err) {
      // A detector that throws must not take down the other legs. This is a
      // real error — detection reads local bytes and derives PDAs, so a throw
      // here means a layout or RPC problem worth surfacing.
      feeCrankLegErrorsTotal.inc({ leg: leg.name, phase: "detect" });
      logger.warn("fee-crank leg detection failed", {
        market: marketLabel,
        leg: leg.name,
        tag: leg.tag,
        error: err instanceof Error ? err.message : String(err),
      });
      outcomes.push({
        market: marketLabel,
        leg: leg.name,
        tag: leg.tag,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (pending.length === 0) {
      feeCrankLegSkippedTotal.inc({ leg: leg.name });
      outcomes.push({ market: marketLabel, leg: leg.name, tag: leg.tag, status: "idle" });
      continue;
    }

    for (const work of pending) {
      outcomes.push(await sendPendingWork(snapshot, ctx, leg, work, marketLabel));
    }
  }

  return outcomes;
}

async function sendPendingWork(
  snapshot: MarketSnapshot,
  ctx: LegContext,
  leg: CrankLeg,
  work: PendingWork,
  marketLabel: string,
): Promise<LegOutcome> {
  feeCrankLegAttemptsTotal.inc({ leg: leg.name });
  logger.info("fee-crank leg has pending work", {
    market: marketLabel,
    leg: leg.name,
    tag: leg.tag,
    reason: work.reason,
    expectedAtoms: work.expectedAtoms?.toString() ?? "n/a (moves no tokens)",
    ...work.detail,
  });

  try {
    // Reuses the repo's existing send hardening: budget gating, priority-fee
    // estimation, retry/backoff and the shared queue from the recovery-cranker
    // work. maxRetries=2 — these cranks are idempotent-ish (a re-send after the
    // work is done reverts benignly), so a couple of retries is cheap, but they
    // are not urgent enough to justify aggressive rebroadcast.
    const result = await sharedTxQueue.enqueue("crank", () =>
      keeperSend(ctx.connection, work.instructions, [ctx.keypair], "crank", sharedBudget, 2, {
        // Preflight is worth paying for here: it is exactly what turns a
        // by-design rejection into a cheap simulated error instead of a landed
        // failed transaction we paid fees for.
        skipPreflight: false,
        multiRpcBroadcast: false,
        simulateForCU: true,
      }),
    );

    if (result === null) {
      // Budget gate declined the send — not an error, just deferred.
      feeCrankLegSkippedTotal.inc({ leg: leg.name });
      logger.debug("fee-crank leg deferred by budget gate", {
        market: marketLabel,
        leg: leg.name,
      });
      return { market: marketLabel, leg: leg.name, tag: leg.tag, status: "idle" };
    }

    if (work.expectedAtoms !== null) {
      feeCrankAtomsMovedTotal.inc({ leg: leg.name, market: marketLabel }, Number(work.expectedAtoms));
    }
    if (leg.tag === 89) {
      feeCrankBucketsExpiredTotal.inc({ market: marketLabel });
    }

    logger.info("fee-crank leg sent", {
      market: marketLabel,
      leg: leg.name,
      tag: leg.tag,
      signature: result.signature,
      // "Expected" rather than "moved": the program clamps every fee leg to the
      // shared available pool, so a partial fill is normal and the remainder
      // stays claimable next cycle. Confirming the actual delta needs a
      // post-send re-read, which the runbook does rather than the hot path.
      expectedAtoms: work.expectedAtoms?.toString() ?? "0",
      engineAvailableAtoms: engineAvailableAtoms(snapshot.group).toString(),
      ...work.detail,
    });

    return {
      market: marketLabel,
      leg: leg.name,
      tag: leg.tag,
      status: "sent",
      signature: result.signature,
      ...(work.expectedAtoms !== null ? { atomsMoved: work.expectedAtoms } : {}),
    };
  } catch (err) {
    const classification = classifyRejection(err);
    if (classification.benign) {
      feeCrankLegBenignRejectsTotal.inc({
        leg: leg.name,
        code: String(classification.code),
      });
      logger.debug("fee-crank leg rejected by design", {
        market: marketLabel,
        leg: leg.name,
        tag: leg.tag,
        code: classification.code,
        reason: classification.reason,
      });
      return {
        market: marketLabel,
        leg: leg.name,
        tag: leg.tag,
        status: "benign-reject",
        reason: classification.reason,
      };
    }

    feeCrankLegErrorsTotal.inc({ leg: leg.name, phase: "send" });
    logger.warn("fee-crank leg failed", {
      market: marketLabel,
      leg: leg.name,
      tag: leg.tag,
      code: classification.code,
      error: classification.reason.slice(0, 200),
    });
    return {
      market: marketLabel,
      leg: leg.name,
      tag: leg.tag,
      status: "error",
      reason: classification.reason,
    };
  }
}

/**
 * Is the fee crank allowed to run?
 *
 * OFF unless explicitly enabled. This service moves real value (three of its
 * four legs sweep collateral) and tag 89 forfeits lapsed principal to the
 * junior pool as the engine's documented expiry semantics. Neither should
 * begin the moment a keeper build ships; an operator turns it on deliberately,
 * after the runbook checks. Defaulting to on would also mean the very first
 * deploy of this code starts sweeping every market it can discover.
 */
export function isFeeCrankEnabled(): boolean {
  return (process.env.KEEPER_FEE_CRANK_ENABLED ?? "").trim() === "true";
}

/**
 * Fetch the given markets, build snapshots and run one full cycle.
 *
 * Fetches in one `getMultipleAccountsInfo` batch rather than per leg: all four
 * legs read the same account, so the single-snapshot-per-market design costs
 * one RPC round trip for the whole cycle instead of four per market.
 */
export async function runFeeCrankPass(
  connection: Connection,
  keypair: Keypair,
  markets: readonly { address: PublicKey; programId: PublicKey }[],
  thresholds: FeeCrankThresholds = loadFeeCrankThresholds(),
): Promise<LegOutcome[]> {
  if (markets.length === 0) return [];

  let chainSlot: bigint;
  let infos: (Awaited<ReturnType<Connection["getAccountInfo"]>>)[];
  try {
    [chainSlot, infos] = await Promise.all([
      connection.getSlot().then((s) => BigInt(s)),
      connection.getMultipleAccountsInfo(markets.map((m) => m.address)),
    ]);
  } catch (err) {
    // A failed fetch is not a per-market failure — nothing was evaluated, so
    // there is nothing to isolate. Report once and let the next cycle retry.
    logger.warn("fee-crank pass could not load market accounts", {
      markets: markets.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const snapshots: MarketSnapshot[] = [];
  for (const [i, market] of markets.entries()) {
    const info = infos[i];
    if (!info) continue;
    const snapshot = buildSnapshot(
      market.address,
      market.programId,
      new Uint8Array(info.data),
      chainSlot,
    );
    if (snapshot !== null) snapshots.push(snapshot);
  }

  return runFeeCrankCycle(snapshots, { connection, keypair, thresholds });
}

/**
 * Build a snapshot from raw account bytes. Returns null when the account is not
 * a usable v17 market (too short to contain the market group header), which the
 * caller should treat as "skip", not "fail".
 */
export function buildSnapshot(
  address: PublicKey,
  programId: PublicKey,
  data: Uint8Array,
  chainSlot: bigint,
): MarketSnapshot | null {
  if (data.length < V17_MARKET_GROUP_MIN_LEN) return null;
  try {
    return { address, programId, data, group: readMarketGroupState(data), chainSlot };
  } catch {
    return null;
  }
}

/**
 * One full cycle across many markets.
 *
 * Markets run concurrently but each market's legs run in sequence, so a single
 * market never has four transactions in flight competing for the same account
 * lock. `Promise.allSettled` guarantees one market's failure cannot abort the
 * cycle for any other.
 */
export async function runFeeCrankCycle(
  snapshots: readonly MarketSnapshot[],
  ctx: LegContext,
  legs: readonly CrankLeg[] = ALL_LEGS,
): Promise<LegOutcome[]> {
  const settled = await Promise.allSettled(
    snapshots.map((snapshot) => runLegsForMarket(snapshot, ctx, legs)),
  );

  const outcomes: LegOutcome[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      outcomes.push(...result.value);
      continue;
    }
    // runLegsForMarket already isolates per leg, so reaching here means
    // something outside the per-leg try/catch failed. Still isolated per market.
    const label = snapshots[index]?.address.toBase58().slice(0, 8) ?? "unknown";
    feeCrankLegErrorsTotal.inc({ leg: "cycle", phase: "market" });
    logger.warn("fee-crank market cycle failed", {
      market: label,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  }

  const sent = outcomes.filter((o) => o.status === "sent").length;
  const benign = outcomes.filter((o) => o.status === "benign-reject").length;
  const errored = outcomes.filter((o) => o.status === "error").length;
  logger.info("fee-crank cycle complete", {
    markets: snapshots.length,
    sent,
    benignRejects: benign,
    errors: errored,
  });

  return outcomes;
}
