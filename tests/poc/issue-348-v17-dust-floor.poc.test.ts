/**
 * PoC for #348 — MIN_LIQUIDATION_NOTIONAL was inert on the v17 path.
 *
 * The dust floor existed ONLY in `scanMarket` (the legacy v12 branch), so
 * `scanV17Portfolios` — the path that actually runs — ignored it and an
 * operator who configured the control got zero effect.
 *
 * The decision is exercised through the exported pure function the scanner
 * calls, because `scanV17Portfolios` is not exported. The CALL SITE is covered
 * separately in tests/services/liquidation.test.ts — #348 is itself a
 * "the check was never wired to the live path" bug, so a unit test of the
 * predicate alone would repeat the original failure mode.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isBelowLiquidationDustFloor,
  resolveMinLiquidationNotional,
} from "../../src/services/liquidation.js";
import { validateKeeperEnvGuards } from "../../src/env-guards.js";

describe("#348 — v17 liquidation dust floor", () => {
  it("skips a portfolio whose AGGREGATE notional is below the floor", () => {
    expect(isBelowLiquidationDustFloor(1_000n, true, 5_000n)).toBe(true);
  });

  it("keeps a portfolio at or above the floor, and pins the boundary", () => {
    expect(isBelowLiquidationDustFloor(10_000n, true, 5_000n)).toBe(false);
    expect(isBelowLiquidationDustFloor(5_000n, true, 5_000n)).toBe(false); // == is not below
    expect(isBelowLiquidationDustFloor(4_999n, true, 5_000n)).toBe(true);
  });

  it("is disabled by default — a floor of 0 is a strict no-op", () => {
    expect(isBelowLiquidationDustFloor(1n, true, 0n)).toBe(false);
    expect(isBelowLiquidationDustFloor(0n, true, 0n)).toBe(false);
    expect(isBelowLiquidationDustFloor(1n, true, -1n)).toBe(false);
  });

  it("NEVER skips when the notional is INCOMPLETE (#335.4 fail-closed)", () => {
    // evaluateV17PortfolioHealth reports an active leg whose price cannot be
    // resolved as liquidatable, treating a verification gap as a candidate
    // rather than risking a false "healthy". Its aggregate then UNDERSTATES
    // exposure, so filtering on it would convert that fail-closed check into a
    // fail-open one. This is the assertion that keeps the fix from becoming a
    // vulnerability in its own right.
    expect(isBelowLiquidationDustFloor(0n, false, 5_000n)).toBe(false);
    expect(isBelowLiquidationDustFloor(1n, false, 1_000_000_000n)).toBe(false);
  });

  it("uses the PORTFOLIO-WIDE notional, so a dust leg cannot shield a large one", () => {
    // The defect this signature exists to prevent: closeQ is only the FIRST
    // active leg. A 1-unit leg in slot 0 plus a large position in slot 1 would,
    // under a closeQ-based floor, be skipped forever — the dust leg persists,
    // so it is a permanent liquidation shield rather than a deferral.
    const dustFirstLeg = 1n;
    const largeSecondLeg = 5_000_000n;
    const aggregate = dustFirstLeg + largeSecondLeg;

    expect(isBelowLiquidationDustFloor(dustFirstLeg, true, 5_000n)).toBe(true); // the trap
    expect(isBelowLiquidationDustFloor(aggregate, true, 5_000n)).toBe(false); // what we do
  });

  it("does not overflow or lose precision at realistic magnitudes", () => {
    expect(isBelowLiquidationDustFloor(250_000_000_000_000n, true, 1_000_000n)).toBe(false);
  });

  describe("env parsing — the control must be configurable without a boot crash", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("defaults to 0 (disabled) when unset or empty", () => {
      expect(resolveMinLiquidationNotional({})).toBe(0n);
      expect(resolveMinLiquidationNotional({ MIN_LIQUIDATION_NOTIONAL: "" })).toBe(0n);
      expect(resolveMinLiquidationNotional({ MIN_LIQUIDATION_NOTIONAL: "   " })).toBe(0n);
    });

    it("parses a valid value", () => {
      expect(resolveMinLiquidationNotional({ MIN_LIQUIDATION_NOTIONAL: "5000000" })).toBe(
        5_000_000n,
      );
    });

    it("throws an ATTRIBUTED error on the forms an operator naturally reaches for", () => {
      // Previously these threw a bare `SyntaxError: Cannot convert 1.5 to a
      // BigInt` at module top level, before env-guards could run — so the
      // operator got a crash that never named the variable.
      for (const bad of ["1_000", "5e6", "1.5", "abc", "0x10 "]) {
        expect(() =>
          resolveMinLiquidationNotional({ MIN_LIQUIDATION_NOTIONAL: bad }),
        ).toThrow(/MIN_LIQUIDATION_NOTIONAL/);
      }
    });

    it("rejects a negative value rather than silently disabling the floor", () => {
      expect(() =>
        resolveMinLiquidationNotional({ MIN_LIQUIDATION_NOTIONAL: "-1" }),
      ).toThrow(/negative/);
    });

    it("is validated at BOOT, so a typo fails on a clean restart", () => {
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "devnet", MIN_LIQUIDATION_NOTIONAL: "1.5" }),
      ).toThrow(/MIN_LIQUIDATION_NOTIONAL/);
      expect(() =>
        validateKeeperEnvGuards({ NETWORK: "devnet", MIN_LIQUIDATION_NOTIONAL: "5000000" }),
      ).not.toThrow();
    });
  });
});
