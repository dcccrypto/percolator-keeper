import {
  collectDefaultMetrics,
  Registry,
  Counter,
  Gauge,
  Histogram,
} from "prom-client";

const registry = new Registry();

if (process.env.DRY_RUN === "true") {
  registry.setDefaultLabels({ dry_run: "true" });
}

export const txSentTotal = new Counter({
  name: "keeper_tx_sent_total",
  help: "Total transactions sent by the keeper, partitioned by result and type",
  labelNames: ["result", "type"] as const,
  registers: [registry],
});

export const solSpentLamportsTotal = new Counter({
  name: "keeper_sol_spent_lamports_total",
  help: "Total SOL spent in lamports, partitioned by transaction type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const jitoBundleFailCountTotal = new Counter({
  name: "keeper_jito_bundle_fail_count_total",
  help: "Total number of Jito bundle submission failures",
  registers: [registry],
});

export const oraclePushCountTotal = new Counter({
  name: "keeper_oracle_push_count_total",
  help: "Total oracle price pushes, partitioned by mint and source",
  labelNames: ["mint", "source"] as const,
  registers: [registry],
});

export const accountStreamEventTotal = new Counter({
  name: "keeper_account_stream_event_total",
  help: "Total account stream events received, partitioned by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const accountStreamDropTotal = new Counter({
  name: "keeper_account_stream_drop_total",
  help: "Total account stream events dropped due to backpressure or errors",
  registers: [registry],
});

export const walletBalanceSol = new Gauge({
  name: "keeper_wallet_balance_sol",
  help: "Current SOL balance of the keeper wallet",
  registers: [registry],
});

export const oracleStalenessSeconds = new Gauge({
  name: "keeper_oracle_staleness_seconds",
  help: "Seconds since the last oracle price push, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

export const slotDrift = new Gauge({
  name: "keeper_slot_drift",
  help: "Difference between the account stream slot and the RPC confirmed slot",
  registers: [registry],
});

export const activeMarketsCount = new Gauge({
  name: "keeper_active_markets_count",
  help: "Number of markets currently tracked by the keeper",
  registers: [registry],
});

export const roleGauge = new Gauge({
  name: "keeper_role",
  help: "Keeper HA role: 1 if leader, 0 if standby",
  registers: [registry],
});

export const budgetHalted = new Gauge({
  name: "keeper_budget_halted",
  help: "Budget circuit-breaker state: 1 if halted, 0 if normal",
  registers: [registry],
});

export const cycleDurationSeconds = new Histogram({
  name: "keeper_cycle_duration_seconds",
  help: "Duration of a keeper service cycle in seconds, partitioned by service",
  labelNames: ["service"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const txLandTimeSeconds = new Histogram({
  name: "keeper_tx_land_time_seconds",
  help: "Time from transaction submission to on-chain confirmation, partitioned by type and lane",
  labelNames: ["type", "lane"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const txSuccessRate = new Histogram({
  name: "keeper_tx_success_rate",
  help: "Rolling 60-second transaction success rate, partitioned by type",
  labelNames: ["type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const simulateCuUsed = new Histogram({
  name: "keeper_simulate_cu_used",
  help: "Simulated compute units consumed per transaction, partitioned by type",
  labelNames: ["type"] as const,
  buckets: [10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 1_400_000],
  registers: [registry],
});

// ── RPC pool metrics (Workstream G) ──────────────────────────────────────

export const rpcRequestTotal = new Counter({
  name: "keeper_rpc_request_total",
  help: "Total RPC requests routed by the pool, partitioned by provider, method, and result",
  labelNames: ["provider", "method", "result"] as const,
  registers: [registry],
});

export const rpcLatencyP50 = new Gauge({
  name: "keeper_rpc_latency_ms",
  help: "Rolling P50/P99 latency in ms for each RPC provider, updated on every health-check tick",
  labelNames: ["provider", "percentile"] as const,
  registers: [registry],
});

// P99 exported separately for direct set calls — the gauge name uses a label
// dimension "percentile" shared with rpcLatencyP50. Both resolve to the same
// registered gauge; callers set the "p50" / "p99" label value.
export const rpcLatencyP99 = rpcLatencyP50;

export const rpcProviderHealthy = new Gauge({
  name: "keeper_rpc_provider_healthy",
  help: "1 if the RPC provider is healthy, 0 if unhealthy",
  labelNames: ["provider"] as const,
  registers: [registry],
});

export const rpcFailoverTotal = new Counter({
  name: "keeper_rpc_failover_total",
  help: "Total RPC failover events, partitioned by from-provider, to-provider, and reason",
  labelNames: ["from", "to", "reason"] as const,
  registers: [registry],
});

export const rpcSlotLag = new Gauge({
  name: "keeper_rpc_slot_lag",
  help: "Slot lag for each provider vs the other provider (positive = behind, negative = ahead)",
  labelNames: ["provider"] as const,
  registers: [registry],
});

export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry, prefix: "nodejs_" });
}

export function getRegistry(): Registry {
  return registry;
}
