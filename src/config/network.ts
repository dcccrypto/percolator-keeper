/**
 * Network helpers for mainnet/devnet detection.
 * The @percolatorct/shared networkValidation module handles FORCE_MAINNET guards;
 * this module provides a simple runtime check for keeper-specific logic.
 *
 * Delegates to the single canonical resolver in src/network.ts so this check is
 * case/whitespace-insensitive and can never diverge from CURRENT_NETWORK, the
 * env guards, or the HA lock key.
 */
import { isMainnetNetwork } from "../network.js";

export function isMainnet(): boolean {
  return isMainnetNetwork(process.env.NETWORK);
}
