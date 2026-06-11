/**
 * PERC-8192: Network isolation helper for the keeper.
 *
 * Returns the current deployment network from the NETWORK env var.
 * Evaluated once at module load time so all services share the same value.
 */
export type NetworkType = "devnet" | "testnet" | "mainnet";

/** Canonical network tokens the keeper recognizes (case/whitespace-insensitive). */
const KNOWN_NETWORK_TOKENS = new Set(["mainnet", "testnet", "devnet"]);

/**
 * Single source of truth for interpreting the NETWORK env var.
 * Case- and whitespace-insensitive; unset/empty/unrecognized → "devnet".
 *
 * Every network check in the keeper MUST go through this (isMainnet(), the env
 * guards, the HA lock key, the send path) so they can never disagree on what
 * NETWORK means. Divergent ad-hoc checks (e.g. `process.env.NETWORK === "mainnet"`)
 * previously let a value like "Mainnet" or " mainnet " disable mainnet safety
 * guards while the rest of the keeper still ran as mainnet.
 */
export function normalizeNetwork(raw: string | undefined): NetworkType {
  const n = (raw ?? "devnet").toLowerCase().trim();
  if (n === "mainnet") return "mainnet";
  if (n === "testnet") return "testnet";
  return "devnet";
}

/** True iff NETWORK resolves to mainnet (case/whitespace-insensitive). */
export function isMainnetNetwork(raw: string | undefined): boolean {
  return normalizeNetwork(raw) === "mainnet";
}

/**
 * Whether an explicitly-set NETWORK value is a recognized token. Unset/empty is
 * considered known (callers default it to devnet). Used to fail fast on typos
 * (e.g. "mainnnet") that would otherwise silently resolve to devnet.
 */
export function isKnownNetwork(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const n = raw.trim().toLowerCase();
  if (n === "") return true;
  return KNOWN_NETWORK_TOKENS.has(n);
}

function resolveNetwork(): NetworkType {
  return normalizeNetwork(process.env.NETWORK);
}

/**
 * The current deployment network.
 * All Supabase queries should filter `.eq("network", CURRENT_NETWORK)` to
 * prevent devnet and mainnet rows from mixing.
 */
export const CURRENT_NETWORK: NetworkType = resolveNetwork();
