import { loadKeypair } from "@percolatorct/shared";
import { isMainnetNetwork, isKnownNetwork, normalizeNetwork } from "./network.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const TEST_VALIDATOR_PORT = "8899";

// Delegates to the canonical resolver — case/whitespace-insensitive, and always
// agrees with isMainnet() / CURRENT_NETWORK / the HA lock key.
function isMainnetEnv(env: NodeJS.ProcessEnv): boolean {
  return isMainnetNetwork(env.NETWORK);
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

// A8: classify an RPC host as devnet/testnet. Anchored on dot-delimited
// hostname labels, never a raw substring, so a legit mainnet host that merely
// contains the text "devnet" (e.g. "my-devnet-migration.example.com", label
// "my-devnet-migration") or "mainnet-beta" is never a false positive. Catches
// every real form: api.devnet.solana.com, devnet.helius-rpc.com,
// api.testnet.solana.com, testnet.helius-rpc.com.
function isDevnetOrTestnetHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  return labels.includes("devnet") || labels.includes("testnet");
}

// A8: When NETWORK=mainnet, refuse any RPC URL whose host is a known
// devnet/testnet cluster. Complements rejectLocalRpcUrl (localhost/port-8899);
// this catches public devnet hosts that the local-host guard lets through —
// most importantly api.devnet.solana.com, which @percolatorct/shared substitutes
// for an unset FALLBACK_RPC_URL. The keeper runs ALL market discovery and
// liquidation retry on the fallback connection, so a devnet host there means it
// discovers zero mainnet markets and cranks nothing.
function rejectDevnetTestnetRpcUrl(varName: string, raw: string | undefined): void {
  if (!raw) return; // presence is enforced separately for FALLBACK_RPC_URL
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Malformed URLs are reported by rejectLocalRpcUrl (which runs first).
    return;
  }
  if (isDevnetOrTestnetHost(parsed.hostname)) {
    throw new Error(
      `${varName} points at devnet/testnet host '${parsed.hostname}' but NETWORK=mainnet — ` +
        `refusing to boot. A mainnet keeper must use a mainnet RPC endpoint. ` +
        `(@percolatorct/shared defaults an unset FALLBACK_RPC_URL to api.devnet.solana.com.)`,
    );
  }
}

