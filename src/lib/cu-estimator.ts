import {
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:cu-estimator");

// The margin multiplies the metered units once, after the simulator has settled: the tail lane rounds up, never the head.
const DEFAULT_MARGIN = 1.1;
const DEFAULT_FALLBACK_CU = 1_400_000;

export interface CuEstimateResult {
  cu: number;
  /**
   * H-3: true iff simulation ran to completion and the program itself
   * rejected the instructions (an `InstructionError`) -- a deterministic
   * failure that a real send of the same instructions against the same
   * on-chain state would revert identically, wasting a real fee.
   *
   * Deliberately narrow: `unitsConsumed` is commonly positive even when the
   * simulated tx fails (CU is metered up to the point of failure), so it is
   * NOT used as a success signal. But not every non-null `err` proves a real
   * send would also fail -- transaction-level errors like "BlockhashNotFound"
   * or "AccountInUse" can be artifacts of how THIS estimator simulates (a
   * throwaway blockhash relying on replaceRecentBlockhash, or a transient
   * write-lock collision with another in-flight tx) rather than evidence the
   * instructions themselves are doomed. Only the InstructionError shape --
   * the program actually ran and rejected the request -- is treated as proof.
   */
  provenToFail: boolean;
  simError?: unknown;
}

function isProvenToFail(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "InstructionError" in (err as Record<string, unknown>)
  );
}

export class CuEstimator {
  private readonly _margin: number;
  private readonly _fallback: number;

  constructor(opts?: { margin?: number; fallback?: number }) {
    this._margin =
      opts?.margin ??
      parseFloat(process.env.KEEPER_CU_SIMULATE_MARGIN ?? String(DEFAULT_MARGIN));
    this._fallback =
      opts?.fallback ??
      parseInt(process.env.KEEPER_CU_FALLBACK_LIMIT ?? String(DEFAULT_FALLBACK_CU), 10);
  }

  async estimate(
    connection: Connection,
    instructions: TransactionInstruction[],
    signers: Keypair[],
  ): Promise<CuEstimateResult> {
    try {
      const feePayer = signers[0]?.publicKey ?? PublicKey.default;
      // Use a throwaway blockhash — replaceRecentBlockhash=true will overwrite it.
      const msg = new TransactionMessage({
        payerKey: feePayer,
        recentBlockhash: "11111111111111111111111111111112",
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const sim = await connection.simulateTransaction(tx, {
        replaceRecentBlockhash: true,
        sigVerify: false,
      });

      const consumed = sim.value.unitsConsumed;
      if (typeof consumed !== "number" || consumed <= 0) {
        logger.warn("Simulation returned no unitsConsumed — using fallback CU limit", {
          err: sim.value.err,
          logs: sim.value.logs?.slice(0, 3),
        });
        return { cu: this._fallback, provenToFail: false };
      }

      // H-3: unitsConsumed > 0 does not mean the tx would succeed -- the
      // simulator meters CU up to the point of failure, so a reverting
      // simulation routinely reports a normal-looking positive value too.
      if (isProvenToFail(sim.value.err)) {
        logger.warn("Simulation proved the transaction will fail — flagging for caller to skip", {
          err: sim.value.err,
          unitsConsumed: consumed,
          logs: sim.value.logs?.slice(0, 5),
        });
        return { cu: Math.ceil(consumed * this._margin), provenToFail: true, simError: sim.value.err };
      }

      return { cu: Math.ceil(consumed * this._margin), provenToFail: false };
    } catch (err) {
      logger.warn("CU simulation failed — using fallback CU limit", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { cu: this._fallback, provenToFail: false };
    }
  }
}
