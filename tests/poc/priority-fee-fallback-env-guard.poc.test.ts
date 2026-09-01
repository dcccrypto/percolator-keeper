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
import {
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
