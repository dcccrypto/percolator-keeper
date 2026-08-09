import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
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

  it("allows insecure URLs when ALLOW_INSECURE_RPC=true (non-mainnet)", () => {
    const env = {
      SOLANA_RPC_URL: "http://localhost:8899",
      SOLANA_RPC_WS_URL: "ws://localhost:8900",
      ALLOW_INSECURE_RPC: "true",
    } as NodeJS.ProcessEnv;

    expect(() => validateKeeperEnvGuards(env)).not.toThrow();
  });

  // H9: ALLOW_INSECURE_RPC=true on mainnet exposes signed txs to MITM.
  describe("H9: ALLOW_INSECURE_RPC=true rejected on mainnet", () => {
    it("throws when ALLOW_INSECURE_RPC=true with NETWORK=mainnet", () => {
      const env = {
        SOLANA_RPC_URL: "http://some-rpc.helius.xyz",
        ALLOW_INSECURE_RPC: "true",
        NETWORK: "mainnet",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /ALLOW_INSECURE_RPC.*not permitted.*mainnet/i,
      );
    });

    it("throws when ALLOW_INSECURE_RPC=true with NETWORK=mainnet (via network.ts normalization)", () => {
      const env = {
        ALLOW_INSECURE_RPC: "true",
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://mainnet.rpc.example.com",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /ALLOW_INSECURE_RPC.*not permitted.*mainnet/i,
      );
    });

    it("allows ALLOW_INSECURE_RPC=true on devnet", () => {
      const env = {
        ALLOW_INSECURE_RPC: "true",
        NETWORK: "devnet",
        SOLANA_RPC_URL: "http://localhost:8899",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });
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
      // Real mainnet RPC URLs so A.2 + A.7 mainnet guards don't trip.
      const env = {
        HA_ENABLED: "true",
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        SOLANA_RPC_WS_URL: "wss://api.mainnet-beta.solana.com",
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        RPC_URL: "https://api.mainnet-beta.solana.com",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
        KEEPER_REDIS_TOKEN: "fake-token",
        DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
        USE_HELIUS_SENDER: "true",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("accepts HA_ENABLED=true + NETWORK=devnet", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
        KEEPER_REDIS_TOKEN: "fake-token",
      } as NodeJS.ProcessEnv;
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

  // C-1 (CRITICAL): HA_ENABLED=true with KEEPER_REDIS_URL unset silently fell
  // back to standalone-leader mode in index.ts (only a logger.warn, no
  // throw), so every replica in a multi-replica deployment believed it was
  // the sole leader simultaneously — duplicate liquidations/cranks
  // (split-brain) with no boot-time signal.
  describe("C-1: HA_ENABLED requires KEEPER_REDIS_URL + KEEPER_REDIS_TOKEN", () => {
    it("throws when HA_ENABLED=true and KEEPER_REDIS_URL is unset", () => {
      const env = { HA_ENABLED: "true", NETWORK: "devnet" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*requires.*KEEPER_REDIS_URL/i,
      );
    });

    it("throws when HA_ENABLED=true and KEEPER_REDIS_URL is empty string", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*requires.*KEEPER_REDIS_URL/i,
      );
    });

    it("throws when HA_ENABLED=true and KEEPER_REDIS_URL is whitespace-only", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "   ",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*requires.*KEEPER_REDIS_URL/i,
      );
    });

    it("throws when HA_ENABLED=true, KEEPER_REDIS_URL is set, but KEEPER_REDIS_TOKEN is unset", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*KEEPER_REDIS_URL.*KEEPER_REDIS_TOKEN/i,
      );
    });

    it("throws when HA_ENABLED=true, KEEPER_REDIS_URL is set, but KEEPER_REDIS_TOKEN is empty string", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
        KEEPER_REDIS_TOKEN: "",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*KEEPER_REDIS_URL.*KEEPER_REDIS_TOKEN/i,
      );
    });

    it("throws when HA_ENABLED=true and KEEPER_REDIS_TOKEN is whitespace-only", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
        KEEPER_REDIS_TOKEN: "   ",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /HA_ENABLED.*KEEPER_REDIS_URL.*KEEPER_REDIS_TOKEN/i,
      );
    });

    it("accepts HA_ENABLED=true with both KEEPER_REDIS_URL and KEEPER_REDIS_TOKEN set", () => {
      const env = {
        HA_ENABLED: "true",
        NETWORK: "devnet",
        KEEPER_REDIS_URL: "https://fake-host.upstash.io",
        KEEPER_REDIS_TOKEN: "fake-token",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("does NOT require KEEPER_REDIS_URL/KEEPER_REDIS_TOKEN when HA_ENABLED is unset", () => {
      expect(() => validateKeeperEnvGuards({} as NodeJS.ProcessEnv)).not.toThrow();
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "testnet" } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it("does NOT require KEEPER_REDIS_URL/KEEPER_REDIS_TOKEN when HA_ENABLED=false", () => {
      const env = { HA_ENABLED: "false" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });
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

    it("rejects mainnet+localhost regardless of ALLOW_INSECURE_RPC (separate guard)", () => {
      // H9 blocks ALLOW_INSECURE_RPC=true on mainnet entirely; the localhost guard
      // independently fires when ALLOW_INSECURE_RPC is absent. Both paths reject.
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://localhost:8899",
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
        DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
        USE_HELIUS_SENDER: "true",
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

  // ─── M1: CRANK_KEYPAIR parseability validation at boot ──────────────────
  describe("M1: CRANK_KEYPAIR parseability", () => {
    // A real, generated keypair — JSON-array form, which is the format
    // operators typically paste into env vars from `solana-keygen new --outfile`.
    const VALID_KEYPAIR_JSON = JSON.stringify(
      Array.from(Keypair.generate().secretKey),
    );

    it("M1: throws when CRANK_KEYPAIR is a truncated JSON array", () => {
      const env = { CRANK_KEYPAIR: "[1, 2, 3]" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /CRANK_KEYPAIR is not a valid keypair/,
      );
    });

    it("M1: throws when CRANK_KEYPAIR is malformed JSON (unparseable)", () => {
      const env = { CRANK_KEYPAIR: "[not, valid, json" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /CRANK_KEYPAIR is not a valid keypair/,
      );
    });

    it("M1: throws when CRANK_KEYPAIR is a garbage base58 string", () => {
      const env = { CRANK_KEYPAIR: "not-a-valid-base58-secret-!!!" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /CRANK_KEYPAIR is not a valid keypair/,
      );
    });

    it("M1: accepts a well-formed 64-byte JSON array keypair", () => {
      const env = { CRANK_KEYPAIR: VALID_KEYPAIR_JSON } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("M1: does NOT require CRANK_KEYPAIR to be set (presence is enforced in index.ts)", () => {
      // env-guards only validates parseability if CRANK_KEYPAIR is set.
      // Boot-time presence is enforced at src/index.ts:33 before this runs.
      const env = {} as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });
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

  // A8: mainnet must not silently fall back to devnet RPC. @percolatorct/shared
  // defaults an unset FALLBACK_RPC_URL to api.devnet.solana.com, and the keeper
  // runs all market discovery + liquidation retry on the fallback connection.
  describe("A8: mainnet devnet/testnet RPC guard", () => {
    const MAINNET = "https://mainnet.helius-rpc.com/?api-key=test";

    it("throws when FALLBACK_RPC_URL is unset on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /FALLBACK_RPC_URL must be set to a mainnet RPC endpoint/,
      );
    });

    it("throws when FALLBACK_RPC_URL is whitespace-only on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "   ",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /FALLBACK_RPC_URL must be set to a mainnet RPC endpoint/,
      );
    });

    it.each([
      ["FALLBACK_RPC_URL", "https://api.devnet.solana.com"],
      ["FALLBACK_RPC_URL", "https://devnet.helius-rpc.com/?api-key=test"],
      ["FALLBACK_RPC_URL", "https://api.testnet.solana.com"],
      ["SOLANA_RPC_URL", "https://api.devnet.solana.com"],
      ["RPC_URL", "https://api.testnet.solana.com"],
    ])("rejects %s pointing at a devnet/testnet host on mainnet", (varName, url) => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        [varName]: url,
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        new RegExp(`${varName} points at devnet/testnet host`),
      );
    });

    it("accepts a complete mainnet env with an explicit mainnet FALLBACK_RPC_URL", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        SOLANA_RPC_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=test",
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        RPC_URL: MAINNET,
        DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
        USE_HELIUS_SENDER: "true",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    // Label-anchored, not substring: a mainnet host that merely contains the
    // text "devnet" inside a label is NOT a false positive.
    it("does not reject a mainnet host containing 'devnet' as a substring", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://my-devnet-migration.example.com",
        RPC_URL: "https://my-devnet-migration.example.com",
        FALLBACK_RPC_URL: "https://my-devnet-migration.example.com",
        DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
        USE_HELIUS_SENDER: "true",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    // The guard is independent of ALLOW_INSECURE_RPC (H9 blocks ALLOW_INSECURE_RPC=true
    // on mainnet entirely; this test verifies the devnet-host guard fires on its own).
    it("rejects a devnet fallback on mainnet (guard is independent of ALLOW_INSECURE_RPC)", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.devnet.solana.com",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /FALLBACK_RPC_URL points at devnet\/testnet host/,
      );
    });

    it("does NOT require FALLBACK_RPC_URL off mainnet (devnet/unset)", () => {
      expect(() => validateKeeperEnvGuards({ NETWORK: "devnet" } as NodeJS.ProcessEnv)).not.toThrow();
      expect(() => validateKeeperEnvGuards({} as NodeJS.ProcessEnv)).not.toThrow();
    });

    it("allows a devnet FALLBACK_RPC_URL when NETWORK=devnet", () => {
      const env = {
        NETWORK: "devnet",
        FALLBACK_RPC_URL: "https://api.devnet.solana.com",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });
  });

  // H-7 (HIGH): @percolatorct/shared's sendAlert() silently no-ops (logger.debug,
  // no throw, no fallback channel) when DISCORD_ALERT_WEBHOOK is unset. Every
  // sendCriticalAlert/sendWarningAlert/sendInfoAlert call in the keeper --
  // including conservation-invariant violations and budget circuit-breaker trips
  // -- would fire and vanish with zero operator-visible signal on mainnet.
  describe("H-7: DISCORD_ALERT_WEBHOOK required on mainnet", () => {
    const MAINNET = "https://mainnet.helius-rpc.com/?api-key=test";

    it("throws when DISCORD_ALERT_WEBHOOK is unset on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /DISCORD_ALERT_WEBHOOK must be set.*NETWORK=mainnet/i,
      );
    });

    it("throws when DISCORD_ALERT_WEBHOOK is empty string on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        DISCORD_ALERT_WEBHOOK: "",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /DISCORD_ALERT_WEBHOOK must be set/i,
      );
    });

    it("throws when DISCORD_ALERT_WEBHOOK is whitespace-only on mainnet", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        DISCORD_ALERT_WEBHOOK: "   ",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /DISCORD_ALERT_WEBHOOK must be set/i,
      );
    });

    it("accepts a complete mainnet env with DISCORD_ALERT_WEBHOOK set", () => {
      const env = {
        NETWORK: "mainnet",
        SOLANA_RPC_URL: MAINNET,
        SOLANA_RPC_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=test",
        RPC_URL: MAINNET,
        FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
        DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
        USE_HELIUS_SENDER: "true",
      } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("does NOT require DISCORD_ALERT_WEBHOOK off mainnet (devnet/unset)", () => {
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "devnet" } as NodeJS.ProcessEnv),
      ).not.toThrow();
      expect(() => validateKeeperEnvGuards({} as NodeJS.ProcessEnv)).not.toThrow();
    });
  });

  // BUG-101: keeper-send.ts's isMainnetSender() is a literal `=== "true"` check
  // with no NETWORK-based default -- unset silently degrades to a public,
  // unprotected sendRawTransaction broadcast on mainnet.
  describe("BUG-101: USE_HELIUS_SENDER required on mainnet", () => {
    const MAINNET = "https://mainnet.helius-rpc.com/?api-key=test";
    const baseMainnetEnv = {
      NETWORK: "mainnet",
      SOLANA_RPC_URL: MAINNET,
      RPC_URL: MAINNET,
      FALLBACK_RPC_URL: "https://api.mainnet-beta.solana.com",
      DISCORD_ALERT_WEBHOOK: "https://discord.com/api/webhooks/123/abc",
    };

    it("throws when USE_HELIUS_SENDER is unset on mainnet", () => {
      const env = { ...baseMainnetEnv } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /USE_HELIUS_SENDER must be set to 'true'.*NETWORK=mainnet/i,
      );
    });

    it("throws when USE_HELIUS_SENDER=false on mainnet", () => {
      const env = { ...baseMainnetEnv, USE_HELIUS_SENDER: "false" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /USE_HELIUS_SENDER must be set to 'true'/i,
      );
    });

    it("throws when USE_HELIUS_SENDER is an arbitrary non-'true' string on mainnet", () => {
      const env = { ...baseMainnetEnv, USE_HELIUS_SENDER: "1" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).toThrow(
        /USE_HELIUS_SENDER must be set to 'true'/i,
      );
    });

    it("accepts USE_HELIUS_SENDER=true on mainnet", () => {
      const env = { ...baseMainnetEnv, USE_HELIUS_SENDER: "true" } as NodeJS.ProcessEnv;
      expect(() => validateKeeperEnvGuards(env)).not.toThrow();
    });

    it("does NOT require USE_HELIUS_SENDER off mainnet (devnet/unset)", () => {
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "devnet" } as NodeJS.ProcessEnv),
      ).not.toThrow();
      expect(() => validateKeeperEnvGuards({} as NodeJS.ProcessEnv)).not.toThrow();
    });
  });

  // A malformed JITO_TIP_LAMPORTS makes the tx-cost estimate NaN, which slips
  // the budget circuit breaker's cap checks. Reject it at boot.
  it("throws on non-numeric JITO_TIP_LAMPORTS", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", JITO_TIP_LAMPORTS: "abc" } as NodeJS.ProcessEnv),
    ).toThrow(/JITO_TIP_LAMPORTS/);
  });

  it("throws on negative JITO_TIP_LAMPORTS", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", JITO_TIP_LAMPORTS: "-1" } as NodeJS.ProcessEnv),
    ).toThrow(/JITO_TIP_LAMPORTS/);
  });

  it("throws on non-integer / trailing-garbage JITO_TIP_LAMPORTS (e.g. 200000abc)", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", JITO_TIP_LAMPORTS: "200000abc" } as NodeJS.ProcessEnv),
    ).toThrow(/JITO_TIP_LAMPORTS/);
  });

  it("accepts a valid integer JITO_TIP_LAMPORTS and accepts unset", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", JITO_TIP_LAMPORTS: "200000" } as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
