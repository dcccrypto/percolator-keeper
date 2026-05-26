import "dotenv/config";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config, createLogger, initSentry, captureException, sendInfoAlert, sendCriticalAlert, sendWarningAlert, createServiceMonitors, getConnection, loadKeypair } from "@percolatorct/shared";
import { OracleService } from "./services/oracle.js";
import { CrankService } from "./services/crank.js";
import { LiquidationService } from "./services/liquidation.js";
import { AdlService } from "./services/adl.js";
import { MonitorService } from "./services/monitor.js";
import { validateKeeperEnvGuards } from "./env-guards.js";
import { isMainnet } from "./config/network.js";
import { assertMainnetProgramId } from "./lib/boot-assertions.js";
import { snapshotMetrics as snapshotSenderMetrics } from "./lib/sender-metrics.js";
import { walletBalanceSol, activeMarketsCount, registerDefaultMetrics } from "./lib/metrics.js";
import * as metricsServer from "./lib/metrics-server.js";
import { getRedisClient } from "./lib/redis-client.js";
import { LeaderLock, makeIdentity } from "./lib/leader.js";
import { captureAndExit } from "./lib/exit-handlers.js";
import { StartupTracker } from "./lib/startup-tracker.js";
import { sharedTxQueue, DRAIN_TIMEOUT_MS } from "./lib/tx-queue.js";

// Monitoring — alerts to Discord on threshold breaches
export const monitors = createServiceMonitors("Keeper");

// Initialize Sentry first
initSentry("keeper");

const logger = createLogger("keeper");

if (!process.env.CRANK_KEYPAIR) {
  if (process.env.KEEPER_PRIVATE_KEY) {
    logger.warn("KEEPER_PRIVATE_KEY is deprecated — rename to CRANK_KEYPAIR in your .env");
    process.env.CRANK_KEYPAIR = process.env.KEEPER_PRIVATE_KEY;
  } else {
    throw new Error("CRANK_KEYPAIR must be set for keeper service");
  }
}

validateKeeperEnvGuards();

// If NETWORK=mainnet, the keeper runs against mainnet program (requires FORCE_MAINNET=1).
// On mainnet, HYPERP markets (SOL-PERP, BTC-PERP, ETH-PERP) use the keeper as oracle authority
// and price lookups use mainnet mints directly (no mainnetCA override needed).
assertMainnetProgramId({ isMainnet: isMainnet(), programId: config.programId });
if (isMainnet()) {
  logger.info("Running in MAINNET mode", { programId: config.programId });
}

logger.info("Keeper service starting");

const oracleService = new OracleService();
const crankService = new CrankService(oracleService);
const liquidationService = new LiquidationService(oracleService);
const monitorService = new MonitorService();

// ADL service — gated by ADL_ENABLED=true env var until on-chain instruction
// (PERC-8273 T8) is live and T10 devnet upgrade is done (PERC-8275).
const adlEnabled = process.env.ADL_ENABLED === "true";
const adlService = adlEnabled ? new AdlService() : null;
if (adlEnabled) {
  logger.info("ADL service enabled (ADL_ENABLED=true)");
} else {
  logger.info("ADL service disabled — set ADL_ENABLED=true to enable (requires T8+T10)");
}

// HA leader lock — null when HA_ENABLED is not set or KEEPER_REDIS_URL is absent
const haEnabled = process.env.HA_ENABLED === "true";
const redisClient = haEnabled ? getRedisClient() : null;
const leaderLock: LeaderLock | null =
  haEnabled && redisClient !== null
    ? new LeaderLock(redisClient, makeIdentity(), {
        ttlMs: Number(process.env.KEEPER_LEADER_LOCK_TTL_MS ?? 30_000),
        renewMs: Number(process.env.KEEPER_LEADER_LOCK_RENEW_MS ?? 10_000),
        pollMs: Number(process.env.KEEPER_STANDBY_POLL_MS ?? 5_000),
      })
    : null;

