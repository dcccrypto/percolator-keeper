/**
 * RpcPool — provider redundancy layer for keeper read operations.
 *
 * Wraps two @solana/web3.js Connection instances (Helius primary, Alchemy
 * secondary). Read calls route to Helius while it is healthy; Alchemy only
 * when Helius is unhealthy. Writes always go to the caller's Helius Connection
 * (unaffected by this pool — keeperSend is write-path and stays untouched).
 *
 * Design choices:
 * - No racing/fan-out: one provider is chosen per call; the other is idle.
 * - getProgramAccounts always routes to Alchemy when RPC_FORCE_ALCHEMY_GPA=true
 *   because it is a heavy method that puts significant load on Helius primary.
 * - Fail-safe: both providers unhealthy → reads still go to Helius (degraded
 *   primary beats zero primary).
 * - start() launches the health-check timer; stop() clears it. This lets tests
 *   control lifecycle without relying on global timers.
 */

import { Connection } from "@solana/web3.js";
import type {
  PublicKey,
  AccountInfo,
  ParsedAccountData,
  SignatureStatus,
  BlockhashWithExpiryBlockHeight,
  GetProgramAccountsFilter,
} from "@solana/web3.js";
import { createLogger, sendWarningAlert } from "@percolatorct/shared";
import { RpcProviderHealth } from "./rpc-health.js";
import {
  rpcRequestTotal,
  rpcLatencyP50,
  rpcLatencyP99,
  rpcProviderHealthy,
  rpcFailoverTotal,
  rpcSlotLag,
} from "./metrics.js";
import type { RpcPoolConfig } from "../config/rpc.js";
import { parseRpcPoolConfig } from "../config/rpc.js";

const logger = createLogger("keeper:rpc-pool");

export type ProviderName = "helius" | "alchemy";

export interface RpcPoolDeps {
  config?: RpcPoolConfig;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Thin read-method interface exposed by the pool. Mirrors the subset of
 * Connection methods that the keeper uses for reads. Callers cast to this
 * interface rather than the full Connection type, making the pool's contract
 * explicit without subclassing Connection.
 */
export interface RpcReadInterface {
  getSlot(commitment?: string): Promise<number>;
  getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null>;
  getMultipleAccountsInfo(pubkeys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>>;
  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: Array<SignatureStatus | null> }>;
  getProgramAccounts(
    programId: PublicKey,
    filters?: GetProgramAccountsFilter[],
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Buffer | ParsedAccountData> }>>;
  getLatestBlockhash(commitment?: string): Promise<BlockhashWithExpiryBlockHeight>;
}

export class RpcPool {
  private readonly _config: RpcPoolConfig;
  private readonly _helius: Connection;
  private readonly _alchemy: Connection;
  private readonly _heliusHealth: RpcProviderHealth;
  private readonly _alchemyHealth: RpcProviderHealth;
  private readonly _now: () => number;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _failoverCount = 0;

  // Tracks the active provider for reads to detect transitions.
  private _activeProvider: ProviderName = "helius";

  constructor(
    helius: Connection,
    alchemy: Connection,
    deps: RpcPoolDeps = {},
  ) {
    this._helius = helius;
    this._alchemy = alchemy;
    this._now = deps.now ?? (() => Date.now());

    const cfg = deps.config ?? parseRpcPoolConfig(deps.env ?? process.env);
    this._config = cfg;

    const healthCfg = {
      windowMs: 60_000,
      unhealthyP99Ms: cfg.unhealthyP99Ms,
      unhealthySlotLag: cfg.unhealthySlotLag,
      unhealthyConsecutiveFails: cfg.unhealthyConsecutiveFails,
      recoveryWindowMs: cfg.recoveryWindowMs,
      // Recovery thresholds from spec: P99 < 1000ms AND slot lag < 10.
      recoveryP99Ms: 1_000,
      recoverySlotLag: 10,
    };

    this._heliusHealth = new RpcProviderHealth("helius", healthCfg, this._now);
    this._alchemyHealth = new RpcProviderHealth("alchemy", healthCfg, this._now);

    // Initialise Prometheus gauges to healthy (1).
    rpcProviderHealthy.set({ provider: "helius" }, 1);
    rpcProviderHealthy.set({ provider: "alchemy" }, 1);
  }

  /** Launch background health-check timer. Safe to call multiple times (no-op after first). */
  start(): void {
    if (this._timer !== null) return;
    if (!this._config.enabled) {
      logger.warn("RPC pool disabled — always routing reads to Helius");
      return;
    }
    this._timer = setInterval(() => {
      void this._healthTick();
    }, this._config.healthCheckIntervalMs);
    // Allow Node.js to exit even if the timer is still running.
    if (this._timer.unref) this._timer.unref();
    logger.warn("RPC pool started", {
      helius: this._config.helius.url.replace(/\/v2\/.*/i, "/v2/<redacted>"),
      alchemy: this._config.alchemy.url.replace(/\/v2\/.*/i, "/v2/<redacted>"),
      healthCheckIntervalMs: this._config.healthCheckIntervalMs,
    });
  }

