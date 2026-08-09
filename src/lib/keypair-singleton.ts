import { loadKeypair } from "@percolatorct/shared";
import type { Keypair } from "@solana/web3.js";

let _instance: Keypair | null = null;

/**
 * Return the keeper signing keypair, parsing CRANK_KEYPAIR exactly once.
 *
 * index.ts, CrankService and LiquidationService each called loadKeypair()
 * independently. Routing all three through here parses once and gives a single
 * place to change how the signing key is sourced (env today, a KMS or remote
 * signer later) without touching three call sites.
 *
 * This deliberately does NOT scrub process.env. An earlier version overwrote
 * the variable and then deleted it, on the theory that this kept the secret out
 * of heap dumps. It does not — V8 strings are immutable, so assigning a new
 * value allocates a new string and leaves the original in memory until GC. The
 * deletion's only real effect was to break every consumer that reads the
 * variable after the first call: vitest shares one worker process across test
 * files, so the first service to resolve its keypair made every later service
 * construction throw "CRANK_KEYPAIR is not set" (23 failing tests). Removing a
 * secret from a process that must keep using it needs a different mechanism
 * (a signer that never holds the key in this process at all), not env deletion.
 *
 * Presence and parseability are already enforced upstream and are not
 * re-checked here: index.ts requires CRANK_KEYPAIR to be set before any service
 * is constructed, and validateKeeperEnvGuards() rejects a malformed value at
 * boot. Adding a redundant presence check here would only change WHERE a
 * misconfiguration surfaces, and would break tests that mock loadKeypair.
 */
export function getKeeperKeypair(): Keypair {
  if (!_instance) {
    _instance = loadKeypair(process.env.CRANK_KEYPAIR!);
  }
  return _instance;
}
