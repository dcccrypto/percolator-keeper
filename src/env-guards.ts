export function validateKeeperEnvGuards(env: NodeJS.ProcessEnv = process.env): void {
  const supabaseKey = env.SUPABASE_KEY?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  // K-2 (HIGH): hard-reject SUPABASE_SERVICE_ROLE_KEY being present at all.
  // If the service-role key is set — even without the anon key — keeper would
  // boot with RLS-bypass capability, violating the principle of least privilege.
  // Keeper only needs the anon key (SUPABASE_KEY) at runtime. (PERC-8232)
  if (serviceRoleKey && serviceRoleKey !== "") {
    throw new Error(
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env. " +
      "Keeper needs only the anon key (SUPABASE_KEY). " +
      "Remove SUPABASE_SERVICE_ROLE_KEY from .env and Railway config. (PERC-8232)"
    );
  }

  if (supabaseKey && serviceRoleKey && supabaseKey === serviceRoleKey) {
    throw new Error(
      "Keeper misconfiguration: SUPABASE_KEY must not equal SUPABASE_SERVICE_ROLE_KEY. " +
      "Set SUPABASE_KEY to the anon key for keeper runtime."
    );
  }

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
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
    const wsUrl = env.SOLANA_RPC_WS_URL?.trim();
    if (wsUrl && !wsUrl.startsWith("wss://")) {
      throw new Error(
        `SOLANA_RPC_WS_URL must use wss:// (got ${wsUrl.slice(0, 30)}...). ` +
        "Plaintext WebSocket exposes account data to MITM. " +
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
    // Validate fallback RPC URL — used by discovery and liquidation retry.
    // Same MITM risk as primary: signed transactions sent over plaintext.
    const fallbackRpcUrl = env.FALLBACK_RPC_URL?.trim();
    if (fallbackRpcUrl && !fallbackRpcUrl.startsWith("https://")) {
      throw new Error(
        `FALLBACK_RPC_URL must use https:// (got ${fallbackRpcUrl.slice(0, 30)}...). ` +
        "Plaintext HTTP exposes signed transactions to MITM. " +
        "Set ALLOW_INSECURE_RPC=true to override for local development."
      );
    }
  }

  // K-3 (HIGH): ADL_ENABLED must be set explicitly on mainnet.
  // Auto-Deleveraging protects the protocol when the insurance fund cannot
  // cover losses. The legacy default-off behaviour means an operator who
  // forgets to set the var on a mainnet Railway deploy ships a keeper that
  // will never send ExecuteAdl, leaving the protocol unprotected. Require
  // an explicit "true" or "false" on mainnet; devnet keeps the legacy
  // permissive default so local/CI workflows are unaffected.
  if (env.NETWORK?.trim().toLowerCase() === "mainnet") {
    const adl = env.ADL_ENABLED?.trim().toLowerCase();
    if (adl !== "true" && adl !== "false") {
      throw new Error(
        "SECURITY: ADL_ENABLED must be explicitly set to \"true\" or \"false\" " +
        `when NETWORK=mainnet (got ${JSON.stringify(env.ADL_ENABLED)}). ` +
        "Set ADL_ENABLED=true to enable Auto-Deleveraging (recommended on mainnet), " +
        "or ADL_ENABLED=false to acknowledge the insurance-fund risk explicitly."
      );
    }
  }
}
