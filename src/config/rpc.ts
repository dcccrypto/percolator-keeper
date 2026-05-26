/**
 * RPC provider configuration and routing rules for the keeper RPC pool.
 *
 * Parsed once at startup. ALCHEMY_RPC_URL and ALCHEMY_API_KEY are validated
 * only when RPC_POOL_ENABLED=true — this avoids breaking keeper boots that
 * have not yet configured Alchemy.
 */

function parseBoolEnv(env: NodeJS.ProcessEnv, key: string, defaultVal: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultVal;
  return raw.trim().toLowerCase() === "true";
}

function parseIntEnv(env: NodeJS.ProcessEnv, key: string, defaultVal: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return defaultVal;
  return n;
}

export interface RpcProviderConfig {
  url: string;
  name: "helius" | "alchemy";
}

export interface RpcPoolConfig {
  enabled: boolean;
  helius: RpcProviderConfig;
  alchemy: RpcProviderConfig;
  healthCheckIntervalMs: number;
  unhealthyP99Ms: number;
  unhealthySlotLag: number;
  unhealthyConsecutiveFails: number;
  recoveryWindowMs: number;
  forceAlchemyGpa: boolean;
}

export function parseRpcPoolConfig(env: NodeJS.ProcessEnv = process.env): RpcPoolConfig {
  const enabled = parseBoolEnv(env, "RPC_POOL_ENABLED", false);

  const heliusUrl = env.SOLANA_RPC_URL ?? env.RPC_URL ?? "";

  if (enabled) {
    const alchemyUrl = env.ALCHEMY_RPC_URL?.trim() ?? "";
    if (!alchemyUrl) {
      throw new Error(
        "RPC_POOL_ENABLED=true requires ALCHEMY_RPC_URL to be set. " +
          "Set ALCHEMY_RPC_URL to your Alchemy endpoint or set RPC_POOL_ENABLED=false.",
      );
    }
    // Alchemy URL must be https unless ALLOW_INSECURE_RPC=true.
    if (!alchemyUrl.startsWith("https://") && env.ALLOW_INSECURE_RPC !== "true") {
      throw new Error(
        `ALCHEMY_RPC_URL must use https:// (got ${alchemyUrl.slice(0, 30)}...). ` +
          "Set ALLOW_INSECURE_RPC=true to override for local development.",
      );
    }
  }

  const alchemyUrl = env.ALCHEMY_RPC_URL?.trim() ?? "";

  return {
    enabled,
    helius: { url: heliusUrl, name: "helius" },
    alchemy: { url: alchemyUrl, name: "alchemy" },
    healthCheckIntervalMs: parseIntEnv(env, "RPC_HEALTH_CHECK_INTERVAL_MS", 5_000),
    unhealthyP99Ms: parseIntEnv(env, "RPC_UNHEALTHY_P99_MS", 2_000),
    unhealthySlotLag: parseIntEnv(env, "RPC_UNHEALTHY_SLOT_LAG", 50),
    unhealthyConsecutiveFails: parseIntEnv(env, "RPC_UNHEALTHY_CONSECUTIVE_FAILS", 5),
    recoveryWindowMs: parseIntEnv(env, "RPC_RECOVERY_WINDOW_MS", 60_000),
    forceAlchemyGpa: parseBoolEnv(env, "RPC_FORCE_ALCHEMY_GPA", true),
  };
}
