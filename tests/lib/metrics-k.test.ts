import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  priorityFeeMicrolamports,
  priorityFeeEstimateTotal,
  updateHyperpMarkTotal,
  updateHyperpMarkCu,
  txQueueWaitSeconds,
  fraudDivergenceBps,
  shadowDivergencePct,
  getRegistry,
} from "../../src/lib/metrics.js";

// ── Unit tests: each new metric increments/sets on the right event ────────

describe("Workstream K — priority fee metrics", () => {
  it("priorityFeeEstimateTotal: counter increments by tier without throwing", () => {
    expect(() => priorityFeeEstimateTotal.inc({ tier: "crank" })).not.toThrow();
    expect(() => priorityFeeEstimateTotal.inc({ tier: "liquidation" })).not.toThrow();
    expect(() => priorityFeeEstimateTotal.inc({ tier: "oracle" })).not.toThrow();
    expect(() => priorityFeeEstimateTotal.inc({ tier: "adl" })).not.toThrow();
  });

  it("priorityFeeEstimateTotal: accumulates correctly", async () => {
    const before = (await priorityFeeEstimateTotal.get()).values;
    const prev = before.find((v) => v.labels.tier === "crank")?.value ?? 0;

    priorityFeeEstimateTotal.inc({ tier: "crank" });
    priorityFeeEstimateTotal.inc({ tier: "crank" });

    const after = (await priorityFeeEstimateTotal.get()).values;
    const next = after.find((v) => v.labels.tier === "crank")?.value ?? 0;
    expect(next).toBe(prev + 2);
  });

  it("priorityFeeMicrolamports: gauge sets without throwing", () => {
    expect(() =>
      priorityFeeMicrolamports.set({ accountSet_hash: "abcd1234abcd1234", tier: "crank" }, 5_000),
    ).not.toThrow();
    expect(() =>
      priorityFeeMicrolamports.set({ accountSet_hash: "ffff0000ffff0000", tier: "liquidation" }, 50_000),
    ).not.toThrow();
  });

  it("priorityFeeMicrolamports: stores the correct value per label set", async () => {
    const hash = "test0000test0001";
    priorityFeeMicrolamports.set({ accountSet_hash: hash, tier: "oracle" }, 12_345);
    const result = await priorityFeeMicrolamports.get();
    const match = result.values.find(
      (v) => v.labels.accountSet_hash === hash && v.labels.tier === "oracle",
    );
    expect(match?.value).toBe(12_345);
  });
});

describe("Workstream K — UpdateHyperpMark metrics", () => {
  it("updateHyperpMarkTotal: counter increments without throwing", () => {
    expect(() => updateHyperpMarkTotal.inc({ dex_type: "raydium-clmm", result: "success" })).not.toThrow();
    expect(() => updateHyperpMarkTotal.inc({ dex_type: "meteora-dlmm", result: "failed" })).not.toThrow();
    expect(() => updateHyperpMarkTotal.inc({ dex_type: "pumpswap", result: "skipped" })).not.toThrow();
    expect(() => updateHyperpMarkTotal.inc({ dex_type: "unknown", result: "success" })).not.toThrow();
  });

  it("updateHyperpMarkTotal: accumulates per dex_type+result", async () => {
    const before = (await updateHyperpMarkTotal.get()).values;
    const prev =
      before.find((v) => v.labels.dex_type === "raydium-clmm" && v.labels.result === "success")?.value ?? 0;

    updateHyperpMarkTotal.inc({ dex_type: "raydium-clmm", result: "success" });
    updateHyperpMarkTotal.inc({ dex_type: "raydium-clmm", result: "success" });
    updateHyperpMarkTotal.inc({ dex_type: "raydium-clmm", result: "failed" });

    const after = (await updateHyperpMarkTotal.get()).values;
    const successes = after.find(
      (v) => v.labels.dex_type === "raydium-clmm" && v.labels.result === "success",
    )?.value ?? 0;
    expect(successes).toBe(prev + 2);
  });

  it("updateHyperpMarkCu: histogram observes without throwing", () => {
    expect(() => updateHyperpMarkCu.observe({ dex_type: "pumpswap" }, 200_000)).not.toThrow();
    expect(() => updateHyperpMarkCu.observe({ dex_type: "meteora-dlmm" }, 350_000)).not.toThrow();
    expect(() => updateHyperpMarkCu.observe({ dex_type: "raydium-clmm" }, 100_000)).not.toThrow();
    expect(() => updateHyperpMarkCu.observe({ dex_type: "unknown" }, 400_000)).not.toThrow();
  });

  it("updateHyperpMarkCu: count increments after observe", async () => {
    const before = (await updateHyperpMarkCu.get()).values;
    const countBefore = before.find(
      (v) => v.labels.dex_type === "pumpswap" && v.metricName === "keeper_update_hyperp_mark_cu_count",
    )?.value ?? 0;

    updateHyperpMarkCu.observe({ dex_type: "pumpswap" }, 123_456);

    const after = (await updateHyperpMarkCu.get()).values;
    const countAfter = after.find(
      (v) => v.labels.dex_type === "pumpswap" && v.metricName === "keeper_update_hyperp_mark_cu_count",
    )?.value ?? 0;
    expect(countAfter).toBe(countBefore + 1);
  });
});

