const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const TEST_VALIDATOR_PORT = "8899";

function isMainnetEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NETWORK === "mainnet";
}

// A2: When NETWORK=mainnet, refuse any RPC URL that points at a local validator.
// The keeper would otherwise sign mainnet-config transactions against a test
// validator with no real funds backing — at best wasting cycles, at worst
// confusing operators into thinking the keeper is healthy when it is not.
function rejectLocalRpcUrl(varName: string, raw: string | undefined): void {
  if (!raw) return;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${varName} is not a valid URL: ${raw.slice(0, 60)}`);
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${varName} points at ${parsed.hostname} but NETWORK=mainnet — refusing to boot. ` +
        `Unset NETWORK (or set NETWORK=devnet) for local development.`,
    );
  }
  if (parsed.port === TEST_VALIDATOR_PORT) {
    throw new Error(
      `${varName} uses port 8899 (Solana test validator) but NETWORK=mainnet — refusing to boot.`,
    );
  }
}

export function validateKeeperEnvGuards(env: NodeJS.ProcessEnv = process.env): void {
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  // K-2 (HIGH): hard-reject SUPABASE_SERVICE_ROLE_KEY being present at all.
  // If the service-role key is set — even without the anon key — keeper would
  // boot with RLS-bypass capability, violating the principle of least privilege.
  // Keeper only needs the anon key (SUPABASE_KEY) at runtime. (PERC-8232)
  if (serviceRoleKey && serviceRoleKey !== "") {
    throw new Error(
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env. " +
        "Keeper needs only the anon key (SUPABASE_KEY). " +
        "Remove SUPABASE_SERVICE_ROLE_KEY from .env and Railway config. (PERC-8232)",
    );
  }

  // A3 (L-2): the secondary "anon == service-role" equality check was
  // unreachable — the hard-reject above already throws on any non-empty
  // service-role key. Deleted; the supabaseKey lookup that fed it is gone too.

  // Reject insecure (plaintext) RPC URLs unless explicitly allowed.
  // http:// and ws:// transmit signed transactions and account data unencrypted,
  // enabling MITM attacks on the network path.
  const allowInsecure = env.ALLOW_INSECURE_RPC === "true";
  if (!allowInsecure) {
    const rpcUrl = env.SOLANA_RPC_URL?.trim();
    if (rpcUrl && !rpcUrl.startsWith("https://")) {
      throw new Error(
        `SOLANA_RPC_URL must use https:// (got ${rpcUrl.slice(0, 30)}...). ` +
          "Plaintext HTTP exposes signed transactions to MITM. " +
          "Set ALLOW_INSECURE_RPC=true to override for local development.",
      );
    }
    const wsUrl = env.SOLANA_RPC_WS_URL?.trim();
    if (wsUrl && !wsUrl.startsWith("wss://")) {
      throw new Error(
        `SOLANA_RPC_WS_URL must use wss:// (got ${wsUrl.slice(0, 30)}...). ` +
          "Plaintext WebSocket exposes account data to MITM. " +
          "Set ALLOW_INSECURE_RPC=true to override for local development.",
      );
    }
    // Validate fallback RPC URL — used by discovery and liquidation retry.
    // Same MITM risk as primary: signed transactions sent over plaintext.
    const fallbackRpcUrl = env.FALLBACK_RPC_URL?.trim();
    if (fallbackRpcUrl && !fallbackRpcUrl.startsWith("https://")) {
      throw new Error(
        `FALLBACK_RPC_URL must use https:// (got ${fallbackRpcUrl.slice(0, 30)}...). ` +
          "Plaintext HTTP exposes signed transactions to MITM. " +
          "Set ALLOW_INSECURE_RPC=true to override for local development.",
      );
    }
  }

  if (isMainnetEnv(env)) {
    rejectLocalRpcUrl("SOLANA_RPC_URL", env.SOLANA_RPC_URL?.trim());
    rejectLocalRpcUrl("SOLANA_RPC_WS_URL", env.SOLANA_RPC_WS_URL?.trim());
    rejectLocalRpcUrl("FALLBACK_RPC_URL", env.FALLBACK_RPC_URL?.trim());
    // A.7: @percolatorct/shared and src/lib/priority-fee.ts read RPC_URL
    // (not SOLANA_RPC_URL). Without this guard a RPC_URL=http://localhost
    // on mainnet would be accepted while the other vars are caught.
    rejectLocalRpcUrl("RPC_URL", env.RPC_URL?.trim());
  }
}