  /** Stop the health-check timer. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Route a read method to the appropriate provider.
   * Returns the provider name chosen — useful for callers that need to log provenance.
   */
  pickProvider(method: string): ProviderName {
    if (!this._config.enabled) return "helius";

    // getProgramAccounts is heavy; prefer Alchemy when the override is set.
    // If Alchemy is unhealthy, fall back to Helius (degraded but operational).
    if (method === "getProgramAccounts" && this._config.forceAlchemyGpa) {
      if (this._alchemyHealth.isHealthy) {
        return "alchemy";
      }
      // Alchemy unhealthy — bump observable counter and fall through to Helius.
      rpcFailoverTotal.inc({ from: "alchemy", to: "helius", reason: "gpa_alchemy_unhealthy" });
      return "helius";
    }

    const heliusOk = this._heliusHealth.isHealthy;
    const alchemyOk = this._alchemyHealth.isHealthy;

    if (heliusOk) return "helius";
    if (alchemyOk) return "alchemy";

    // Fail-safe: both unhealthy → degrade to Helius.
    return "helius";
  }

  private _connectionFor(provider: ProviderName): Connection {
    return provider === "helius" ? this._helius : this._alchemy;
  }

  /** Execute a read on the routed provider, recording metrics. */
  private async _read<T>(
    method: string,
    fn: (conn: Connection) => Promise<T>,
  ): Promise<T> {
    const provider = this.pickProvider(method);
    const conn = this._connectionFor(provider);
    const start = this._now();

    try {
      const result = await fn(conn);
      const latencyMs = this._now() - start;
      rpcRequestTotal.inc({ provider, method, result: "ok" });

      // Record latency sample in the health tracker for non-GPA methods
      // (GPA is always Alchemy — recording its latency to Alchemy's tracker is correct).
      if (provider === "helius") {
        this._heliusHealth.recordSuccess(latencyMs);
      } else {
        this._alchemyHealth.recordSuccess(latencyMs);
      }

      return result;
    } catch (err) {
      const latencyMs = this._now() - start;
      const isTimeout = latencyMs > this._config.unhealthyP99Ms;
      rpcRequestTotal.inc({ provider, method, result: isTimeout ? "timeout" : "fail" });

      if (provider === "helius") {
        this._heliusHealth.recordFailure();
      } else {
        this._alchemyHealth.recordFailure();
      }

      throw err;
    }
  }

  // ── Public read interface ─────────────────────────────────────────────────

  async getSlot(commitment?: string): Promise<number> {
    return this._read("getSlot", (c) =>
      commitment ? c.getSlot(commitment as Parameters<Connection["getSlot"]>[0]) : c.getSlot(),
    );
  }

  async getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return this._read("getAccountInfo", (c) => c.getAccountInfo(pubkey));
  }

  async getMultipleAccountsInfo(
    pubkeys: PublicKey[],
  ): Promise<Array<AccountInfo<Buffer> | null>> {
    return this._read("getMultipleAccountsInfo", (c) => c.getMultipleAccountsInfo(pubkeys));
  }

