import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DASHBOARD_PATH = resolve(__dirname, "../../dashboards/keeper.json");

// The full set of metric names introduced by Workstream K that must appear in
// at least one panel target expression. Panels for H/I/J stubs are included so
// the test will catch regressions if someone removes the placeholder panels.
const REQUIRED_METRIC_NAMES = [
  // Wired in K
  "keeper_priority_fee_microlamports",
  "keeper_priority_fee_estimate_total",
  "keeper_update_hyperp_mark_total",
  "keeper_update_hyperp_mark_cu",
  // Stub for H
  "keeper_tx_queue_wait_seconds",
  // Stub for I
  "keeper_fraud_divergence_bps",
  // Stub for J
  "keeper_shadow_divergence_pct",
  // From Workstream G (must still be present)
  "keeper_rpc_provider_healthy",
  "keeper_rpc_failover_total",
];

describe("dashboards/keeper.json smoke tests", () => {
  let dashboard: Record<string, unknown>;
  let allExpressions: string[];

  it("parses as valid JSON", () => {
    const raw = readFileSync(DASHBOARD_PATH, "utf-8");
    expect(() => {
      dashboard = JSON.parse(raw) as Record<string, unknown>;
    }).not.toThrow();
    expect(dashboard).toBeTruthy();
  });

  it("has required top-level fields", () => {
    const raw = readFileSync(DASHBOARD_PATH, "utf-8");
    dashboard = JSON.parse(raw) as Record<string, unknown>;
    expect(dashboard).toHaveProperty("panels");
    expect(dashboard).toHaveProperty("title");
    expect(dashboard).toHaveProperty("uid");
    expect(Array.isArray(dashboard.panels)).toBe(true);
  });

  it("each new K metric name appears in at least one panel target expression", () => {
    const raw = readFileSync(DASHBOARD_PATH, "utf-8");
    dashboard = JSON.parse(raw) as Record<string, unknown>;

    // Collect all `expr` strings from all panel targets, including nested rows.
    const expressions: string[] = [];
    const panels = dashboard.panels as Array<Record<string, unknown>>;

    function collectExprs(panelList: Array<Record<string, unknown>>): void {
      for (const panel of panelList) {
        const targets = panel.targets as Array<Record<string, unknown>> | undefined;
        if (targets) {
          for (const t of targets) {
            if (typeof t.expr === "string") expressions.push(t.expr);
          }
        }
        const subPanels = panel.panels as Array<Record<string, unknown>> | undefined;
        if (subPanels) collectExprs(subPanels);
      }
    }

    collectExprs(panels);
    allExpressions = expressions;

    for (const metricName of REQUIRED_METRIC_NAMES) {
      const found = allExpressions.some((expr) => expr.includes(metricName));
      expect(found, `Missing metric "${metricName}" in any panel target expression`).toBe(true);
    }
  });

  it("panel IDs are unique", () => {
    const raw = readFileSync(DASHBOARD_PATH, "utf-8");
    dashboard = JSON.parse(raw) as Record<string, unknown>;
    const panels = dashboard.panels as Array<Record<string, unknown>>;
    const ids = panels.map((p) => p.id as number);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all panel types are one of the declared __requires types", () => {
    const raw = readFileSync(DASHBOARD_PATH, "utf-8");
    dashboard = JSON.parse(raw) as Record<string, unknown>;
    const requires = dashboard.__requires as Array<{ type: string; id: string }>;
    const panelTypeIds = new Set(
      requires.filter((r) => r.type === "panel").map((r) => r.id),
    );
    // Add "row" — it is a built-in Grafana type not listed in __requires
    panelTypeIds.add("row");

    const panels = dashboard.panels as Array<Record<string, unknown>>;
    for (const panel of panels) {
      const type = panel.type as string;
      expect(panelTypeIds.has(type), `Unknown panel type "${type}" — add to __requires`).toBe(true);
    }
  });
});
