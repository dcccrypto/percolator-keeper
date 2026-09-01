/**
 * PoC + regression guard for #433.
 *
 * `provisionKeeperPortfolio` passes the v17 portfolio rent to `keeperSend` as
 * `extraLamports`, and `estimateLamportCost` is
 * `base + fee + jitoTip + extraLamports` — so the rent lands in the value
 * `canSpend` gates on. The rent alone (65_946_000 mainnet / 60_005_175 devnet)
 * exceeded the old 50_000_000 cycle cap, so `_cycleSpend + lamports > cap` was
 * true on the FIRST send of a cycle with `_cycleSpend === 0`: a latching,
 * manual-resume, keeper-wide halt with nothing actually overspent, triggered by
 * discovering a new market.
 */
import { describe, it, expect } from "vitest";
import { estimateLamportCost } from "../../src/lib/keeper-send.js";
import { KeeperBudget, MIN_VIABLE_CYCLE_CAP_LAMPORTS } from "../../src/lib/budget.js";
import { validateKeeperEnvGuards } from "../../src/env-guards.js";

const MAINNET_RENT = (128 + 9347) * 3480 * 2; // 65_946_000
const DEVNET_RENT = 60_005_175;
const OLD_CAP = 50_000_000;

/** No halt-state path, so this cannot touch real keeper state. */
const freshBudget = (cfg = {}) => new KeeperBudget(cfg, { env: {} });

describe("#433 — the cycle cap must admit one legitimate provisioning tx", () => {
  it("the rent alone exceeded the OLD cap on both clusters", () => {
    expect(MAINNET_RENT).toBe(65_946_000);
    expect(MAINNET_RENT).toBeGreaterThan(OLD_CAP);
    expect(DEVNET_RENT).toBeGreaterThan(OLD_CAP);
  });

  it("REGRESSION: the old cap latched a keeper-wide halt on the first send", () => {
    const cost = estimateLamportCost(1_000, 1_400_000, 0, MAINNET_RENT);
    const budget = freshBudget({ maxSolPerCycle: OLD_CAP });

    expect(budget.canSpend(cost, "crank")).toBe(false);
    expect(budget.isHalted()).toBe(true);
    expect(budget.haltKind).toBe("cycle-spend-cap");

    // ...and it took every other lane with it.
    budget.resume("poc");
    const budget2 = freshBudget({ maxSolPerCycle: OLD_CAP });
    budget2.canSpend(cost, "crank");
    expect(budget2.canSpend(estimateLamportCost(5_000, 200_000, 0, 0), "liquidation")).toBe(
      false,
    );
  });

  it("the shipped default admits provisioning at the WORST case", () => {
    // Worst case: the #350 fee ceiling, the CU ceiling, and the mainnet tip.
    const worst = estimateLamportCost(10_000_000, 1_540_000, 200_000, MAINNET_RENT);
    expect(worst).toBe(MIN_VIABLE_CYCLE_CAP_LAMPORTS);

    const budget = freshBudget();
    expect(budget.canSpend(worst, "crank")).toBe(true);
    expect(budget.isHalted()).toBe(false);
  });

  it("the default cap is not silently shrunk below one viable transaction", () => {
    // Pins the invariant itself, so lowering the default fails CI rather than
    // rediscovering #433 on the next market.
    expect(freshBudget().config.maxSolPerCycle).toBeGreaterThan(
      MIN_VIABLE_CYCLE_CAP_LAMPORTS,
    );
  });

  it("still latches on a genuinely runaway single transaction", () => {
    // Raising the cap must not disarm the breaker.
    const budget = freshBudget();
    expect(budget.canSpend(500_000_000, "crank")).toBe(false);
    expect(budget.haltKind).toBe("cycle-spend-cap");
  });

  it("the total drain bound is UNCHANGED — the hour cap still governs", () => {
    // The point of raising only the per-cycle figure: sustained spend still
    // latches at the same place it did before.
    const budget = freshBudget();
    expect(budget.config.maxSolPerHour).toBe(500_000_000);
  });

  it("an operator cannot configure a cap below one viable transaction", () => {
    expect(() =>
      validateKeeperEnvGuards({
        NETWORK: "devnet",
        KEEPER_MAX_SOL_PER_CYCLE: String(MIN_VIABLE_CYCLE_CAP_LAMPORTS - 1),
      }),
    ).toThrow(/KEEPER_MAX_SOL_PER_CYCLE/);

    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", KEEPER_MAX_SOL_PER_CYCLE: "50000000" }),
    ).toThrow(/latches a keeper-wide halt/);

    expect(() =>
      validateKeeperEnvGuards({ NETWORK: "devnet", KEEPER_MAX_SOL_PER_CYCLE: "200000000" }),
    ).not.toThrow();
  });
});
