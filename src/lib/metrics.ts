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

// ── Workstream K: /metrics enrichment ────────────────────────────────────

// Priority fee gauge — label `tier` is the tx-type name ("crank", "liquidation",
// "oracle", "adl") because each tx type maps to exactly one configured percentile.
// Using the tx-type name rather than the raw percentile number makes dashboards
// readable without needing a legend that maps "p50" to "oracle".
// Emitted from priority-fee.ts on every successful estimate() call.
export const priorityFeeMicrolamports = new Gauge({
  name: "keeper_priority_fee_microlamports",
  help: "Most-recent priority fee estimate in microlamports, partitioned by account-set hash and tx-type tier",
  labelNames: ["accountSet_hash", "tier"] as const,
  registers: [registry],
});

// Counter — incremented on every estimate() call regardless of cache hit/miss.
// Wired in priority-fee.ts HeliusPriorityFeeEstimator.estimate().
export const priorityFeeEstimateTotal = new Counter({
  name: "keeper_priority_fee_estimate_total",
  help: "Total priority fee estimate() calls, partitioned by tier (tx type)",
  labelNames: ["tier"] as const,
  registers: [registry],
});

// The RAW estimate the fee RPC reported, before clamping. Paired with
// keeper_priority_fee_microlamports (which carries the value actually
// BROADCAST) so an operator can see the true market price even while the
// ceiling is binding — otherwise the broadcast gauge flatlines at the ceiling
// and cannot answer "is my ceiling too low?".
export const priorityFeeRawMicrolamports = new Gauge({
  name: "keeper_priority_fee_raw_microlamports",
  help: "Priority fee estimate as reported by the RPC, before the sanity ceiling",
  labelNames: ["tier"] as const,
  registers: [registry],
});

// Counts estimates clamped to PRIORITY_FEE_ESTIMATE_MAX. A non-zero rate means
// the fee RPC is reporting bids the keeper refuses to broadcast — alert on it:
// pre-clamp such a value would have latched the keeper-wide spend breaker (#350).
export const priorityFeeClampedTotal = new Counter({
  name: "keeper_priority_fee_clamped_total",
  help: "Total priority fee estimates clamped to the sanity ceiling, by tier",
  labelNames: ["tier"] as const,
  registers: [registry],
});

// Denominator for the clamp rate. keeper_priority_fee_estimate_total counts
// every estimate() CALL including cache hits, while a clamp can only happen on
// a cache MISS — so clamped/estimate_total understates the clamp fraction by
// the cache-hit multiplier (itself an env knob). Alert on
// rate(clamped_total) / rate(fetch_total) instead.
export const priorityFeeFetchTotal = new Counter({
  name: "keeper_priority_fee_fetch_total",
  help: "Priority fee estimate RPC fetches (cache misses), by tier",
  labelNames: ["tier"] as const,
  registers: [registry],
});

// Per-DEX-type UpdateHyperpMark instruction outcome counter.
// Wired in crank.ts crankMarket() HYPERP branch.
export const updateHyperpMarkTotal = new Counter({
  name: "keeper_update_hyperp_mark_total",
  help: "Total UpdateHyperpMark instructions attempted, partitioned by dex_type and result",
  labelNames: ["dex_type", "result"] as const,
  registers: [registry],
});

// Per-DEX-type CU histogram for UpdateHyperpMark instructions.
// Observed with simulatedCu from CuEstimator when simulation ran for that send.
// Wired in crank.ts crankMarket() HYPERP branch.
export const updateHyperpMarkCu = new Histogram({
  name: "keeper_update_hyperp_mark_cu",
  help: "Simulated compute units consumed by UpdateHyperpMark instructions, partitioned by dex_type",
  labelNames: ["dex_type"] as const,
  buckets: [10_000, 50_000, 100_000, 200_000, 300_000, 500_000, 800_000, 1_400_000],
  registers: [registry],
});

// ── Queue metrics (Workstream H) ──────────────────────────────────────────

