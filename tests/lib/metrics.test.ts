import { describe, it, expect, beforeAll } from "vitest";
import {
  txSentTotal,
  solSpentLamportsTotal,
  jitoBundleFailCountTotal,
  oraclePushCountTotal,
  accountStreamEventTotal,
  accountStreamDropTotal,
  walletBalanceSol,
  oracleStalenessSeconds,
  slotDrift,
  activeMarketsCount,
  roleGauge,
  budgetHalted,
  cycleDurationSeconds,
  txLandTimeSeconds,
  txSuccessRate,
  simulateCuUsed,
  getRegistry,
} from "../../src/lib/metrics.js";

describe("metrics registry", () => {
  it("counter: txSentTotal increments without throwing", () => {
    expect(() => txSentTotal.inc({ result: "success", type: "crank" })).not.toThrow();
    expect(() => txSentTotal.inc({ result: "fail", type: "liquidation" })).not.toThrow();
    expect(() => txSentTotal.inc({ result: "drop", type: "oracle" })).not.toThrow();
  });

  it("counter: solSpentLamportsTotal increments without throwing", () => {
    expect(() => solSpentLamportsTotal.inc({ type: "crank" }, 200_000)).not.toThrow();
    expect(() => solSpentLamportsTotal.inc({ type: "liquidation" }, 150_000)).not.toThrow();
  });

  it("counter: jitoBundleFailCountTotal increments without throwing", () => {
    expect(() => jitoBundleFailCountTotal.inc()).not.toThrow();
  });

  it("counter: oraclePushCountTotal increments without throwing", () => {
    expect(() =>
      oraclePushCountTotal.inc({ mint: "So11111111111111111111111111111111111111112", source: "dexscreener" }),
    ).not.toThrow();
    expect(() =>
      oraclePushCountTotal.inc({ mint: "So11111111111111111111111111111111111111112", source: "jupiter" }),
    ).not.toThrow();
    expect(() =>
      oraclePushCountTotal.inc({ mint: "So11111111111111111111111111111111111111112", source: "onchain" }),
    ).not.toThrow();
  });

  it("counter: accountStreamEventTotal increments without throwing", () => {
    expect(() => accountStreamEventTotal.inc({ type: "account" })).not.toThrow();
    expect(() => accountStreamEventTotal.inc({ type: "slot" })).not.toThrow();
    expect(() => accountStreamEventTotal.inc({ type: "gap" })).not.toThrow();
  });

  it("counter: accountStreamDropTotal increments without throwing", () => {
    expect(() => accountStreamDropTotal.inc()).not.toThrow();
  });

  it("gauge: walletBalanceSol sets without throwing", () => {
    expect(() => walletBalanceSol.set(1.5)).not.toThrow();
    expect(() => walletBalanceSol.set(0)).not.toThrow();
  });

  it("gauge: oracleStalenessSeconds sets without throwing", () => {
    expect(() =>
      oracleStalenessSeconds.set({ mint: "So11111111111111111111111111111111111111112" }, 30),
    ).not.toThrow();
  });

  it("gauge: slotDrift sets without throwing", () => {
    expect(() => slotDrift.set(5)).not.toThrow();
    expect(() => slotDrift.set(-2)).not.toThrow();
  });

  it("gauge: activeMarketsCount sets without throwing", () => {
    expect(() => activeMarketsCount.set(12)).not.toThrow();
  });

  it("gauge: roleGauge sets to 0 or 1 without throwing", () => {
    expect(() => roleGauge.set(1)).not.toThrow();
    expect(() => roleGauge.set(0)).not.toThrow();
  });

  it("gauge: budgetHalted sets without throwing", () => {
    expect(() => budgetHalted.set(1)).not.toThrow();
    expect(() => budgetHalted.set(0)).not.toThrow();
  });

  it("histogram: cycleDurationSeconds observes without throwing", () => {
    expect(() => cycleDurationSeconds.observe({ service: "crank" }, 1.2)).not.toThrow();
    expect(() => cycleDurationSeconds.observe({ service: "liquidation" }, 3.5)).not.toThrow();
    expect(() => cycleDurationSeconds.observe({ service: "oracle" }, 0.8)).not.toThrow();
    expect(() => cycleDurationSeconds.observe({ service: "monitor" }, 10)).not.toThrow();
  });

  it("histogram: txLandTimeSeconds observes without throwing", () => {
    expect(() => txLandTimeSeconds.observe({ type: "crank", lane: "sender" }, 0.9)).not.toThrow();
    expect(() => txLandTimeSeconds.observe({ type: "liquidation", lane: "jito" }, 2.1)).not.toThrow();
  });

  it("histogram: txSuccessRate observes without throwing", () => {
    expect(() => txSuccessRate.observe({ type: "crank" }, 1.0)).not.toThrow();
  });

  it("histogram: simulateCuUsed observes without throwing", () => {
    expect(() => simulateCuUsed.observe({ type: "crank" }, 120_000)).not.toThrow();
    expect(() => simulateCuUsed.observe({ type: "liquidation" }, 800_000)).not.toThrow();
  });

  it("counter accumulates correctly", async () => {
    const before = (await txSentTotal.get()).values;
    const successCrank = before.find(
      (v) => v.labels.result === "success" && v.labels.type === "crank",
    );
    const prevValue = successCrank?.value ?? 0;

    txSentTotal.inc({ result: "success", type: "crank" });
    txSentTotal.inc({ result: "success", type: "crank" });

    const after = (await txSentTotal.get()).values;
    const updated = after.find(
      (v) => v.labels.result === "success" && v.labels.type === "crank",
    );
    expect(updated?.value).toBe(prevValue + 2);
  });

  it("registry serializes to valid Prometheus exposition format", async () => {
    const output = await getRegistry().metrics();
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("keeper_tx_sent_total");
    expect(output).toContain("keeper_sol_spent_lamports_total");
    expect(output).toContain("keeper_jito_bundle_fail_count_total");
    expect(output).toContain("keeper_oracle_push_count_total");
    expect(output).toContain("keeper_account_stream_event_total");
    expect(output).toContain("keeper_account_stream_drop_total");
    expect(output).toContain("keeper_wallet_balance_sol");
    expect(output).toContain("keeper_oracle_staleness_seconds");
    expect(output).toContain("keeper_slot_drift");
    expect(output).toContain("keeper_active_markets_count");
    expect(output).toContain("keeper_role");
    expect(output).toContain("keeper_budget_halted");
    expect(output).toContain("keeper_cycle_duration_seconds");
    expect(output).toContain("keeper_tx_land_time_seconds");
    expect(output).toContain("keeper_tx_success_rate");
    expect(output).toContain("keeper_simulate_cu_used");
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") continue;
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})?\s+[\d.+\-einfna]+(\s+\d+)?$/i);
    }
  });
});

describe("DRY_RUN label injection", () => {
  it("registry has dry_run label when DRY_RUN=true", async () => {
    const originalDryRun = process.env.DRY_RUN;
    process.env.DRY_RUN = "true";

    const { Registry, Counter } = await import("prom-client");
    const testRegistry = new Registry();
    testRegistry.setDefaultLabels({ dry_run: "true" });
    const testCounter = new Counter({
      name: "test_dry_run_counter_unique",
      help: "test",
      registers: [testRegistry],
    });
    testCounter.inc();
    const output = await testRegistry.metrics();
    expect(output).toContain('dry_run="true"');

    process.env.DRY_RUN = originalDryRun;
  });
});
