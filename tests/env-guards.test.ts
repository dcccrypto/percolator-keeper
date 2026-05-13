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

  // K-3 (HIGH): ADL_ENABLED must be explicit on mainnet so an operator who
  // forgets the var cannot silently ship a keeper with the insurance-fund
  // safety mechanism disabled.
  it("throws when NETWORK=mainnet and ADL_ENABLED is unset", () => {
    const env = {
      NETWORK: "mainnet",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "ADL_ENABLED must be explicitly set"
    );
  });

  it("throws when NETWORK=mainnet and ADL_ENABLED is a non-boolean value", () => {
    const env = {
      NETWORK: "mainnet",
      ADL_ENABLED: "1",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).toThrow(
      "ADL_ENABLED must be explicitly set"
    );
  });

  it("does not throw when NETWORK=mainnet and ADL_ENABLED=true", () => {
    const env = {
      NETWORK: "mainnet",
      ADL_ENABLED: "true",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not throw when NETWORK=mainnet and ADL_ENABLED=false", () => {
    const env = {
      NETWORK: "mainnet",
      ADL_ENABLED: "false",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("normalizes ADL_ENABLED case and whitespace on mainnet", () => {
    const env = {
      NETWORK: "mainnet",
      ADL_ENABLED: "  True  ",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not require ADL_ENABLED on devnet", () => {
    const env = {
      NETWORK: "devnet",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  it("does not require ADL_ENABLED when NETWORK is unset", () => {
    const env = {
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });
});
