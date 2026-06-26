import { loadKeypair } from "@percolatorct/shared";
import type { Keypair } from "@solana/web3.js";

let _instance: Keypair | null = null;

/**
 * Return the keeper signing keypair, parsing CRANK_KEYPAIR exactly once.
 *
 * All three service-level consumers (index.ts, CrankService, LiquidationService)
 * previously called loadKeypair() independently, producing three separate 64-byte
 * secretKey Uint8Array allocations that persist for the process lifetime. Using a
 * singleton reduces this to one live allocation and deletes the raw env-var string
 * immediately after the first parse so it cannot be read by later code or appear
 * in heap dumps and Railway log snapshots.
 *
 * Must be called AFTER validateKeeperEnvGuards() so boot-time validation still
 * reads the env var before this function deletes it.
 */
export function getKeeperKeypair(): Keypair {
  if (!_instance) {
    const raw = process.env.CRANK_KEYPAIR;
    if (!raw) throw new Error("CRANK_KEYPAIR is not set");
    _instance = loadKeypair(raw);
    // Overwrite then delete: narrows the window where the raw secret key string
    // is readable via process.env (heap dumps, accidental logger.info(process.env)).
    process.env.CRANK_KEYPAIR = "0".repeat(raw.length);
    delete process.env.CRANK_KEYPAIR;
  }
  return _instance;
}
