import { describe, it, expect } from "vitest";
import { validateKeeperEnvGuards } from "../src/env-guards.js";

describe("validateKeeperEnvGuards", () => {
  // K-2 (HIGH): SUPABASE_SERVICE_ROLE_KEY must be rejected even when both keys are set.
  // The hard-reject fires before the equality check.
  it("throws when SUPABASE_SERVICE_ROLE_KEY is present (any value)", () => {
    const env = {
      SUPABASE_KEY: "same-key",
      SUPABASE_SERVICE_ROLE_KEY: "same-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env"
    );
  });

  // K-2: also rejects when the service-role key differs from the anon key —
  // any non-empty SUPABASE_SERVICE_ROLE_KEY is forbidden regardless of value.
  it("throws when SUPABASE_SERVICE_ROLE_KEY is set even if different from anon key", () => {
    const env = {
      SUPABASE_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env"
    );
  });

  it("does not throw when one key is missing", () => {
    const env = {
      SUPABASE_KEY: "anon-key",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("throws when SOLANA_RPC_URL uses http://", () => {
    const env = {
      SOLANA_RPC_URL: "http://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("must use https://");
  });

  it("throws when SOLANA_RPC_WS_URL uses ws://", () => {
    const env = {
      SOLANA_RPC_WS_URL: "ws://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("must use wss://");
  });

  it("allows insecure URLs when ALLOW_INSECURE_RPC=true", () => {
    const env = {
      SOLANA_RPC_URL: "http://localhost:8899",
      SOLANA_RPC_WS_URL: "ws://localhost:8900",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw for https:// and wss:// URLs", () => {
    const env = {
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      SOLANA_RPC_WS_URL: "wss://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("throws when FALLBACK_RPC_URL uses http://", () => {
    const env = {
      FALLBACK_RPC_URL: "http://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow("FALLBACK_RPC_URL must use https://");
  });

  it("allows insecure FALLBACK_RPC_URL when ALLOW_INSECURE_RPC=true", () => {
    const env = {
      FALLBACK_RPC_URL: "http://localhost:8899",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw for https:// FALLBACK_RPC_URL", () => {
    const env = {
      FALLBACK_RPC_URL: "https://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  // A.3 (HIGH): HA_ENABLED=true pins the Redis lock key to NETWORK. With
  // NETWORK unset the legacy code fell back to "devnet" — a mainnet keeper
  // would silently share a lock with devnet, allowing split-brain.
  describe("A.3: HA_ENABLED requires NETWORK", () => {
    it("throws when HA_ENABLED=true and NETWORK is unset", () => {
      const env = { HA_ENABLED: "true" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*requires.*NETWORK/i,
      );
    });

    it("throws when HA_ENABLED=true and NETWORK is empty string", () => {
      const env = { HA_ENABLED: "true", NETWORK: "" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*requires.*NETWORK/i,
      );
    });

    it("throws when HA_ENABLED=true and NETWORK is an unsupported value", () => {
      const env = { HA_ENABLED: "true", NETWORK: "testnet" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /NETWORK.*mainnet.*devnet/i,
      );
    });

    it("accepts HA_ENABLED=true + NETWORK=mainnet", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("accepts HA_ENABLED=true + NETWORK=devnet", () => {
      const env = { HA_ENABLED: "true", NETWORK: "devnet" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("accepts HA_ENABLED unset regardless of NETWORK state", () => {
      expect(() =>
        validateKeeperEnvGuards({} as NodeJS.ProcessEnv),
      ).not.toThrow();
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "testnet" } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it("accepts HA_ENABLED=false (not 'true') regardless of NETWORK state", () => {
      const env = { HA_ENABLED: "false" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });
  });
});