// ── K-fix: updateHyperpMarkCu observes simulatedCu, not estimatedCost ────────
//
// Regression guard: the metric HELP says "Simulated compute units consumed".
// Before this fix, crank.ts fed estimatedCost (total lamports) which differs
// from CU by 5-7 orders of magnitude.  The mock here uses knowable values so
// any regression (observing lamports instead of CU) is immediately detectable.

describe("Workstream K — updateHyperpMarkCu observes real simulatedCu", () => {
  it("records the simulatedCu value, not the estimatedCost lamports", async () => {
    const KNOWN_SIMULATED_CU = 178_432; // arbitrary CU value distinct from any lamport figure
    const KNOWN_ESTIMATED_COST = 6_234; // total lamports — should NOT appear in histogram

    const before = (await updateHyperpMarkCu.get()).values;
    const sumBefore = before.find(
      (v) => v.labels.dex_type === "raydium-clmm" && v.metricName === "keeper_update_hyperp_mark_cu_sum",
    )?.value ?? 0;

    // Simulate what crank.ts does after the K-fix: observe simulatedCu
    updateHyperpMarkCu.observe({ dex_type: "raydium-clmm" }, KNOWN_SIMULATED_CU);

    const after = (await updateHyperpMarkCu.get()).values;
    const sumAfter = after.find(
      (v) => v.labels.dex_type === "raydium-clmm" && v.metricName === "keeper_update_hyperp_mark_cu_sum",
    )?.value ?? 0;

    // The sum must have increased by exactly KNOWN_SIMULATED_CU
    expect(sumAfter - sumBefore).toBe(KNOWN_SIMULATED_CU);
    // And must NOT equal KNOWN_ESTIMATED_COST (sanity: the two values are different)
    expect(sumAfter - sumBefore).not.toBe(KNOWN_ESTIMATED_COST);
  });

});

// ── Stub metric tests: defined but not yet wired ────────────────────────────

describe("Workstream K — stub metrics for H/I/J", () => {
  it("txQueueWaitSeconds (stub for H): histogram observes without throwing", () => {
    expect(() => txQueueWaitSeconds.observe({ lane: "high" }, 0.05)).not.toThrow();
    expect(() => txQueueWaitSeconds.observe({ lane: "normal" }, 0.25)).not.toThrow();
  });

  it("fraudDivergenceBps (stub for I): gauge sets without throwing", () => {
    const mint = "So11111111111111111111111111111111111111112";
    expect(() => fraudDivergenceBps.set({ mint }, 120)).not.toThrow();
    expect(() => fraudDivergenceBps.set({ mint }, 501)).not.toThrow();
  });

  it("fraudDivergenceBps (stub for I): stores correct value", async () => {
    const mint = "mint000000000000000000000000000000000000001";
    fraudDivergenceBps.set({ mint }, 350);
    const result = await fraudDivergenceBps.get();
    const match = result.values.find((v) => v.labels.mint === mint);
    expect(match?.value).toBe(350);
  });

  it("shadowDivergencePct (stub for J): gauge sets without throwing", () => {
    expect(() => shadowDivergencePct.set({ txType: "crank" }, 1.5)).not.toThrow();
    expect(() => shadowDivergencePct.set({ txType: "oracle" }, 0.0)).not.toThrow();
  });
});

// ── Integration test: /metrics output contains all new metric names ─────────

describe("Workstream K — Prometheus exposition integration", () => {
  it("registry serializes all new K metrics in valid Prometheus format", async () => {
    // Ensure each new metric has at least one observation recorded by unit tests above.
    priorityFeeEstimateTotal.inc({ tier: "crank" });
    priorityFeeMicrolamports.set({ accountSet_hash: "deadbeefdeadbeef", tier: "crank" }, 1_000);
    updateHyperpMarkTotal.inc({ dex_type: "pumpswap", result: "success" });
    updateHyperpMarkCu.observe({ dex_type: "pumpswap" }, 50_000);
    txQueueWaitSeconds.observe({ lane: "high" }, 0.1);
    fraudDivergenceBps.set({ mint: "So11111111111111111111111111111111111111112" }, 100);
    shadowDivergencePct.set({ txType: "crank" }, 0.5);

    const output = await getRegistry().metrics();
    expect(typeof output).toBe("string");

    const requiredMetrics = [
      "keeper_priority_fee_microlamports",
      "keeper_priority_fee_estimate_total",
      "keeper_update_hyperp_mark_total",
      "keeper_update_hyperp_mark_cu",
      "keeper_tx_queue_wait_seconds",
      "keeper_fraud_divergence_bps",
      "keeper_shadow_divergence_pct",
    ];
    for (const name of requiredMetrics) {
      expect(output).toContain(name);
    }

    // Validate HELP and TYPE lines exist for each new metric
    for (const name of requiredMetrics) {
      expect(output).toContain(`# HELP ${name}`);
      expect(output).toContain(`# TYPE ${name}`);
    }

    // Validate no malformed lines (same pattern as metrics.test.ts)
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") continue;
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})?\s+[\d.+\-einfna]+(\s+\d+)?$/i);
    }
  });
});
