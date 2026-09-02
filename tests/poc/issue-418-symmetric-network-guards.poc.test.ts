/**
 * PoC + regression guard for #418.
 *
 * Every RPC-host and program-id guard was one-directional — inside
 * `if (isMainnetEnv(env))` / `if (!opts.isMainnet) return`. So a keeper with
 * NETWORK=devnet (or unset) pointed at a mainnet RPC host and/or configured
 * with the mainnet program id discovered and signed against the LIVE program
 * with the LIVE key, and no guard fired.
 *
 * The realistic trigger is not an attack: copy a mainnet `.env`, flip NETWORK
 * to devnet, leave the RPC url and program id. That is one stale variable away
 * from a keeper the operator believes is on devnet mutating mainnet state.
 */
import { describe, it, expect } from "vitest";
import { validateKeeperEnvGuards } from "../../src/env-guards.js";
import { assertMainnetProgramId, MAINNET_PROGRAM_ID } from "../../src/lib/boot-assertions.js";

describe("#418 — network guards are symmetric", () => {
  it("refuses a mainnet RPC host when NETWORK is unset (devnet default)", () => {
    // The PoC from the issue. Fails on main: no symmetric guard, no throw.
    const env = { SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" } as NodeJS.ProcessEnv;
    expect(() => validateKeeperEnvGuards(env)).toThrow(/mainnet/i);
  });

  it("refuses a mainnet host on EVERY connection the keeper opens", () => {
    // Discovery and the liquidation retry path run on the fallback connection,
    // so guarding only SOLANA_RPC_URL would leave a live route open.
    for (const v of ["SOLANA_RPC_URL", "SOLANA_RPC_WS_URL", "FALLBACK_RPC_URL", "RPC_URL"]) {
      const scheme = v.includes("WS") ? "wss://" : "https://";
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "devnet", [v]: `${scheme}api.mainnet-beta.solana.com` }),
      ).toThrow(new RegExp(v));
    }
  });

  it("matches mainnet as a whole DNS label, including mainnet-beta and vendor hosts", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", RPC_URL: "https://x.mainnet.helius-rpc.com" }),
    ).toThrow(/mainnet/i);
  });

  it("does NOT reject a host that merely contains the substring", () => {
    // Label matching, not substring — otherwise a legitimate host like
    // `mainnetish.example.com` would be refused.
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", RPC_URL: "https://mainnetish.example.com" }),
    ).not.toThrow();
  });

  it("ORDERING: a malformed mainnet URL still reports the SCHEME problem", () => {
    // The symmetric guard is an `else` on the mainnet block, so it runs after
    // the https/wss checks. Pinned deliberately: if it were hoisted above them,
    // an http:// mainnet url would report a host-policy error and the scheme
    // rule would silently stop being the thing under test.
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", SOLANA_RPC_URL: "http://api.mainnet-beta.solana.com" }),
    ).toThrow(/https:\/\//);
  });

  it("a mainnet keeper is unaffected — the forward guards still apply", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "mainnet", SOLANA_RPC_URL: "https://api.devnet.solana.com" }),
    ).toThrow(/devnet\/testnet/);
  });

  it("PROGRAM ID is the definitive signal, and now guards both directions", () => {
    // An RPC host can be a proxy or a private endpoint whose name says nothing.
    // The program id is unambiguous about which chain's state is being mutated.
    expect(() =>
      assertMainnetProgramId({ isMainnet: false, programId: MAINNET_PROGRAM_ID }),
    ).toThrow(/canonical MAINNET program/);

    expect(() =>
      assertMainnetProgramId({ isMainnet: true, programId: MAINNET_PROGRAM_ID }),
    ).not.toThrow();
  });
});
