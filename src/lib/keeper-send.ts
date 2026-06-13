import { randomUUID } from "node:crypto";
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
 * Cost = base + ceil(microLamports * cu / 1_000_000) + jitoTip.
 */
export function estimateLamportCost(
  microLamports: number,
  cu: number,
  jitoTip: number,
): number {
  const priorityFee = Math.ceil((microLamports * cu) / 1_000_000);
  return BASE_FEE_LAMPORTS + priorityFee + jitoTip;
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

interface EstimateCostResult {
  estimatedCost: number;
  simulatedCu: number;
}

/**
 * Estimate total lamport cost of a transaction.
 * priority_fee_microlamports * CU / 1_000_000 + base_fee + jito_tip.
 * Also returns the raw simulated CU so callers can record it separately.
 */
async function estimateCost(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  txType: TxType,
): Promise<EstimateCostResult> {
  const accountKeys = instructions
    .flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))
    .filter((v, i, a) => a.indexOf(v) === i);

  const [microLamports, simulatedCu] = await Promise.all([
    getPriorityFeeEstimator().estimate(accountKeys, TIER_MAP[txType]),
    getCuEstimator().estimate(connection, instructions, signers),
  ]);

  const jitoTip = process.env.USE_HELIUS_SENDER === "true"
    ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
    : 0;

  return { estimatedCost: estimateLamportCost(microLamports, simulatedCu, jitoTip), simulatedCu };
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
 */
export async function keeperSend(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  txType: TxType,
  budget: KeeperBudget,
  maxRetries = 3,
  keeperOpts?: KeeperSendOptions,
): Promise<KeeperSendResult | null> {
  const { estimatedCost, simulatedCu } = await estimateCost(connection, instructions, signers, txType);

  if (!budget.canSpend(estimatedCost, txType)) {
    logger.warn("Budget gate: refusing send — budget exhausted or halted", {
      txType,
      estimatedCost,
      stats: budget.getStats(),
    });
    return null;
  }

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
      const firstIx = instructions[0];
      // The market is the first non-system account from the first instruction.
      // For crank/liquidation/adl ixs the slab address is always at index 0.
      const market = firstIx?.keys[0]?.pubkey.toBase58() ?? "unknown";
      const instructionData =
        firstIx !== undefined ? Buffer.from(firstIx.data).toString("base64") : "";
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

    budget.recordTx(estimatedCost, txType, "success");
    return { signature, estimatedCost, simulatedCu };
  }

  const opts: KeeperSendOptions = {
    ...keeperOpts,
    // Saves ~20-50ms on mainnet when Helius Sender runs its own preflight downstream.
    ...(isMainnetSender() ? { skipPreflight: true } : {}),
  };

  let result: TxResult = "fail";
  let signature = "";
  try {
    signature = await sendWithRetryKeeper(connection, instructions, signers, maxRetries, opts);
    result = "success";
    return { signature, estimatedCost, simulatedCu };
  } catch (err) {
    // A landed-but-reverted tx ("Transaction failed: ...") is recorded as
    // "reverted" so it doesn't poison the success-rate breaker; genuine
    // never-landed failures stay "fail". The error is rethrown unchanged.
    result = classifySendError(err);
    throw err;
  } finally {
    budget.recordTx(estimatedCost, txType, result);
  }
}
