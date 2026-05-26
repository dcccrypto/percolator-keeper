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

const DEFAULT_MARGIN = 1.1;
const DEFAULT_FALLBACK_CU = 1_400_000;

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
  ): Promise<number> {
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
        return this._fallback;
      }

      return Math.ceil(consumed * this._margin);
    } catch (err) {
      logger.warn("CU simulation failed — using fallback CU limit", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this._fallback;
    }
  }
}
