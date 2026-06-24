import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram } from "@solana/web3.js";
import type { Connection, TransactionInstruction, Keypair } from "@solana/web3.js";
import { sendWithRetryKeeper, createLogger, sendCriticalAlert } from "@percolatorct/shared";
import type { KeeperSendOptions } from "@percolatorct/shared";
import { KeeperBudget } from "./budget.js";
import { budgetHalted } from "./metrics.js";
import type { TxType, TxResult } from "./budget.js";
import { HeliusPriorityFeeEstimator } from "./priority-fee.js";
import type { PriorityFeeEstimator, PriorityFeeTier } from "./priority-fee.js";
import { CuEstimator } from "./cu-estimator.js";
import { sharedDecisionLog } from "./decision-log.js";
import { isMainnetNetwork } from "../network.js";

const logger = createLogger("keeper:send");

// Single-writer guard. In HA mode the keeper must only land on-chain txs while it
// holds leadership; the on-chain programs are permissionless, so this host-local
// gate is the actual barrier against a demoted node double-sending. Wired from
// index.ts to read the live LeaderLock role. Defaults to always-leader so the
// standalone (no-HA) path is unchanged.
let _isLeader: () => boolean = () => true;

/**
 * Wire the leadership check into keeperSend. Call once at startup with a
 * function that returns true iff this node currently holds the HA leader lock
 * (or always-true for standalone/no-HA deployments).
 */
export function setLeaderCheck(fn: () => boolean): void {
  _isLeader = fn;
}

export const BASE_FEE_LAMPORTS = 5_000;

const TIER_MAP: Record<TxType, PriorityFeeTier> = {
  crank: "crank",
  liquidation: "liquidation",
  oracle: "oracle",
  adl: "adl",
};

/**
 * Pure lamport-cost formula, factored out so property tests can exercise it
 * without the fetch/simulate stubs around the public keeperSend API.
 *
 * Cost = base + ceil(microLamports * cu / 1_000_000) + jitoTip + extraLamports.
 * extraLamports is used when the tx must fund a new account (rent); pass 0 (default)
 * for normal sends.
 */
export function estimateLamportCost(
  microLamports: number,
  cu: number,
  jitoTip: number,
  extraLamports = 0,
): number {
  const priorityFee = Math.ceil((microLamports * cu) / 1_000_000);
  return BASE_FEE_LAMPORTS + priorityFee + jitoTip + extraLamports;
}

// Lazy singletons — instantiated on first use so mocks applied in test setup take effect.
let _priorityFeeEstimator: PriorityFeeEstimator | null = null;
let _cuEstimator: CuEstimator | null = null;

function getPriorityFeeEstimator(): PriorityFeeEstimator {
  if (!_priorityFeeEstimator) _priorityFeeEstimator = new HeliusPriorityFeeEstimator();
  return _priorityFeeEstimator;
}

function getCuEstimator(): CuEstimator {
  if (!_cuEstimator) _cuEstimator = new CuEstimator();
  return _cuEstimator;
}

/**
 * Process-wide budget circuit breaker. Wired with observability so a halt is
 * never silent: onHalt sets the keeper_budget_halted gauge and pages on-call;
 * onResume clears the gauge. Recovery from a latched halt is via the
 * authenticated POST /admin/budget/resume endpoint (see index.ts).
 */
export const sharedBudget = new KeeperBudget(
  {},
  {
    onHalt: (kind, reason) => {
      budgetHalted.set(1);
      logger.error("KeeperBudget circuit-breaker halted — refusing all sends until resume", {
        kind,
        reason,
      });
      // Page on-call. The budget wraps this hook in try/catch, so an alerting
      // failure can never break the send path. Promise.resolve guards against
      // a non-thenable return.
      Promise.resolve(
        sendCriticalAlert("Keeper budget circuit-breaker tripped — sends halted", [
          { name: "Kind", value: kind, inline: true },
          { name: "Reason", value: reason.slice(0, 200), inline: false },
          {
            name: "Recovery",
            value: "Investigate the cause, then POST /admin/budget/resume (x-shared-secret).",
            inline: false,
          },
        ]),
      ).catch(() => {});
    },
    onResume: () => budgetHalted.set(0),
  },
);

