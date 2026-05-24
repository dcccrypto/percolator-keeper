import type { Connection, TransactionInstruction, Keypair } from "@solana/web3.js";
import { sendWithRetryKeeper, createLogger } from "@percolatorct/shared";
import type { KeeperSendOptions } from "@percolatorct/shared";
import { KeeperBudget } from "./budget.js";
import type { TxType, TxResult } from "./budget.js";
import { HeliusPriorityFeeEstimator } from "./priority-fee.js";
import type { PriorityFeeEstimator, PriorityFeeTier } from "./priority-fee.js";
import { CuEstimator } from "./cu-estimator.js";

const logger = createLogger("keeper:send");

const BASE_FEE_LAMPORTS = 5_000;

const TIER_MAP: Record<TxType, PriorityFeeTier> = {
  crank: "crank",
  liquidation: "liquidation",
  oracle: "oracle",
};

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

export const sharedBudget = new KeeperBudget();

function isMainnetSender(): boolean {
  return (
    process.env.NETWORK === "mainnet" &&
    process.env.USE_HELIUS_SENDER === "true"
  );
}

/**
 * Estimate total lamport cost of a transaction.
 * priority_fee_microlamports * CU / 1_000_000 + base_fee + jito_tip.
 */
async function estimateCost(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  txType: TxType,
): Promise<number> {
  const accountKeys = instructions
    .flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))
    .filter((v, i, a) => a.indexOf(v) === i);

  const [microLamports, cu] = await Promise.all([
    getPriorityFeeEstimator().estimate(accountKeys, TIER_MAP[txType]),
    getCuEstimator().estimate(connection, instructions, signers),
  ]);

  const priorityFee = Math.ceil((microLamports * cu) / 1_000_000);
  const jitoTip = process.env.USE_HELIUS_SENDER === "true"
    ? parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10)
    : 0;

  return BASE_FEE_LAMPORTS + priorityFee + jitoTip;
}

export interface KeeperSendResult {
  signature: string;
  estimatedCost: number;
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
  const estimatedCost = await estimateCost(connection, instructions, signers, txType);

  if (!budget.canSpend(estimatedCost, txType)) {
    logger.warn("Budget gate: refusing send — budget exhausted or halted", {
      txType,
      estimatedCost,
      stats: budget.getStats(),
    });
    return null;
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
    return { signature, estimatedCost };
  } catch (err) {
    result = "fail";
    throw err;
  } finally {
    budget.recordTx(estimatedCost, txType, result);
  }
}