if (haEnabled && redisClient === null) {
  logger.warn("HA_ENABLED=true but KEEPER_REDIS_URL is unset — running as standalone leader");
}

// A5: gate /health on real readiness — Railway otherwise marks the container
// healthy the moment the HTTP server binds, well before start() finishes
// discovering markets and wiring services.
const startupTracker = new StartupTracker();

// Stale oracle pause guard — markets paused due to stale oracle data
const stalePausedMarkets = new Set<string>();

const STALE_ALERT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes → alert
const STALE_PAUSE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes → pause cranking
const STARTUP_GRACE_MS = 5 * 60 * 1000; // 5 minutes grace on startup — avoids false alerts on every deploy
const _keeperStartTime = Date.now();

// SOL balance monitoring — checked every 60 seconds, alerts on Discord when < 0.05 SOL
const SOL_BALANCE_WARN_THRESHOLD = 0.05; // SOL
let _keeperSolBalanceLamports: number | null = null;
let _lastSolBalanceAlertTime = 0;

const solBalanceCheckInterval = setInterval(async () => {
  try {
    const keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
    const conn = getConnection();
    const lamports = await conn.getBalance(keypair.publicKey);
    _keeperSolBalanceLamports = lamports;
    const solBalance = lamports / 1e9;
    walletBalanceSol.set(solBalance);

    if (solBalance < SOL_BALANCE_WARN_THRESHOLD) {
      // Rate-limit alerts to once per 5 minutes to avoid Discord spam
      if (Date.now() - _lastSolBalanceAlertTime > 5 * 60 * 1000) {
        _lastSolBalanceAlertTime = Date.now();
        logger.warn("Keeper SOL balance below threshold", {
          solBalance: solBalance.toFixed(4),
          thresholdSol: SOL_BALANCE_WARN_THRESHOLD,
          // A8: truncate to match the Discord field below — full pubkey in logs is
          // noise and exposes the keeper wallet identity to anyone with log access.
          walletAddress: keypair.publicKey.toBase58().slice(0, 16) + "...",
        });
        sendWarningAlert("Keeper wallet SOL balance low", [
          { name: "Balance", value: `${solBalance.toFixed(4)} SOL`, inline: true },
          { name: "Threshold", value: `${SOL_BALANCE_WARN_THRESHOLD} SOL`, inline: true },
          { name: "Wallet", value: keypair.publicKey.toBase58().slice(0, 16) + "...", inline: false },
        ]).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch keeper SOL balance", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}, 60_000);
solBalanceCheckInterval.unref();

// B7: per-market cooldown so we don't fire a Discord critical every 60 s while
// an oracle is stuck. The old aggregate alert reset only when the stale set
// emptied, which never happened during a multi-hour DEX outage — channel got
// nuked. Track last-alert per slab and re-fire only after STALE_ALERT_COOLDOWN_MS.
const STALE_ALERT_COOLDOWN_MS = Number(process.env.KEEPER_STALE_ALERT_COOLDOWN_MS ?? 5 * 60_000);
const lastStaleAlertByMarket = new Map<string, number>();

const staleCheckInterval = setInterval(() => {
  // Skip stale checks during startup grace period (GH#29 — false CRITICAL floods on deploy)
  if (Date.now() - _keeperStartTime < STARTUP_GRACE_MS) return;

  const alertStale = oracleService.getStaleMarkets(STALE_ALERT_THRESHOLD_MS);
  const pauseStale = oracleService.getStaleMarkets(STALE_PAUSE_THRESHOLD_MS);

  // Update paused set
  const newPaused = new Set(pauseStale);
  // Unpause markets that recovered
  for (const addr of stalePausedMarkets) {
    if (!newPaused.has(addr)) {
      stalePausedMarkets.delete(addr);
      logger.info("Oracle recovered, unpausing market", { slabAddress: addr });
    }
  }
  // Pause newly stale markets
  for (const addr of pauseStale) {
    if (!stalePausedMarkets.has(addr)) {
      stalePausedMarkets.add(addr);
      logger.warn("Oracle stale for market, pausing mark updates", { slabAddress: addr, thresholdMs: STALE_PAUSE_THRESHOLD_MS });
    }
  }

  // Recovered markets should drop their cooldown entry so a fresh staleness
  // event re-alerts immediately rather than waiting for the cooldown window.
  const alertSet = new Set(alertStale);
  for (const market of Array.from(lastStaleAlertByMarket.keys())) {
    if (!alertSet.has(market)) lastStaleAlertByMarket.delete(market);
  }

  // B7: per-market cooldown — gather the subset whose cooldown has elapsed.
  const now = Date.now();
  const toAlert: string[] = [];
  for (const market of alertStale) {
    const last = lastStaleAlertByMarket.get(market) ?? 0;
    if (now - last >= STALE_ALERT_COOLDOWN_MS) {
      lastStaleAlertByMarket.set(market, now);
      toAlert.push(market);
    }
  }
  if (toAlert.length > 0) {
    sendCriticalAlert("Oracle stale for markets", [
      { name: "Stale Markets", value: toAlert.join(", "), inline: false },
      { name: "Paused (>10min)", value: stalePausedMarkets.size.toString(), inline: true },
    ]).catch(() => {});
  }
}, 60_000);

// GH#2025: Alert when liquidation scanner stalls (no scan completed for >3 min)
const LIQUIDATION_STALE_THRESHOLD_MS = 3 * 60 * 1000;
let _lastLiqStaleAlertTime = 0;
const liqStaleCheckInterval = setInterval(() => {
  if (Date.now() - _keeperStartTime < STARTUP_GRACE_MS) return;
  const liqSt = liquidationService.getStatus();
  if (!liqSt.running) return;
  const timeSinceScan = liqSt.lastScanTime > 0 ? Date.now() - liqSt.lastScanTime : Infinity;
  if (timeSinceScan > LIQUIDATION_STALE_THRESHOLD_MS) {
    // Rate-limit alerts to once per 5 min
    if (Date.now() - _lastLiqStaleAlertTime > 5 * 60 * 1000) {
      _lastLiqStaleAlertTime = Date.now();
      sendCriticalAlert("Liquidation scanner stalled", [
        { name: "Time Since Last Scan", value: timeSinceScan === Infinity ? "never" : `${Math.round(timeSinceScan / 1000)}s`, inline: true },
        { name: "Scan Count", value: liqSt.scanCount.toString(), inline: true },
        { name: "Total Liquidations", value: liqSt.liquidationCount.toString(), inline: true },
      ]).catch(() => {});
    }
  }
}, 60_000);

/** Check if a market is paused due to stale oracle */
export function isMarketStalePaused(slabAddress: string): boolean {
  return stalePausedMarkets.has(slabAddress);
}

// Wire stale pause check into crank service
crankService.setStalePauseCheck(isMarketStalePaused);

// 6.2: Wire crank cycle counter into MonitorService so it can track ADL staleness
crankService.setOnCrankCycle(() => monitorService.notifyCrankCycle());

// A4: deleted the per-market setInterval loop that used to live here. It was
// unreachable: crankService.getMarkets() is called at module load time, before
// discover() has populated the map, so the forEach iterated an empty Map and
// registered zero intervals. The variables it wrote (lastSuccessfulCrankTime,
// lastOracleUpdateTime) were never read — /health computes most-recent crank
// time on every request from the live crank state.
// activeMarketsCount metric is wired below in start() after markets are
// discovered, then re-set whenever discover runs (via crankService internals).

// Health endpoint
const startupTime = Date.now();
const healthPort = Number(process.env.KEEPER_HEALTH_PORT ?? 8081);

// Rate limiter for /register: max 5 failed auth attempts per IP per 60 seconds.
// Prevents brute-force attacks against the shared secret.
const REGISTER_RATE_WINDOW_MS = 60_000;
const REGISTER_RATE_MAX_FAILURES = 5;
const registerFailures = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = registerFailures.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < REGISTER_RATE_WINDOW_MS);
  registerFailures.set(ip, recent);
  return recent.length >= REGISTER_RATE_MAX_FAILURES;
}

function recordAuthFailure(ip: string): void {
  const timestamps = registerFailures.get(ip) ?? [];
  timestamps.push(Date.now());
  registerFailures.set(ip, timestamps);
  // Cap map size to prevent memory exhaustion from many unique IPs
  if (registerFailures.size > 10_000) {
    const oldest = registerFailures.keys().next().value;
    if (oldest !== undefined) registerFailures.delete(oldest);
  }
}

// Periodic cleanup: purge IPs whose failure timestamps have all expired.
// Without this, the Map accumulates stale entries over long uptime.
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60_000;
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of registerFailures.entries()) {
    const recent = timestamps.filter((t) => now - t < REGISTER_RATE_WINDOW_MS);
    if (recent.length === 0) {
      registerFailures.delete(ip);
    } else {
      registerFailures.set(ip, recent);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);
rateLimitCleanupTimer.unref();

// Shared security headers for all JSON responses — prevents MIME sniffing
// and ensures intermediaries (CDN, reverse proxy) don't cache sensitive data.
const secureJsonHeaders = {
  "Content-Type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const healthServer = http.createServer((req, res) => {
  // POST /register — hot-register a new market without waiting for discovery cycle
  // Body: { slabAddress: string, mainnetCA?: string }
  // Auth: requires x-shared-secret header matching KEEPER_REGISTER_SECRET env var (defense-in-depth; #780)
  if (req.url === "/register" && req.method === "POST") {
    const registerSecret = process.env.KEEPER_REGISTER_SECRET ?? "";
    if (!registerSecret) {
      req.resume();
res.writeHead(503, secureJsonHeaders);
      res.end(JSON.stringify({ success: false, message: "Endpoint not configured" }));
      return;
    }

    const clientIp = String(req.socket.remoteAddress ?? "unknown");
    if (isRateLimited(clientIp)) {
      logger.warn("Register rate limited", { ip: clientIp });
req.resume();
res.writeHead(429, secureJsonHeaders);
      res.end(JSON.stringify({ success: false, message: "Too many requests" }));
      return;
    }

    const provided = String(req.headers["x-shared-secret"] ?? "");
    const secretBuf = Buffer.from(registerSecret, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    // Pad both buffers to equal length so timingSafeEqual always runs in
    // constant time regardless of input length — prevents attackers from
    // binary-searching the secret length via response-time measurement.
    const maxLen = Math.max(secretBuf.length, providedBuf.length, 1);
    const secretPad = Buffer.alloc(maxLen);
    const providedPad = Buffer.alloc(maxLen);
    secretBuf.copy(secretPad);
    providedBuf.copy(providedPad);
    const lengthMatch = secretBuf.length === providedBuf.length;
    // Always run timingSafeEqual — do NOT use || short-circuit, which skips
    // the crypto comparison when lengths differ and leaks timing info.
    const contentMatch = timingSafeEqual(secretPad, providedPad);
    if (!lengthMatch || !contentMatch) {
      recordAuthFailure(clientIp);
req.resume();
res.writeHead(401, secureJsonHeaders);
      res.end(JSON.stringify({ success: false, message: "Unauthorized" }));
      return;
    }

    const MAX_BODY_BYTES = 4096;
    let body = "";
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, secureJsonHeaders);
        res.end(JSON.stringify({ success: false, message: "Payload too large" }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (exceeded) return;
      try {
        const parsed = JSON.parse(body) as { slabAddress?: string; mainnetCA?: string };
        const { slabAddress, mainnetCA } = parsed;
        if (!slabAddress || typeof slabAddress !== "string") {
          res.writeHead(400, secureJsonHeaders);
          res.end(JSON.stringify({ success: false, message: "slabAddress is required" }));
          return;
        }
        // Solana base58 addresses are 32–44 characters of [1-9A-HJ-NP-Za-km-z]
        const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
        if (!base58Re.test(slabAddress)) {
          res.writeHead(400, secureJsonHeaders);
          res.end(JSON.stringify({ success: false, message: "Invalid slabAddress format" }));
          return;
        }
        if (mainnetCA !== undefined && (typeof mainnetCA !== "string" || !base58Re.test(mainnetCA))) {
          res.writeHead(400, secureJsonHeaders);
          res.end(JSON.stringify({ success: false, message: "Invalid mainnetCA format" }));
          return;
        }
        const result = await crankService.registerMarket(slabAddress, mainnetCA);
        if (!result.success) {
          logger.warn("registerMarket failed", { slabAddress, detail: result.message });
        }
        const safeMessage = result.success
          ? result.message
          : "Registration failed";
        res.writeHead(result.success ? 200 : 422, secureJsonHeaders);
        res.end(JSON.stringify({ success: result.success, message: safeMessage }));
      } catch (err) {
        logger.error("Register endpoint error", { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, secureJsonHeaders);
        res.end(JSON.stringify({ success: false, message: "Internal error" }));
      }
    });
    return;
  }

  // GET /pause-status — returns markets paused due to stale oracle
  if (req.url === "/pause-status" && req.method === "GET") {
    res.writeHead(200, secureJsonHeaders);
    res.end(JSON.stringify({ pausedMarkets: [...stalePausedMarkets] }));
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    // A5: hard 503 until start() resolved. Railway otherwise marks the
    // container healthy as soon as healthServer.listen() returns — long
    // before discover() + service.start() have wired anything up.
    if (!startupTracker.isReady()) {
      res.writeHead(503, secureJsonHeaders);
      res.end(JSON.stringify({
        status: startupTracker.isFailed() ? "failed" : "starting",
        failureReason: startupTracker.failureReason,
      }));
      return;
    }

    const markets = crankService.getMarkets();
    const marketsTracked = markets.size;
    
    // Find the most recent crank time across all markets
    let mostRecentCrank = 0;
    for (const [_, state] of markets) {
      if (state.lastCrankTime > mostRecentCrank) {
        mostRecentCrank = state.lastCrankTime;
      }
    }
    
    // Find the most recent oracle update
    let mostRecentOracle = 0;
    for (const [slabAddress] of markets) {
      const price = oracleService.getCurrentPrice(slabAddress);
      if (price && price.timestamp > mostRecentOracle) {
        mostRecentOracle = price.timestamp;
      }
    }
    
    const now = Date.now();
    const timeSinceLastCrank = mostRecentCrank > 0 ? now - mostRecentCrank : Infinity;
    const timeSinceLastOracle = mostRecentOracle > 0 ? now - mostRecentOracle : Infinity;
    
    // Determine health status
    // Grace period: allow 5 minutes after startup before marking as "down"
    const uptimeMs = now - startupTime;
    let status: "ok" | "degraded" | "down" | "starting";
    if (uptimeMs < 300_000 && mostRecentCrank === 0) {
      status = "starting"; // Still warming up, no cranks yet
    } else if (timeSinceLastCrank < 60_000) {
      status = "ok";
    } else if (timeSinceLastCrank < 300_000) {
      status = "degraded";
    } else {
      status = "down";
    }

    // GH#2025: Also degrade/down if liquidation scanner has stalled
    const liqScanStatus = liquidationService.getStatus();
    if (uptimeMs >= 300_000 && liqScanStatus.running) {
      const timeSinceLiqScan = liqScanStatus.lastScanTime > 0 ? now - liqScanStatus.lastScanTime : Infinity;
      if (timeSinceLiqScan > 300_000 && status !== "down") {
        status = "down"; // Liquidation scan stalled >5 min
      } else if (timeSinceLiqScan > 120_000 && status === "ok") {
        status = "degraded"; // Liquidation scan stalled >2 min
      }
    }
    
    // ADL stats
    let adlStats: Record<string, unknown> | null = null;
    if (adlService) {
      const stats = adlService.getStats();
      let totalAdlTxSent = 0;
      let activeMarkets = 0;
      for (const [, s] of stats) {
        totalAdlTxSent += s.adlTxSent;
        if (s.adlTxSent > 0) activeMarkets++;
      }
      adlStats = { enabled: true, totalAdlTxSent, activeMarkets };
    } else {
      adlStats = { enabled: false };
    }

    // Liquidation scan health
    const liqStatus = liquidationService.getStatus();
    const timeSinceLastLiqScanMs = liqStatus.lastScanTime > 0 ? now - liqStatus.lastScanTime : null;

    const keeperSolBalance = _keeperSolBalanceLamports !== null
      ? _keeperSolBalanceLamports / 1e9
      : null;

    const healthData = {
      status,
      role: leaderLock ? leaderLock.role() : "leader",
      lastCrankTime: mostRecentCrank,
      lastOracleUpdate: mostRecentOracle,
      marketsTracked,
      timeSinceLastCrankMs: timeSinceLastCrank === Infinity ? null : timeSinceLastCrank,
      timeSinceLastOracleMs: timeSinceLastOracle === Infinity ? null : timeSinceLastOracle,
      keeperWallet: {
        solBalance: keeperSolBalance,
        belowThreshold: keeperSolBalance !== null && keeperSolBalance < SOL_BALANCE_WARN_THRESHOLD,
        thresholdSol: SOL_BALANCE_WARN_THRESHOLD,
      },
      liquidation: {
        running: liqStatus.running,
        scanCount: liqStatus.scanCount,
        liquidationCount: liqStatus.liquidationCount,
        lastScanTime: liqStatus.lastScanTime,
        timeSinceLastScanMs: timeSinceLastLiqScanMs,
        permanentlySkippedCount: liqStatus.permanentlySkippedCount,
      },
      adl: adlStats,
      monitors: {
        rpc: monitors.rpc.getStatus(),
        scan: monitors.scan.getStatus(),
        oracle: monitors.oracle.getStatus(),
      },
      // 6.1 + 6.2 + 6.3: conservation invariants, crank cycle count, ADL staleness
      invariants: monitorService.getStatus(),
      // Task 1.8: Sender land-rate + tip-spend metrics for Phase 1 rollout observability
      senderMetrics: snapshotSenderMetrics(),
    };
    
    const currentRole = leaderLock ? leaderLock.role() : "leader";
    // Standby nodes are healthy by definition — services intentionally not running
    const statusCode = currentRole === "standby" ? 200 : status === "down" ? 503 : 200; // "starting", "ok", "degraded" → 200
    res.writeHead(statusCode, secureJsonHeaders);
    res.end(JSON.stringify(healthData));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

// B13: do NOT bind the health port at module load. start() calls .listen()
// after services are wired so Railway treats the missing port as unhealthy
// during boot — without this, Railway flips to "healthy" the moment the
// server binds (well before the keeper can actually crank anything).

/**
 * Escalating retry delays for startup market discovery.
 * The SDK fires ~8 getProgramAccounts per program in parallel; on a fresh deploy
 * the first call burst often 429s before finding any markets. Retrying with
 * increasing delays recovers gracefully without crashing.
 * Mirrors the indexer's INITIAL_RETRY_DELAYS pattern (MarketDiscovery.ts).
 */
const STARTUP_DISCOVERY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

async function start() {
  // Validate RPC connectivity before attempting discovery — fail fast on misconfiguration
  try {
    const { getConnection, getFallbackConnection } = await import("@percolatorct/shared");
    const primary = getConnection();
    const slot = await primary.getSlot();
    logger.info("Primary RPC connectivity verified", { slot });

    try {
      const fallback = getFallbackConnection();
      const fbSlot = await fallback.getSlot();
      logger.info("Fallback RPC connectivity verified", { slot: fbSlot });
    } catch (fbErr) {
      logger.warn("Fallback RPC unreachable — keeper will rely on primary only", {
        error: fbErr instanceof Error ? fbErr.message : String(fbErr),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Primary RPC unreachable at startup — check SOLANA_RPC_URL", { error: msg });
    throw new Error(`Primary RPC connectivity check failed: ${msg}`);
  }

  let markets: Awaited<ReturnType<typeof crankService.discover>> = [];
  let discoverySuccess = false;

  for (let attempt = 0; attempt <= STARTUP_DISCOVERY_DELAYS_MS.length; attempt++) {
    try {
      markets = await crankService.discover();
      if (markets.length > 0) {
        discoverySuccess = true;
        break;
      }
      // Got 0 markets — could be 429-throttled or fresh deploy with no slabs yet.
      // Retry with backoff. On mainnet, 0 markets is unusual; log as warning.
      if (attempt < STARTUP_DISCOVERY_DELAYS_MS.length) {
        const delay = STARTUP_DISCOVERY_DELAYS_MS[attempt]!;
        logger.warn("Startup discovery returned 0 markets — retrying", {
          attempt: attempt + 1,
          delayMs: delay,
        });
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < STARTUP_DISCOVERY_DELAYS_MS.length) {
        const delay = STARTUP_DISCOVERY_DELAYS_MS[attempt]!;
        logger.warn("Startup discovery failed — retrying", {
          attempt: attempt + 1,
          delayMs: delay,
          error: errMsg,
        });
        await new Promise(r => setTimeout(r, delay));
      } else {
        logger.warn("Startup discovery exhausted all retries — keeper will idle and retry on next cycle", {
          error: errMsg,
        });
      }
    }
  }

  logger.info("Markets discovered", { count: markets.length, discoverySuccess });

  if (markets.length === 0) {
    logger.info("No markets found — keeper will idle and retry discovery each cycle. This is normal for fresh mainnet deployments.");
  }

  activeMarketsCount.set(markets.length);

  async function startAllServices(): Promise<void> {
    await crankService.start();
    logger.info("Crank service started");
    liquidationService.start(() => crankService.getMarkets());
    logger.info("Liquidation scanner started");
    monitorService.start(() => crankService.getMarkets());
    logger.info("MonitorService started (invariant + ADL staleness checks)");

    if (adlService) {
      adlService.start(() => crankService.getMarkets());
      logger.info("ADL service started");
    }
  }

  function stopAllServices(): void {
    if (adlService) {
      adlService.stop();
      logger.info("ADL service stopped (HA demote)");
    }
    crankService.stop();
    logger.info("Crank service stopped (HA demote)");
    liquidationService.stop();
    logger.info("Liquidation service stopped (HA demote)");
    monitorService.stop();
    logger.info("MonitorService stopped (HA demote)");
  }

  if (leaderLock) {
    // A.3: env-guards asserts NETWORK is set to mainnet|devnet whenever
    // HA_ENABLED=true, so the previous `?? "devnet"` fallback is gone —
    // a missing NETWORK would silently share a lock with the wrong cluster.
    const network = process.env.NETWORK!;
    leaderLock.start({
      network,
      onPromote: () => {
        logger.info("HA: promoted to leader — starting services", { network });
        void startAllServices();
      },
      onDemote: (reason) => {
        logger.warn("HA: demoted from leader — stopping services", { network, reason });
        stopAllServices();
      },
    });
    logger.info("HA leader election active", { network, haEnabled: true });
  } else {
    await startAllServices();
  }

  // B13: bind the health port only after every service is wired up. Wrapped in
  // a Promise so start() awaits the bind callback before resolving — otherwise
  // a concurrent /health probe could land between this call and start() resolving.
  // In HA mode the health port still binds here; startupTracker reports
  // "starting" until services actually wire up via onPromote.
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(healthPort, () => {
      healthServer.off("error", reject);
      logger.info("Health endpoint started", { port: healthPort });
      resolve();
    });
  });

  // F: Prometheus /metrics endpoint (loopback only — A.8). Default process metrics
  // are registered separately so a metrics-scrape failure doesn't crash startup.
  registerDefaultMetrics();
  metricsServer.start();

  // Send startup alert
  await sendInfoAlert("Keeper service started", [
    { name: "Markets Tracked", value: markets.length.toString(), inline: true },
    { name: "Health Endpoint", value: `http://localhost:${healthPort}/health`, inline: true },
    { name: "HA Mode", value: leaderLock ? "enabled" : "standalone", inline: true },
  ]).catch(() => {}); // Don't crash if alert fails
}

// A5: explicit success → ready, failure → captureAndExit. Previously a
// start() rejection only logged and left the process up, which let Railway
// keep marking the container healthy while no actual work was happening.
start()
  .then(() => {
    startupTracker.markReady();
    logger.info("Keeper start() resolved — health endpoint now reports ready");
  })
  .catch((err) => {
    startupTracker.markFailed(err instanceof Error ? err.message : String(err));
    captureAndExit("Failed to start keeper — exiting", err, {
      capture: captureException,
      logger,
      exit: process.exit,
      setTimer: (cb, ms) => {
        const t = setTimeout(cb, ms);
        t.unref();
      },
    });
  });

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutdown initiated", { signal });

  const forceExit = setTimeout(() => {
    logger.error("Shutdown timed out — forcing exit", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  
  try {
    // Send shutdown alert
    await sendInfoAlert("Keeper service shutting down", [
      { name: "Signal", value: signal, inline: true },
    ]);

    // Drain in-flight txs FIRST so they land before the leader lock is released
    // and before the metrics server closes. This is the safest ordering:
    //   txQueue.drain → leaderLock.stop → services.stop → healthServer → metricsServer
    logger.info("Draining tx queue before shutdown", { timeoutMs: DRAIN_TIMEOUT_MS });
    await sharedTxQueue.drain(DRAIN_TIMEOUT_MS);
    const qStats = sharedTxQueue.getStats();
    logger.info("Tx queue drained", {
      liquidation: qStats.liquidation,
      oracle: qStats.oracle,
      crank: qStats.crank,
    });

    // Stop stale oracle + liquidation + SOL balance checks
    clearInterval(staleCheckInterval);
    clearInterval(liqStaleCheckInterval);
    clearInterval(solBalanceCheckInterval);
    monitorService.stop();

    // Release leader lock so a standby can immediately take over
    if (leaderLock) {
      logger.info("Releasing leader lock");
      await leaderLock.stop();
    }

    // Stop metrics server
    logger.info("Closing metrics server");
    await metricsServer.stop();

    // Close health server
    logger.info("Closing health server");
    await new Promise<void>((resolve, reject) => {
      healthServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Stop ADL service if running
    if (adlService) {
      logger.info("Stopping ADL service");
      adlService.stop();
    }

    // Stop crank service (clears timers, stops processing)
    logger.info("Stopping crank service");
    crankService.stop();
    
    // Stop liquidation service (clears timers)
    logger.info("Stopping liquidation service");
    liquidationService.stop();
    
    // Note: Solana connection doesn't need explicit cleanup
    // Oracle service has no persistent state to clean up
    
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Error during shutdown", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A6: crash on unhandled rejections / exceptions. Previously we logged and kept
// the process alive — but the keeper signs against live funds, and silent
// recovery from an unhandled error risks operating with corrupt in-process
// state (half-written maps, dangling promises holding resources). Better to
// capture to Sentry, wait briefly for flush, then exit so Railway restarts a
// clean process.
const crashDeps = {
  capture: captureException,
  logger,
  exit: process.exit,
  setTimer: (cb: () => void, ms: number) => {
    const t = setTimeout(cb, ms);
    t.unref();
  },
};

process.on("unhandledRejection", (reason) => {
  captureAndExit("Unhandled promise rejection — exiting", reason, crashDeps);
});

process.on("uncaughtException", (err) => {
  captureAndExit("Uncaught exception — exiting", err, crashDeps);
});