function isMainnetSender(): boolean {
  return (
    isMainnetNetwork(process.env.NETWORK) &&
    process.env.USE_HELIUS_SENDER === "true"
  );
}

function firstProgramInstruction(instructions: TransactionInstruction[]): TransactionInstruction | undefined {
  return instructions.find((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
}

interface EstimateCostResult {
  estimatedCost: number;
  simulatedCu: number;
  /** H-3: true iff simulation proved this exact tx would fail on-chain. */
  provenToFail: boolean;
  simError?: unknown;
}

/**
 * Estimate total lamport cost of a transaction.
 * priority_fee_microlamports * CU / 1_000_000 + base_fee + jito_tip + extraLamports.
 * Also returns the raw simulated CU so callers can record it separately.
 * extraLamports: additional lamports required by the tx (e.g. rent for a new account).
 */
async function estimateCost(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  txType: TxType,
  extraLamports = 0,
): Promise<EstimateCostResult> {
  const accountKeys = instructions
    .flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))
    .filter((v, i, a) => a.indexOf(v) === i);

  const [microLamports, cuResult] = await Promise.all([
    getPriorityFeeEstimator().estimate(accountKeys, TIER_MAP[txType]),
    getCuEstimator().estimate(connection, instructions, signers),
  ]);

  const jitoTip = process.env.USE_HELIUS_SENDER === "true"
    ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
    : 0;

  return {
    estimatedCost: estimateLamportCost(microLamports, cuResult.cu, jitoTip, extraLamports),
    simulatedCu: cuResult.cu,
    provenToFail: cuResult.provenToFail,
    simError: cuResult.simError,
  };
}

export interface KeeperSendResult {
  signature: string;
  estimatedCost: number;
  simulatedCu: number;
}

/**
 * Classify a send failure for budget accounting.
 *
 * `pollSignatureStatus` (in @percolatorct/shared) is the only source that throws
 * AFTER the tx confirmed on-chain: on `status.err` it throws
 * `Transaction failed: <err json>`. So that prefix is a reliable "the tx LANDED
 * and the program reverted" marker. Every other keeper-path throw — confirmation
 * timeout ("... not confirmed after ...ms"), broadcast rejection, RPC/429,
 * blockhash, signing, oversize — means the tx did NOT land.
 *
 * A landed-but-reverted tx proves the send path works, so it is recorded as
 * "reverted" (counts as spend + attempt, but excluded from the success-rate
 * breaker — see KeeperBudget.recordTx). This stops an attacker who dodges
 * liquidations, or one reverting market, from halting the whole keeper. Anything
 * we cannot positively identify as a revert defaults to "fail" — the safe
 * direction, since it keeps feeding the systemic "are we landing?" guard.
 */
export function classifySendError(err: unknown): TxResult {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith("Transaction failed:") ? "reverted" : "fail";
}

/**
 * Send a keeper transaction with budget gate, priority-fee estimation, and CU simulation.
 *
 * Returns null if the budget is exhausted (budget.canSpend returned false) — caller
 * should skip without treating this as a send failure.
 *
 * extraLamports: additional lamports the tx must transfer (e.g. rent for a new account).
 * The budget gate includes this cost so provisioning txs are correctly accounted for.
 */