export const txQueueWaitSeconds = new Histogram({
  name: "keeper_tx_queue_wait_seconds",
  help: "Time a transaction spends waiting in the priority queue before dispatch, partitioned by lane",
  labelNames: ["lane"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const txQueuePending = new Gauge({
  name: "keeper_tx_queue_pending",
  help: "Number of transactions waiting in the priority queue (not yet dispatched), partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueActive = new Gauge({
  name: "keeper_tx_queue_active",
  help: "Number of transactions currently being executed (dispatched but not yet resolved), partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueCompletedTotal = new Counter({
  name: "keeper_tx_queue_completed_total",
  help: "Total transactions that completed successfully through the priority queue, partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const txQueueFailedTotal = new Counter({
  name: "keeper_tx_queue_failed_total",
  help: "Total transactions that failed (threw) through the priority queue, partitioned by lane",
  labelNames: ["lane"] as const,
  registers: [registry],
});

// ── Workstream I: fraud-detection layer ──────────────────────────────────────

// Per-mint divergence gauge: |onchain_mark - offchain_consensus| / offchain * 10_000.
// Updated on every fraud-detector cycle regardless of whether the divergence
// exceeds the alert threshold — allows trend analysis in Grafana.
export const fraudDivergenceBps = new Gauge({
  name: "keeper_fraud_divergence_bps",
  help: "Absolute divergence in basis points between the on-chain EMA and the off-chain reference price, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// Incremented each time a divergence alert fires for a mint (after cooldown passes).
// Use rate() in Grafana to see alert frequency per mint.
export const fraudAlertTotal = new Counter({
  name: "keeper_fraud_alert_total",
  help: "Total fraud-detection divergence alerts fired, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// Incremented when the off-chain price is unavailable (null return, throw, or zero)
// for a market. A sustained count indicates a feed outage for that mint.
export const fraudOffchainUnavailableTotal = new Counter({
  name: "keeper_fraud_offchain_unavailable_total",
  help: "Total cycles where the off-chain price was unavailable for a market, partitioned by mint",
  labelNames: ["mint"] as const,
  registers: [registry],
});

// ── Workstream J: shadow-keeper observation harness ──────────────────────────

// Incremented on every decision the shadow keeper would have fired.
// Partitioned by txType so the operator can tell which crank type the shadow
// is most active on. Wired from decision-log.ts append().
export const shadowDecisionsTotal = new Counter({
  name: "keeper_shadow_decisions_total",
  help: "Total shadow-keeper decisions logged (would-have-fired), partitioned by txType",
  labelNames: ["txType"] as const,
  registers: [registry],
});

// Incremented on every compared decision/tx pair. result is one of:
//   "match"        — shadow decision matched a live tx
//   "live_only"    — live tx had no corresponding shadow decision
//   "shadow_only"  — shadow decision had no corresponding live tx
// Wired from shadow-harness.ts compare().
export const shadowMatchTotal = new Counter({
  name: "keeper_shadow_match_total",
  help: "Total shadow-keeper comparison outcomes, partitioned by txType and result",
  labelNames: ["txType", "result"] as const,
  registers: [registry],
});

// Updated after each comparison cycle. divergence_pct per txType computed
// independently: (live_only + shadow_only) / total * 100. Wired from
// shadow-harness.ts compare().
export const shadowDivergencePct = new Gauge({
  name: "keeper_shadow_divergence_pct",
  help: "Divergence percentage between shadow-keeper decision and live-keeper decision, partitioned by txType",
  labelNames: ["txType"] as const,
  registers: [registry],
});

// ─── v17 fee-split + backing-bucket-recovery crank ────────────────────────────
// These are what the runbook reads to answer "is the crank actually working?".
// The key pairing is attempts vs. atoms_moved (revenue legs) and lapsed vs.
// expired (the liveness leg): a leg attempting work but moving nothing, or a
// lapsed gauge that never returns to zero, is the failure mode that otherwise
// looks exactly like a healthy idle keeper.

export const feeCrankLegAttemptsTotal = new Counter({
  name: "keeper_fee_crank_leg_attempts_total",
  help: "Fee-crank transactions attempted, partitioned by leg (tags 78/84/87/89)",
  labelNames: ["leg"] as const,
  registers: [registry],
});

export const feeCrankLegSkippedTotal = new Counter({
  name: "keeper_fee_crank_leg_skipped_total",
  help: "Fee-crank legs that found no pending work (never sent a transaction), by leg",
  labelNames: ["leg"] as const,
  registers: [registry],
});

// Benign rejections are counted SEPARATELY from errors on purpose. Custom(19),
// Custom(21), Custom(27), Custom(38), Custom(41), Custom(53) and Custom(61) are
// by-design outcomes of a permissionless crank racing another keeper or hitting
// a mode gate. Folding them into the error counter would make a healthy keeper
// look like it was failing constantly and make the error rate useless as an alarm.
export const feeCrankLegBenignRejectsTotal = new Counter({
  name: "keeper_fee_crank_leg_benign_rejects_total",
  help: "Fee-crank sends rejected by design (mode gates, nothing-to-do, lost races), by leg and program error code",
  labelNames: ["leg", "code"] as const,
  registers: [registry],
});

export const feeCrankLegErrorsTotal = new Counter({
  name: "keeper_fee_crank_leg_errors_total",
  help: "Fee-crank genuine failures (unrecognised program errors, RPC faults), by leg and phase",
  labelNames: ["leg", "phase"] as const,
  registers: [registry],
});

export const feeCrankAtomsMovedTotal = new Counter({
  name: "keeper_fee_crank_atoms_moved_total",
  help: "Collateral atoms swept per fee leg per market (expected amount at send time; the program clamps and may partial-fill)",
  labelNames: ["leg", "market"] as const,
  registers: [registry],
});

export const feeCrankPendingClaimAtoms = new Gauge({
  name: "keeper_fee_crank_pending_claim_atoms",
  help: "Outstanding (accrued - withdrawn) atoms per fee leg per market. A monotonically rising value means the leg is not being cranked",
  labelNames: ["market", "leg"] as const,
  registers: [registry],
});

export const feeCrankBucketsExpiredTotal = new Counter({
  name: "keeper_fee_crank_buckets_expired_total",
  help: "Backing buckets recovered via tag 89 ExpireBackingBucket, by market",
  labelNames: ["market"] as const,
  registers: [registry],
});

// ⚠ ALARM ON THIS. A non-zero lapsed gauge that persists across cycles means
// domains are bricked right now: settling a loss fails Custom(21), settling a
// gain fails Custom(19), and top-up fails Custom(21). Losing accounts strand.
export const feeCrankBucketsLapsedGauge = new Gauge({
  name: "keeper_fee_crank_buckets_lapsed",
  help: "Backing buckets currently Fresh-and-lapsed (bricked domains awaiting tag 89), by market",
  labelNames: ["market"] as const,
  registers: [registry],
});

export const feeCrankBucketsLapsingSoonGauge = new Gauge({
  name: "keeper_fee_crank_buckets_lapsing_soon",
  help: "Backing buckets that will lapse within the warning horizon, by market. Leading indicator for tag 89 cadence",
  labelNames: ["market"] as const,
  registers: [registry],
});

export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: registry, prefix: "nodejs_" });
}

export function getRegistry(): Registry {
  return registry;
}
