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
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env",
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
      "SECURITY: SUPABASE_SERVICE_ROLE_KEY must NOT be set in keeper env",
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

  // A2: mainnet-mode local-host rejection
  describe("when NETWORK=mainnet", () => {
    it.each([
      ["localhost", "https://localhost/"],
      ["127.0.0.1", "https://127.0.0.1/"],
      ["0.0.0.0", "https://0.0.0.0/"],
      ["[::1]", "https://[::1]/"],
    ])("rejects SOLANA_RPC_URL pointing at %s", (host, url) => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: url,
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        new RegExp(`SOLANA_RPC_URL points at .* but NETWORK=mainnet`),
      );
    });

    it("rejects FALLBACK_RPC_URL pointing at localhost", () => {
      const env = {
        NETWORK: "mainnet",
        FALLBACK_RPC_URL: "https://localhost/",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /FALLBACK_RPC_URL points at .* but NETWORK=mainnet/,
      );
    });

    it("rejects SOLANA_RPC_WS_URL pointing at 127.0.0.1", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_WS_URL: "wss://127.0.0.1/",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /SOLANA_RPC_WS_URL points at .* but NETWORK=mainnet/,
      );
    });

    it("rejects URLs using port 8899 (test validator)", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://some-host.example.com:8899/",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /SOLANA_RPC_URL uses port 8899 \(Solana test validator\) but NETWORK=mainnet/,
      );
    });

    it("rejects mainnet+localhost even when ALLOW_INSECURE_RPC=true (separate guard)", () => {
      // ALLOW_INSECURE_RPC bypasses the http:// guard but NOT the mainnet+localhost guard
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "http://localhost:8899",
        ALLOW_INSECURE_RPC: "true",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /SOLANA_RPC_URL points at .* but NETWORK=mainnet/,
      );
    });

    it("accepts real mainnet RPC URLs", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=xxx",
        SOLANA_RPC_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=xxx",
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        RPC_URL: "https://mainnet.helius-rpc.com/?api-key=xxx",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    // A.7 (HIGH): RPC_URL is the var actually read by @percolatorct/shared and
    // src/lib/priority-fee.ts. Without this guard, a RPC_URL=http://localhost
    // on mainnet would be accepted while SOLANA_RPC_URL is guarded.
    it.each([
      ["localhost", "https://localhost/"],
      ["127.0.0.1", "https://127.0.0.1/"],
      ["0.0.0.0", "https://0.0.0.0/"],
    ])("A.7: rejects RPC_URL pointing at %s on mainnet", (host, url) => {
      const env = {
        NETWORK: "mainnet",
        RPC_URL: url,
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /RPC_URL points at .* but NETWORK=mainnet/,
      );
    });

    it("A.7: rejects RPC_URL on port 8899 on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        RPC_URL: "https://some-host.example.com:8899/",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /RPC_URL uses port 8899 \(Solana test validator\) but NETWORK=mainnet/,
      );
    });

    it("throws on URL that fails to parse", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "not a url at all",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow();
    });
  });

  // A2: NETWORK unset (or non-mainnet) — local URLs are fine when paired with ALLOW_INSECURE_RPC
  it("allows localhost when NETWORK is not mainnet (devnet/local dev)", () => {
    const env = {
      SOLANA_RPC_URL: "http://localhost:8899",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;
    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  // A.7: RPC_URL is unguarded outside mainnet — local dev should still work.
  it("A.7: allows RPC_URL=http://localhost:8899 when NETWORK=devnet", () => {
    const env = {
      NETWORK: "devnet",
      RPC_URL: "http://localhost:8899",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;
    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });
});