export async function keeperSend(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  txType: TxType,
  budget: KeeperBudget,
  maxRetries = 3,
  keeperOpts?: KeeperSendOptions,
  extraLamports = 0,
): Promise<KeeperSendResult | null> {
  // Single-writer guard: abort before any RPC if this node has lost leadership.
  // The guard is checked here — before estimateCost, sendWithRetry, or any
  // external call — so a demoted node cannot land transactions it queued while
  // still leader but only now processes.
  if (!_isLeader()) {
    logger.warn("keeperSend: not leader — skipping send", { txType });
    return null;
  }

  // v17 cutover (issue #176): the wrapper program installs a custom 128KB heap
  // allocator and aborts ("Access violation in heap section") on its first heap
  // allocation unless the transaction requests the matching heap frame. Every
  // keeper send path (crank InitUser/CrankLpVaultFees/RestartAssetOracle/
  // PermissionlessCrank + liquidation Liquidate) carries a wrapper instruction,
  // so prepend the request here as the FIRST instruction. 131072 = 128*1024 ==
  // the program's V16_HEAP_FRAME_BYTES. The CU limit is left to estimateCost /
  // simulatedCu, so no setComputeUnitLimit is added here.
  instructions = [
    ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
    ...instructions,
  ];

  const { estimatedCost, simulatedCu, provenToFail, simError } = await estimateCost(
    connection,
    instructions,
    signers,
    txType,
    extraLamports,
  );

  // H-3: simulateTransaction can report a positive unitsConsumed even when
  // the tx fails (CU is metered up to the point of failure), so CuEstimator
  // separately proves failure via the program's own InstructionError. Abort
  // before the budget gate -- no reservation is taken, so this is a pure
  // skip, same "don't treat as failure" contract as the leader-check and
  // budget-gate paths below.
  if (provenToFail) {
    logger.warn("keeperSend: simulation proved tx will fail — skipping send", {
      txType,
      simulatedCu,
      err: simError,
    });
    return null;
  }

  if (!budget.canSpend(estimatedCost, txType)) {
    logger.warn("Budget gate: refusing send — budget exhausted or halted", {
      txType,
      estimatedCost,
      stats: budget.getStats(),
    });
    return null; // canSpend returned false → no reservation was taken
  }

  // canSpend() reserved `estimatedCost` (and one tx slot). We MUST release it
  // with exactly one recordTx() on every exit path — a reservation that is
  // never released leaks, silently shrinking the budget's effective cap until
  // it wedges (worse than the TOCTOU it fixes). The idempotent `release` plus
  // the outer try/finally guarantee the reservation is freed exactly once even
  // on an unexpected throw between here and the send.
  let recorded = false;
  const release = (result: TxResult): void => {
    if (recorded) return;
    recorded = true;
    budget.recordTx(estimatedCost, txType, result);
  };

  try {
    // A.10 (HIGH): DRY_RUN intercepts before the real send. The shadow-keeper
    // harness compares would-have-fired decisions against the live keeper's
    // tx history; that comparison needs the full ix payload + accounts +
    // estimated cost recorded against the same budget so runaway-fire is also
    // detectable in dry runs. Logged at info so the harness can ingest it.
    if (process.env.DRY_RUN === "true") {
      const signature = `dry_run_${randomUUID()}`;
      const accountKeys = instructions.flatMap((ix) =>
        ix.keys.map((k) => k.pubkey.toBase58()),
      );
      logger.info("DRY_RUN: intercepted send", {
        txType,
        signature,
        estimatedCost,
        simulatedCu,
        instructions: instructions.map((ix) => ({
          programId: ix.programId.toBase58(),
          accountKeys: ix.keys.map((k) => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          dataBase64: Buffer.from(ix.data).toString("base64"),
        })),
        uniqueAccounts: Array.from(new Set(accountKeys)),
      });

      // When the shadow harness is enabled, log the decision for the comparison
      // loop. Errors are swallowed inside DecisionLog.append() — they must never
      // propagate here. When SHADOW_HARNESS_ENABLED is false, this branch still
      // runs but the append is still called; the decisionLog.append itself is a
      // no-op overhead of <1ms. If that ever becomes a concern, add the env guard
      // inside append() rather than here to keep this path readable.
      if (process.env.SHADOW_HARNESS_ENABLED === "true") {
        const decisionIx = firstProgramInstruction(instructions);
        // Keeper wrapper ixs use keys[0] for the signer and keys[1] for the slab/market.
        const market = decisionIx?.keys[1]?.pubkey.toBase58() ?? "unknown";
        const instructionData =
          decisionIx !== undefined ? Buffer.from(decisionIx.data).toString("base64") : "";
        void sharedDecisionLog.append({
          timestamp: new Date().toISOString(),
          txType,
          market,
          accounts: Array.from(new Set(accountKeys)),
          instructionData,
          estimatedCost,
          reasonChain: [],
        });
      }

      release("success");
      return { signature, estimatedCost, simulatedCu };
    }

    const opts: KeeperSendOptions = {
      ...keeperOpts,
      // Saves ~20-50ms on mainnet when Helius Sender runs its own preflight downstream.
      ...(isMainnetSender() ? { skipPreflight: true } : {}),
    };

    // M13: re-check leadership IMMEDIATELY before the actual send. The entry
    // gate at line 190 fired before `await estimateCost(...)`, which can take
    // 100-500ms for the priority-fee fetch + CU simulation. A Redis renew blip
    // during that window can demote this node — without this second check, the
    // demoted node still lands the tx, defeating the single-writer barrier
    // PR #191 was designed to provide. On demotion, release the reservation as
    // "drop" so no spend is booked and the budget stays sane.
    if (!_isLeader()) {
      logger.warn("keeperSend: lost leadership during estimateCost — aborting before send", { txType });
      release("drop");
      return null;
    }

    try {
      const signature = await sendWithRetryKeeper(connection, instructions, signers, maxRetries, opts);
      // M12: after the tx confirms, fetch the actual on-chain cost and
      // reconcile the budget. estimatedCost is what the gate checked, but
      // the realized cost (meta.fee) differs because the actual priority fee
      // depends on CU consumed × microLamports, and the keeper may have
      // under- or over-estimated the CU. Fire-and-forget so the send return
      // is not blocked. Errors are caught internally so a flaky getTransaction
      // never propagates here.
      void scheduleRealizedCostReconciliation(connection, signature, estimatedCost, txType, budget);
      release("success");
      return { signature, estimatedCost, simulatedCu };
    } catch (err) {
      // A landed-but-reverted tx ("Transaction failed: ...") is recorded as
      // "reverted" so it doesn't poison the success-rate breaker; genuine
      // never-landed failures stay "fail". The error is rethrown unchanged.
      release(classifySendError(err));
      throw err;
    }
  } finally {
    // Safety net: if a path above reserved but never recorded (an unexpected
    // throw before release ran), free the reservation as a drop — no spend is
    // booked because nothing reached the chain. No-op if already released.
    release("drop");
  }
}

/**
 * M12: schedule an async fetch of the tx receipt + budget reconciliation.
 *
 * Sampling: env-configurable via KEEPER_REALIZED_COST_SAMPLE_PCT (default 100
 * = reconcile every tx). Lower values reduce RPC load on busy keepers at the
 * cost of less accurate drift telemetry. Set to 0 to disable.
 *
 * Errors are swallowed — reconciliation is best-effort observability.
 */
function scheduleRealizedCostReconciliation(
  connection: Connection,
  signature: string,
  estimatedCost: number,
  txType: TxType,
  budget: KeeperBudget,
): void {
  const samplePct = parseInt(process.env.KEEPER_REALIZED_COST_SAMPLE_PCT ?? "100", 10);
  if (!Number.isFinite(samplePct) || samplePct <= 0) return;
  // Deterministic sampling on signature so the same tx isn't double-sampled
  // by a future caller — and so tests can pin behaviour with a known sig.
  const sigHashByte = signature.charCodeAt(0) || 0;
  if (samplePct < 100 && (sigHashByte % 100) >= samplePct) return;

  // We deliberately don't await this — the send return must not block on
  // getTransaction. Promise rejections are swallowed inside the body.
  void (async () => {
    try {
      // Helius confirmed slot lag is usually < 2s; give it 5s before fetching.
      await new Promise((r) => setTimeout(r, 5_000));
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const realizedFee = tx?.meta?.fee;
      if (typeof realizedFee !== "number" || !Number.isFinite(realizedFee) || realizedFee < 0) {
        return;
      }
      // getTransaction's meta.fee is base + priority fee, but it does NOT
      // include the Jito tip (which is a separate transfer). When the
      // sender used Helius Sender with a jito tip, add it so realized total
      // is comparable to estimatedCost (which includes the tip too).
      const jitoTip = process.env.USE_HELIUS_SENDER === "true"
        ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
        : 0;
      const realizedTotal = realizedFee + (Number.isFinite(jitoTip) ? jitoTip : 0);
      budget.adjustForRealizedCost(estimatedCost, realizedTotal, txType);
    } catch (err) {
      // Best-effort only. A failed reconciliation just means the drift
      // metric won't update for this tx — the budget gate already passed
      // and the recorded estimatedCost is conservative.
      logger.debug("realized-cost reconciliation failed", {
        signature: signature.slice(0, 12),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
