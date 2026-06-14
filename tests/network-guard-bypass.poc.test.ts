/**
 * Regression for the mainnet boot-guard bypass (HIGH) — was the PoC that proved it.
 *
 * Root cause: three+ independent NETWORK readers disagreed — isMainnet() and the
 * env guards used an exact `=== "mainnet"` while CURRENT_NETWORK (and the HA lock
 * key / send path) normalized. A value like "Mainnet" / " mainnet " was treated as
 * mainnet by the resolver but not by the guards, silently disabling the
 * wrong-program-id assertion and the local-RPC rejection.
 *
 * Fix: a single canonical resolver (src/network.ts) backs every check. These tests
 * lock in that all readers now agree, and that unrecognized values fail fast.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { isMainnet } from "../src/config/network.js";
import { assertMainnetProgramId, MAINNET_PROGRAM_ID } from "../src/lib/boot-assertions.js";
import { validateKeeperEnvGuards } from "../src/env-guards.js";
import { isMainnetNetwork } from "../src/network.js";

const ORIGINAL_NETWORK = process.env.NETWORK;

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.NETWORK;
  else process.env.NETWORK = ORIGINAL_NETWORK;
  vi.resetModules();
});

// Values that MEAN mainnet but aren't the exact lowercase string.
const MAINNET_VARIANTS = ["mainnet", "Mainnet", "MAINNET", " mainnet ", "mainnet "];
const NON_MAINNET = [undefined, "", "devnet", "Devnet", "DEVNET", " devnet ", "testnet"];

describe("regression: all NETWORK readers agree via the canonical resolver", () => {
  it("isMainnet() and CURRENT_NETWORK both classify case/whitespace variants as mainnet", async () => {
    for (const value of MAINNET_VARIANTS) {
      process.env.NETWORK = value;
      expect(isMainnet(), `isMainnet() for ${JSON.stringify(value)}`).toBe(true);
      expect(isMainnetNetwork(value)).toBe(true);

      vi.resetModules();
      const { CURRENT_NETWORK } = await import("../src/network.js");
      expect(CURRENT_NETWORK, `CURRENT_NETWORK for ${JSON.stringify(value)}`).toBe("mainnet");
    }
  });

  it("non-mainnet values are never treated as mainnet", () => {
    for (const value of NON_MAINNET) {
      if (value === undefined) delete process.env.NETWORK;
      else process.env.NETWORK = value;
      expect(isMainnet(), `isMainnet() for ${JSON.stringify(value)}`).toBe(false);
      expect(isMainnetNetwork(value)).toBe(false);
    }
  });

  it("FIXED: with NETWORK='Mainnet', a wrong program id now refuses to boot", () => {
    process.env.NETWORK = "Mainnet";
    const wrongProgramId = "WrongProg1111111111111111111111111111111111";
    expect(wrongProgramId).not.toBe(MAINNET_PROGRAM_ID);

    // Wired exactly as index.ts:47 — the guard now engages because isMainnet() is true.
    expect(() =>
      assertMainnetProgramId({ isMainnet: isMainnet(), programId: wrongProgramId }),
    ).toThrow(/Refusing to boot/i);
  });

  it("FIXED: with NETWORK='Mainnet' (and ' mainnet '), a localhost RPC now refuses to boot", () => {
    // Use https:// so the http-scheme guard is not in play; the localhost guard
    // ("refusing to boot") fires independently. ALLOW_INSECURE_RPC is omitted
    // because H9 now blocks that flag on mainnet entirely — both are refusals,
    // but the localhost guard's "refusing to boot" message is what this test asserts.
    const base = { SOLANA_RPC_URL: "https://127.0.0.1:8899" } as NodeJS.ProcessEnv;
    for (const net of ["Mainnet", " mainnet ", "MAINNET"]) {
      expect(() => validateKeeperEnvGuards({ ...base, NETWORK: net }), `NETWORK=${JSON.stringify(net)}`).toThrow(
        /refusing to boot/i,
      );
    }
  });

  it("still allows localhost on devnet / local dev", () => {
    const base = { SOLANA_RPC_URL: "http://127.0.0.1:8899", ALLOW_INSECURE_RPC: "true" } as NodeJS.ProcessEnv;
    expect(() => validateKeeperEnvGuards({ ...base, NETWORK: "devnet" })).not.toThrow();
    expect(() => validateKeeperEnvGuards({ ...base })).not.toThrow(); // unset → devnet
  });

  it("fails fast on an unrecognized NETWORK value (typo) instead of silently using devnet", () => {
    expect(() => validateKeeperEnvGuards({ NETWORK: "mainnnet" } as NodeJS.ProcessEnv)).toThrow(
      /not a recognized network/i,
    );
  });
});
