/**
 * Boot guard for the #426 §5.1 per-tier priority-fee fallbacks.
 *
 * These envs feed estimatedCost in keeper-send, which the KeeperBudget circuit
 * breaker gates on — the same reason JITO_TIP_LAMPORTS is boot-validated.
 * parseBoundedIntEnv silently reverts a bad value to the default, so without a
 * boot guard a typo stays invisible until the fee RPC degrades.
 */
import { describe, it, expect } from "vitest";
import { validateKeeperEnvGuards } from "../../src/env-guards.js";
import { estimateLamportCost } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import {
  PRIORITY_FEE_ESTIMATE_CEILING_HARD_MAX,
  PRIORITY_FEE_FALLBACK_MAX,
  PRIORITY_FEE_FALLBACK_MIN,
} from "../../src/lib/priority-fee.js";

const BASE: NodeJS.ProcessEnv = { NETWORK: "devnet" };

describe("#426 §5.1 — priority-fee fallback envs are validated at boot", () => {
  it("accepts an unset value", () => {
    expect(() => validateKeeperEnvGuards({ ...BASE })).not.toThrow();
  });

  it("accepts a value inside the bounds", () => {
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION: "20000" }),
    ).not.toThrow();
  });

  it("rejects a value below the floor rather than silently reverting", () => {
    expect(() =>
      validateKeeperEnvGuards({
        ...BASE,
        KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION: String(PRIORITY_FEE_FALLBACK_MIN - 1),
      }),
    ).toThrow(/KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION/);
  });

  it("rejects a value above the ceiling", () => {
    expect(() =>
      validateKeeperEnvGuards({
        ...BASE,
        KEEPER_PRIORITY_FEE_FALLBACK_ADL: String(PRIORITY_FEE_FALLBACK_MAX + 1),
      }),
    ).toThrow(/KEEPER_PRIORITY_FEE_FALLBACK_ADL/);
  });

  it("rejects malformed values that Number() cannot parse cleanly", () => {
    for (const bad of ["abc", "5000abc", "5000.5", "Infinity", "-1"]) {
      expect(() =>
        validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: bad }),
      ).toThrow(/KEEPER_PRIORITY_FEE_FALLBACK_CRANK/);
    }
  });

  it("rejects/accepts at the LITERAL boundary — not merely the imported constant", () => {
    // Deliberately literal: asserting against PRIORITY_FEE_FALLBACK_MIN alone
    // would still pass if someone lowered the floor to 1, since the assertion
    // would move with it.
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: "999" }),
    ).toThrow(/KEEPER_PRIORITY_FEE_FALLBACK_CRANK/);
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: "1000" }),
    ).not.toThrow();
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: "1000000" }),
    ).not.toThrow();
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: "1000001" }),
    ).toThrow(/KEEPER_PRIORITY_FEE_FALLBACK_CRANK/);
  });

  it("treats an empty string as unset", () => {
    expect(() =>
      validateKeeperEnvGuards({ ...BASE, KEEPER_PRIORITY_FEE_FALLBACK_CRANK: "" }),
    ).not.toThrow();
  });

  it("validates the #350 estimate ceiling at the LITERAL boundary too", () => {
    const V = "KEEPER_PRIORITY_FEE_ESTIMATE_MAX_MICROLAMPORTS";
    // Floor is the fallback FLOOR (1_000), not the fallback ceiling — an
    // operator must be able to tighten a safety bound, only raising is capped.
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "999" })).toThrow(
      new RegExp(V),
    );
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "1000000" })).not.toThrow();
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "10000000" })).not.toThrow();
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "20000000" })).not.toThrow();
    // Above the hard max it walks back toward the single-send keeper-wide halt.
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "20000001" })).toThrow(
      new RegExp(V),
    );
    for (const bad of ["abc", "2000000.5", "-1", "Infinity"]) {
      expect(() => validateKeeperEnvGuards({ ...BASE, [V]: bad })).toThrow(new RegExp(V));
    }
    expect(() => validateKeeperEnvGuards({ ...BASE, [V]: "" })).not.toThrow();
  });

  it("the ceiling's hard max cannot itself latch the breaker on one send", () => {
    // Uses the REAL cost formula and the REAL budget default, not a local
    // re-implementation — otherwise lowering maxSolPerCycle or raising the CU
    // fallback (exactly the changes this guards) would leave it passing.
    const MAX_CU = 1_540_000; // 1.4M cap x 1.1 sim margin
    const JITO = 200_000;
    const worstCase = estimateLamportCost(
      PRIORITY_FEE_ESTIMATE_CEILING_HARD_MAX,
      MAX_CU,
      JITO,
      0,
    );
    const budget = new KeeperBudget({}, { env: {} });
    expect(budget.canSpend(worstCase, "liquidation")).toBe(true);
    expect(budget.isHalted()).toBe(false);
  });

  it("REFUSES a ceiling below the largest configured fallback", () => {
    // The degraded path would otherwise bid MORE than the healthy path's cap.
    expect(() =>
      validateKeeperEnvGuards({
        ...BASE,
        KEEPER_PRIORITY_FEE_ESTIMATE_MAX_MICROLAMPORTS: "2000",
      }),
    ).toThrow(/below the largest configured per-tier fallback/);

    // ...but the same tight ceiling is fine once the fallbacks are lowered to match.
    expect(() =>
      validateKeeperEnvGuards({
        ...BASE,
        KEEPER_PRIORITY_FEE_ESTIMATE_MAX_MICROLAMPORTS: "2000",
        KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION: "2000",
        KEEPER_PRIORITY_FEE_FALLBACK_ADL: "2000",
      }),
    ).not.toThrow();
  });

  it("an operator may TIGHTEN the ceiling — the safety-increasing direction", () => {
    expect(() =>
      validateKeeperEnvGuards({
        ...BASE,
        KEEPER_PRIORITY_FEE_ESTIMATE_MAX_MICROLAMPORTS: "200000",
      }),
    ).not.toThrow();
  });

  it("covers all four tiers", () => {
    for (const name of [
      "KEEPER_PRIORITY_FEE_FALLBACK_LIQUIDATION",
      "KEEPER_PRIORITY_FEE_FALLBACK_ADL",
      "KEEPER_PRIORITY_FEE_FALLBACK_CRANK",
      "KEEPER_PRIORITY_FEE_FALLBACK_ORACLE",
    ]) {
      expect(() => validateKeeperEnvGuards({ ...BASE, [name]: "0" })).toThrow(
        new RegExp(name),
      );
    }
  });
});
