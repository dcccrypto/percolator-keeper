/**
 * Follow-up to #352. The bare `catch {}` that bypassed the oracle drift guard
 * is fixed; this covers the guard's own configuration, which could still
 * disable it silently.
 *
 * `BigInt(parseInt(env ?? "150", 10))` prefix-parses, so "0x10" became 0 —
 * `MAX_LIQUIDATION_DRIFT_BPS > 0n` false, guard off, no signal. The on-chain
 * Liquidate instruction carries no price bound, so that is the only mitigation
 * against submitting at a stale price.
 */
import { describe, it, expect } from "vitest";
import { resolveMaxLiquidationDriftBps } from "../../src/services/liquidation.js";
import { validateKeeperEnvGuards } from "../../src/env-guards.js";

describe("#352 follow-up — the drift guard cannot be silently disabled", () => {
  it("defaults to 150 bps when unset or empty", () => {
    expect(resolveMaxLiquidationDriftBps({})).toBe(150n);
    expect(resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "" })).toBe(150n);
  });

  it("parses a valid value", () => {
    expect(
      resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "300" }),
    ).toBe(300n);
  });

  it("REJECTS hex — it previously parsed to 0 and turned the guard OFF", () => {
    // The load-bearing case. parseInt("0x10", 10) stops at `x` -> 0.
    expect(() =>
      resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "0x10" }),
    ).toThrow(/LIQUIDATION_MAX_ORACLE_DRIFT_BPS/);
  });

  it("REJECTS exponent notation — it previously parsed to 1 bp", () => {
    expect(() =>
      resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "1e3" }),
    ).toThrow(/LIQUIDATION_MAX_ORACLE_DRIFT_BPS/);
  });

  it("REJECTS a value that can never trip — 100% is disabled in disguise", () => {
    expect(() =>
      resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "10001" }),
    ).toThrow(/can never trip/);
    expect(
      resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "10000" }),
    ).toBe(10_000n);
  });

  it("0 still disables it DELIBERATELY", () => {
    expect(resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "0" })).toBe(0n);
  });

  it("throws an ATTRIBUTED error instead of an unattributed BigInt(NaN) crash", () => {
    // Previously "abc" reached BigInt(NaN) at module top level, before
    // validateKeeperEnvGuards could run, so the message never named the var.
    for (const bad of ["abc", "-1", "150.5", "1_50", "Infinity"]) {
      expect(() =>
        resolveMaxLiquidationDriftBps({ LIQUIDATION_MAX_ORACLE_DRIFT_BPS: bad }),
      ).toThrow(/LIQUIDATION_MAX_ORACLE_DRIFT_BPS/);
    }
  });

  it("is validated at BOOT so a typo fails on a clean restart", () => {
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "0x10" }),
    ).toThrow(/LIQUIDATION_MAX_ORACLE_DRIFT_BPS/);
    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", LIQUIDATION_MAX_ORACLE_DRIFT_BPS: "150" }),
    ).not.toThrow();
  });
});