  async getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: Array<SignatureStatus | null> }> {
    return this._read("getSignatureStatuses", (c) => c.getSignatureStatuses(signatures));
  }

  async getProgramAccounts(
    programId: PublicKey,
    filters?: GetProgramAccountsFilter[],
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Buffer | ParsedAccountData> }>> {
    const result = await this._read("getProgramAccounts", (c) =>
      filters ? c.getProgramAccounts(programId, { filters }) : c.getProgramAccounts(programId),
    );
    // The web3.js return type is readonly; callers expect a mutable array, so spread a copy.
    return [...result];
  }

  async getLatestBlockhash(
    commitment?: string,
  ): Promise<BlockhashWithExpiryBlockHeight> {
    return this._read("getLatestBlockhash", (c) =>
      commitment
        ? c.getLatestBlockhash(commitment as Parameters<Connection["getLatestBlockhash"]>[0])
        : c.getLatestBlockhash(),
    );
  }

  /**
   * Write passthrough — always Helius Connection, never pooled.
   * Exposed on the pool object so callers can get the write Connection
   * without importing a separate module. Writes are unaffected by health state.
   */
  get writeConnection(): Connection {
    return this._helius;
  }

  /** Expose health snapshots for metrics + tests. */
  get heliusHealth(): RpcProviderHealth {
    return this._heliusHealth;
  }

  get alchemyHealth(): RpcProviderHealth {
    return this._alchemyHealth;
  }

  get failoverCount(): number {
    return this._failoverCount;
  }

  // ── Health-check tick ─────────────────────────────────────────────────────

  private async _healthTick(): Promise<void> {
    await Promise.all([
      this._probeProvider("helius"),
      this._probeProvider("alchemy"),
    ]);
    this._evaluateAndTransition();
  }

  private async _probeProvider(provider: ProviderName): Promise<void> {
    const conn = this._connectionFor(provider);
    const health = provider === "helius" ? this._heliusHealth : this._alchemyHealth;
    const start = this._now();
    try {
      const slot = await conn.getSlot();
      const latencyMs = this._now() - start;
      health.recordSuccess(latencyMs);
      health.recordSlot(slot);
      rpcRequestTotal.inc({ provider, method: "getSlot", result: "ok" });
    } catch {
      rpcRequestTotal.inc({ provider, method: "getSlot", result: "fail" });
      health.recordFailure();
    }
  }

  /**
   * Exposed for testing: inject scripted probe results and run the evaluate +
   * transition logic (the part of _healthTick that follows _probeProvider).
   * Bypasses real network calls so property tests can drive the state machine
   * directly. Pass null for a provider slot to simulate a probe failure.
   */
  tickForTest(
    heliusSlotResult: number | null,
    alchemySlotResult: number | null,
    latencyMs = 100,
  ): void {
    for (const [provider, slotResult] of [
      ["helius", heliusSlotResult],
      ["alchemy", alchemySlotResult],
    ] as const) {
      const health = provider === "helius" ? this._heliusHealth : this._alchemyHealth;
      if (slotResult === null) {
        health.recordFailure();
        rpcRequestTotal.inc({ provider, method: "getSlot", result: "fail" });
      } else {
        health.recordSuccess(latencyMs);
        health.recordSlot(slotResult);
        rpcRequestTotal.inc({ provider, method: "getSlot", result: "ok" });
      }
    }
    this._evaluateAndTransition();
  }

  /** Core evaluate + failover-detection logic extracted for both _healthTick and tickForTest. */
  private _evaluateAndTransition(): void {
    const heliusSlot = this._heliusHealth.lastSeenSlot;
    const alchemySlot = this._alchemyHealth.lastSeenSlot;

    this._heliusHealth.evaluate(alchemySlot);
    this._alchemyHealth.evaluate(heliusSlot);

    rpcProviderHealthy.set({ provider: "helius" }, this._heliusHealth.isHealthy ? 1 : 0);
    rpcProviderHealthy.set({ provider: "alchemy" }, this._alchemyHealth.isHealthy ? 1 : 0);

    this._updateLatencyGauges("helius", this._heliusHealth);
    this._updateLatencyGauges("alchemy", this._alchemyHealth);

    const heliusLag = this._heliusHealth.computeSlotLag(alchemySlot);
    const alchemyLag = this._alchemyHealth.computeSlotLag(heliusSlot);
    if (heliusLag !== null) rpcSlotLag.set({ provider: "helius" }, heliusLag);
    if (alchemyLag !== null) rpcSlotLag.set({ provider: "alchemy" }, alchemyLag);

    const newActive = this.pickProvider("_tick");
    if (newActive !== this._activeProvider) {
      const from = this._activeProvider;
      const to = newActive;
      const reason = this._heliusHealth.isHealthy ? "helius-recovered" : "helius-unhealthy";
      rpcFailoverTotal.inc({ from, to, reason });
      this._failoverCount++;
      logger.warn("RPC pool failover", {
        from,
        to,
        reason,
        heliusHealthy: this._heliusHealth.isHealthy,
        alchemyHealthy: this._alchemyHealth.isHealthy,
      });
      sendWarningAlert("RPC failover", [
        { name: "From", value: from, inline: true },
        { name: "To", value: to, inline: true },
        { name: "Reason", value: reason, inline: true },
      ])?.catch(() => {});
      this._activeProvider = newActive;
    }
  }

  private _updateLatencyGauges(provider: ProviderName, health: RpcProviderHealth): void {
    const p50 = health.computeP50();
    const p99 = health.computeP99();
    // Both rpcLatencyP50 and rpcLatencyP99 resolve to the same gauge with a "percentile" label.
    if (p50 !== null) rpcLatencyP50.set({ provider, percentile: "p50" }, p50);
    if (p99 !== null) rpcLatencyP99.set({ provider, percentile: "p99" }, p99);
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────

let _sharedPool: RpcPool | null = null;

/**
 * Returns the process-wide RpcPool singleton, constructing it on first call.
 * Pass explicit Connections for test injection; production callers omit both
 * and let the pool construct from env vars.
 */
export function sharedRpcPool(
  helius?: Connection,
  alchemy?: Connection,
  deps?: RpcPoolDeps,
): RpcPool {
  if (_sharedPool === null) {
    const cfg = deps?.config ?? parseRpcPoolConfig(deps?.env ?? process.env);
    const h = helius ?? new Connection(cfg.helius.url);
    const a = alchemy ?? new Connection(cfg.alchemy.url || "https://placeholder.invalid");
    _sharedPool = new RpcPool(h, a, { ...deps, config: cfg });
  }
  return _sharedPool;
}

/**
 * Reset the singleton — used in tests to avoid cross-test state leakage.
 */
export function _resetSharedRpcPool(): void {
  _sharedPool = null;
}