export function validateKeeperEnvGuards(env: NodeJS.ProcessEnv = process.env): void {
  // M1: validate CRANK_KEYPAIR parseability at boot. Without this, a malformed
  // keypair (truncated JSON, wrong base58) survives boot and only crashes in
  // the 60s SOL-balance loop where the error is swallowed as warn — operators
  // see the keeper "running" while it can't sign anything. Presence is enforced
  // in index.ts before this function runs; here we only validate format if set.
  const crankKp = env.CRANK_KEYPAIR?.trim();
  if (crankKp) {
    try {
      loadKeypair(crankKp);
    } catch (err) {
      throw new Error(
        `CRANK_KEYPAIR is not a valid keypair (expected a 64-byte JSON array or ` +
          `base58-encoded secret key): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Validate JITO_TIP_LAMPORTS at boot. It feeds estimatedCost in keeper-send
  // (and crank/liquidation/adl) via parseInt(... ?? "200000", 10), which the
  // KeeperBudget circuit breaker gates on. A malformed value (e.g. "abc")
  // parses to NaN; before the canSpend NaN guard that silently disabled the
  // breaker, and even with it the keeper would halt on first send. Reject a
  // set-but-malformed value at boot (a clean supervisor restart) rather than
  // discover it mid-incident. Unset/empty is fine — the read sites default to
  // 200000. Validate with Number() (not parseInt) so "200000abc" is rejected
  // rather than silently truncated.
  const jitoTipRaw = env.JITO_TIP_LAMPORTS?.trim();
  if (jitoTipRaw !== undefined && jitoTipRaw !== "") {
    const tip = Number(jitoTipRaw);
    if (!Number.isFinite(tip) || !Number.isInteger(tip) || tip < 0) {
      throw new Error(
        `JITO_TIP_LAMPORTS='${jitoTipRaw.slice(0, 20)}' is invalid — expected a ` +
          `non-negative integer (lamports). A malformed value makes the tx-cost ` +
          `estimate NaN and would trip the keeper spend circuit breaker.`,
      );
    }
  }

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

  // Fail fast on an explicitly-set NETWORK that isn't a recognized token, so a
  // typo (e.g. "mainnnet") cannot silently resolve to devnet. Unset/empty is
  // allowed (defaults to devnet for local dev).
  if (!isKnownNetwork(env.NETWORK)) {
    throw new Error(
      `NETWORK='${(env.NETWORK ?? "").trim().slice(0, 20)}' is not a recognized network — ` +
        "expected mainnet, devnet, or testnet (case-insensitive).",
    );
  }

  // Reject insecure (plaintext) RPC URLs unless explicitly allowed.
  // http:// and ws:// transmit signed transactions and account data unencrypted,
  // enabling MITM attacks on the network path.
  const allowInsecure = env.ALLOW_INSECURE_RPC === "true";

  // H9: ALLOW_INSECURE_RPC=true on mainnet exposes signed transactions to MITM.
  // The localhost sub-case is caught by rejectLocalRpcUrl, but a remote plaintext
  // HTTP URL (e.g. http://some-rpc.helius.xyz) with ALLOW_INSECURE_RPC=true is
  // not caught. Reject unconditionally when NETWORK=mainnet.
  if (allowInsecure && isMainnetEnv(env)) {
    throw new Error(
      "ALLOW_INSECURE_RPC=true is not permitted when NETWORK=mainnet. " +
      "Plaintext RPC connections expose signed transactions to MITM attacks. " +
      "Use an https:// or wss:// RPC endpoint on mainnet.",
    );
  }
  // A.3 (HIGH): HA leader election pins the Redis lock key to NETWORK. Legacy
  // index.ts fell back to `?? "devnet"` when NETWORK was unset, which meant a
  // mainnet keeper without NETWORK would silently share a lock with devnet
  // and could split-brain. Validate that NETWORK is set to a supported value
  // whenever HA is on.
  if (env.HA_ENABLED === "true") {
    const raw = env.NETWORK?.trim();
    if (!raw) {
      throw new Error(
        "HA_ENABLED=true requires NETWORK to be set. Set NETWORK=mainnet or NETWORK=devnet.",
      );
    }
    // Normalized so "Mainnet"/" mainnet " are accepted consistently; the HA lock
    // key (index.ts) uses the same normalized value, so two nodes that differ
    // only by case/whitespace share one lock instead of splitting the brain.
    const net = normalizeNetwork(env.NETWORK);
    if (net !== "mainnet" && net !== "devnet") {
      throw new Error(
        `HA_ENABLED=true: NETWORK must resolve to 'mainnet' or 'devnet' (got '${raw.slice(0, 20)}').`,
      );
    }
  }

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

    // A8: reject devnet/testnet hosts on every connection a mainnet keeper opens
    // (discovery + liquidation retry run on the fallback connection).
    rejectDevnetTestnetRpcUrl("SOLANA_RPC_URL", env.SOLANA_RPC_URL?.trim());
    rejectDevnetTestnetRpcUrl("SOLANA_RPC_WS_URL", env.SOLANA_RPC_WS_URL?.trim());
    rejectDevnetTestnetRpcUrl("FALLBACK_RPC_URL", env.FALLBACK_RPC_URL?.trim());
    rejectDevnetTestnetRpcUrl("RPC_URL", env.RPC_URL?.trim());

    // A8: FALLBACK_RPC_URL has no safe default on mainnet — when unset,
    // @percolatorct/shared substitutes https://api.devnet.solana.com (with no
    // network condition), and the keeper runs all market discovery + liquidation
    // retry on that devnet connection. Require it to be set explicitly. (Checked
    // last so an offending localhost/devnet value still gets its specific error.)
    if (!env.FALLBACK_RPC_URL?.trim()) {
      throw new Error(
        "FALLBACK_RPC_URL must be set to a mainnet RPC endpoint when NETWORK=mainnet. " +
          "It is unset, and @percolatorct/shared silently defaults it to " +
          "api.devnet.solana.com — which would run all market discovery and " +
          "liquidation retry on devnet, discovering zero mainnet markets.",
      );
    }
  }
}
