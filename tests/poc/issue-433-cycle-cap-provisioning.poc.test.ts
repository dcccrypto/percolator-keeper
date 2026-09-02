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

/** A budget on a controllable clock, so cycle windows can be rolled. */
function budgetOnClock(cfg = {}) {
  let t = 1_000_000;
  const budget = new KeeperBudget(cfg, { env: {}, now: () => t });
  return { budget, advance: (ms: number) => { t += ms; } };
}

describe("#433 — the cycle cap must admit one legitimate provisioning tx", () => {
  it("the rent alone exceeded the OLD cap on both clusters", () => {
    expect(MAINNET_RENT).toBe(65_946_000);
    expect(MAINNET_RENT).toBeGreaterThan(OLD_CAP);
    expect(DEVNET_RENT).toBeGreaterThan(OLD_CAP); // measured via RPC, not derived
  });

  it("REGRESSION: the old behaviour refused the first send AND latched", () => {
    // Both halves of #433: the cap was too small for one legitimate tx, and
    // breaching it latched. Either alone is survivable; together they made
    // discovering a market a keeper-wide outage.
    const cost = estimateLamportCost(1_000, 1_400_000, 0, MAINNET_RENT);
    expect(cost).toBeGreaterThan(OLD_CAP);
  });

  it("N provisionings in ONE window defer instead of halting", () => {
    // The residual the raise alone did NOT fix. `discover()` fires an unawaited
    // ensureKeeperPortfolio per new market, market creation is permissionless,
    // and there is no per-cycle provisioning limiter — so N markets appearing
    // together produce N sends in one window. Under a LATCHING cycle cap the
    // 4th of them stopped every lane; now the surplus simply waits.
    const perProvision = estimateLamportCost(1_000, 1_400_000, 200_000, MAINNET_RENT);
    const budget = freshBudget();

    let admitted = 0;
    for (let i = 0; i < 10; i++) {
      if (budget.canSpend(perProvision, "crank")) {
        budget.recordTx(perProvision, "crank", "success");
        admitted++;
      }
    }

    expect(admitted).toBeGreaterThanOrEqual(2); // the cap admits real work...
    expect(admitted).toBeLessThan(10); // ...and still bounds the burst
    expect(budget.isHalted()).toBe(false); // but never latches
    // A liquidation on another lane is unaffected — this was the DoS.
    expect(budget.canSpend(estimateLamportCost(5_000, 200_000, 0, 0), "liquidation")).toBe(
      true,
    );
  });

  it("the shipped default admits a provisioning transaction", () => {
    // MIN_VIABLE excludes the priority fee deliberately: no ceiling on the
    // Helius estimate is enforced on this branch, so folding one in would
    // assert a bound the code does not provide. It is rent + tip + a
    // two-signature base fee.
    expect(MIN_VIABLE_CYCLE_CAP_LAMPORTS).toBe(10_000 + 200_000 + MAINNET_RENT);

    // estimateLamportCost charges a flat 5_000 base fee regardless of signature
    // count, so its figure for this two-signer tx is 5_000 BELOW the true cost —
    // which is why the constant uses 10_000 and stays conservative.
    const asCosted = estimateLamportCost(1_000, 1_400_000, 200_000, MAINNET_RENT);
    expect(asCosted).toBeLessThan(MIN_VIABLE_CYCLE_CAP_LAMPORTS + 5_000);

    const budget = freshBudget();
    expect(budget.canSpend(asCosted, "crank")).toBe(true);
    expect(budget.isHalted()).toBe(false);
  });

  it("the default cap is not silently shrunk below one viable transaction", () => {
    // Pins the invariant itself, so lowering the default fails CI rather than
    // rediscovering #433 on the next market.
    expect(freshBudget().config.maxSolPerCycle).toBeGreaterThan(
      MIN_VIABLE_CYCLE_CAP_LAMPORTS,
    );
  });

  it("pins the cycle-cap boundary exactly", () => {
    const cap = freshBudget().config.maxSolPerCycle;
    expect(freshBudget().canSpend(cap, "crank")).toBe(true);
    const over = freshBudget();
    expect(over.canSpend(cap + 1, "crank")).toBe(false);
    expect(over.isHalted()).toBe(false); // refused, not latched
  });

  it("SUSTAINED spend still latches — the anomaly detector is intact", () => {
    // The drain bound is the hour cap's, and it did not move. Spend has to
    // accumulate across windows to trip it, which is the shape of a real
    // runaway rather than one large legitimate transaction.
    const { budget, advance } = budgetOnClock();
    const perWindow = budget.config.maxSolPerCycle;
    for (let i = 0; i < 3; i++) {
      budget.recordTx(perWindow, "crank", "success");
      advance(30_000); // roll the cycle window; the hour sum persists
    }

    expect(budget.canSpend(1, "crank")).toBe(false);
    expect(budget.isHalted()).toBe(true);
    expect(budget.haltKind).toBe("hour-spend-cap");
    expect(budget.config.maxSolPerHour).toBe(500_000_000); // unchanged by #433
  });

  it("MIN_VIABLE tracks the account length — bumping it cannot go unnoticed", () => {
    // Ties the constant to its source. A larger portfolio raises the rent, and
    // the floor must move with it or the boot guard silently under-provisions.
    const rent = (128 + 9347) * 3480 * 2;
    expect(MIN_VIABLE_CYCLE_CAP_LAMPORTS).toBe(10_000 + 200_000 + rent);
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
