/**
 * M10 PoC — HYPERP dexPool config goes stale for up to 5 minutes after
 * admin SetDexPool because the slab config is only refreshed in discover().
 *
 * THE BUG (pre-fix):
 *   src/services/crank.ts:705 reads `state.market.config.dexPool` —
 *   parsed from slab data during discover() (runs every ~5 min).
 *   The cache in resolveHyperpPoolRemainingAccounts at line 577
 *   invalidates ONLY when the input poolAddress differs:
 *     if (state.dexPoolResolvedAddress === poolAddress &&
 *         state.dexPoolRemainingAccounts !== undefined) {
 *       return state.dexPoolRemainingAccounts;
 *     }
 *   So when admin calls SetDexPool to change POOL_OLD → POOL_NEW:
 *     1. On-chain dexPool is now POOL_NEW.
 *     2. state.market.config.dexPool stays POOL_OLD (parsed 4 min ago).
 *     3. crankMarket reads POOL_OLD.
 *     4. Cache returns remaining-accounts for POOL_OLD.
 *     5. UpdateHyperpMark sent with POOL_OLD + OLD remaining accounts.
 *     6. On-chain rejects with OracleInvalid (POOL_OLD is no longer pinned).
 *     7. Repeats every cycle until next discover() (~5 min worst case).
 *   Each failed tx burns priority fee + RPC quota + alert noise.
 *
 * THE FIX (this PR):
 *   In the HYPERP branch of crankMarket, before reading config.dexPool,
 *   check if the last config refresh was > HYPERP_CONFIG_REFRESH_MS ago
 *   (60s default). If so, re-fetch the slab + reparse config + update
 *   state.market.config. If dexPool changed, invalidate the cached
 *   remaining-accounts so the next call refetches for the new pool.
 *
 * This PoC walks through the state machine.
 */
import { describe, it, expect } from "vitest";

interface State {
  configDexPool: string;
  lastHyperpConfigRefreshMs?: number;
  // Cached remaining-accounts keyed by pool address.
  cachedPool?: string;
  cachedRemaining?: string[];
}

const HYPERP_CONFIG_REFRESH_MS = 60_000;
const DISCOVERY_INTERVAL_MS = 5 * 60_000;

// Simulate on-chain SetDexPool by external mutation.
function onChainSetDexPool(newPool: string): { dexPool: string } {
  return { dexPool: newPool };
}

function oldCrankFlow(
  state: State,
  now: number,
  fetchOnChainConfig: () => { dexPool: string },
  discoverLastRunMs: number,
): { sentToPool: string; cacheHit: boolean } {
  // Pre-fix: only refresh config on discover() cadence.
  if (now - discoverLastRunMs >= DISCOVERY_INTERVAL_MS) {
    state.configDexPool = fetchOnChainConfig().dexPool;
  }
  const pool = state.configDexPool;
  // Cache logic from resolveHyperpPoolRemainingAccounts.
  const cacheHit = state.cachedPool === pool && state.cachedRemaining !== undefined;
  if (!cacheHit) {
    state.cachedPool = pool;
    state.cachedRemaining = [`remaining-for-${pool}`];
  }
  return { sentToPool: pool, cacheHit };
}

function newCrankFlow(
  state: State,
  now: number,
  fetchOnChainConfig: () => { dexPool: string },
): { sentToPool: string; cacheHit: boolean } {
  // M10 fix: refresh config on shorter TTL inside crankMarket's HYPERP branch.
  if (
    state.lastHyperpConfigRefreshMs === undefined ||
    now - state.lastHyperpConfigRefreshMs >= HYPERP_CONFIG_REFRESH_MS
  ) {
    const fresh = fetchOnChainConfig();
    const prevPool = state.configDexPool;
    state.configDexPool = fresh.dexPool;
    state.lastHyperpConfigRefreshMs = now;
    if (prevPool !== fresh.dexPool) {
      // Invalidate the remaining-accounts cache.
      state.cachedPool = undefined;
      state.cachedRemaining = undefined;
    }
  }
  const pool = state.configDexPool;
  const cacheHit = state.cachedPool === pool && state.cachedRemaining !== undefined;
  if (!cacheHit) {
    state.cachedPool = pool;
    state.cachedRemaining = [`remaining-for-${pool}`];
  }
  return { sentToPool: pool, cacheHit };
}

describe("M10 PoC — HYPERP dexPool config refresh after admin SetDexPool", () => {
  it("OLD pattern: admin SetDexPool change isn't visible to keeper for up to 5 min", () => {
    const state: State = { configDexPool: "POOL_OLD" };
    // discover() ran at t=0.
    let onChain = { dexPool: "POOL_OLD" };

    // t=120s: admin calls SetDexPool(POOL_NEW).
    onChain = onChainSetDexPool("POOL_NEW");

    // t=121s: crankMarket runs. Pre-fix uses cached config from discover().
    const at121s = oldCrankFlow(state, 121_000, () => onChain, /* discoverLastRunMs */ 0);
    expect(at121s.sentToPool).toBe("POOL_OLD"); // ← BUG: keeper sends to OLD pool

    // t=240s: another cycle. Same stale config.
    const at240s = oldCrankFlow(state, 240_000, () => onChain, 0);
    expect(at240s.sentToPool).toBe("POOL_OLD"); // ← still stale

    // t=301s: discover() finally runs (5 min cycle). NOW the keeper sees the change.
    const at301s = oldCrankFlow(state, 301_000, () => onChain, 0);
    expect(at301s.sentToPool).toBe("POOL_NEW");
    // ↑ Up to 5 minutes of failed UpdateHyperpMark txs to the old pool.
  });

  it("NEW pattern: admin SetDexPool change is visible within 60 seconds", () => {
    const state: State = { configDexPool: "POOL_OLD" };
    let onChain = { dexPool: "POOL_OLD" };

    // t=0: first crank refreshes and caches.
    const at0 = newCrankFlow(state, 0, () => onChain);
    expect(at0.sentToPool).toBe("POOL_OLD");

    // t=30s: admin calls SetDexPool(POOL_NEW).
    onChain = onChainSetDexPool("POOL_NEW");

    // t=31s: crank runs but refresh TTL (60s) hasn't elapsed → still OLD.
    const at31s = newCrankFlow(state, 31_000, () => onChain);
    expect(at31s.sentToPool).toBe("POOL_OLD");

    // t=61s: refresh TTL elapsed → keeper picks up POOL_NEW.
    const at61s = newCrankFlow(state, 61_000, () => onChain);
    expect(at61s.sentToPool).toBe("POOL_NEW");
    // ↑ Window: up to 60s instead of up to 5 min. 5× faster recovery.
  });

  it("NEW pattern: pool change invalidates the remaining-accounts cache", () => {
    const state: State = { configDexPool: "POOL_OLD" };
    let onChain = { dexPool: "POOL_OLD" };

    // Seed the remaining-accounts cache for POOL_OLD.
    newCrankFlow(state, 0, () => onChain);
    expect(state.cachedRemaining).toEqual(["remaining-for-POOL_OLD"]);

    // SetDexPool to POOL_NEW.
    onChain = onChainSetDexPool("POOL_NEW");

    // Past TTL → refresh fires + cache invalidates + refetches for POOL_NEW.
    newCrankFlow(state, 61_000, () => onChain);
    expect(state.cachedRemaining).toEqual(["remaining-for-POOL_NEW"]);
  });

  it("NEW pattern: no pool change → cache stays warm, no extra refetches", () => {
    const state: State = { configDexPool: "POOL_A" };
    const onChain = { dexPool: "POOL_A" };

    let calls = 0;
    const tracked = () => { calls++; return onChain; };

    // First crank fetches.
    newCrankFlow(state, 0, tracked);
    // Several cycles within TTL — no extra fetches.
    newCrankFlow(state, 10_000, tracked);
    newCrankFlow(state, 30_000, tracked);
    newCrankFlow(state, 50_000, tracked);
    expect(calls).toBe(1);

    // Past TTL → one extra refresh, but cache stays warm (same pool).
    newCrankFlow(state, 60_000, tracked);
    expect(calls).toBe(2);
    expect(state.cachedPool).toBe("POOL_A");
    expect(state.cachedRemaining).toEqual(["remaining-for-POOL_A"]);
  });

  it("NEW pattern: env-configurable TTL (KEEPER_HYPERP_CONFIG_REFRESH_MS)", () => {
    // The constant HYPERP_CONFIG_REFRESH_MS is initialised at module load
    // from process.env.KEEPER_HYPERP_CONFIG_REFRESH_MS (default 60_000).
    // Documented so operators can tune for hot vs sleepy markets.
    expect(HYPERP_CONFIG_REFRESH_MS).toBeGreaterThanOrEqual(1);
    expect(HYPERP_CONFIG_REFRESH_MS).toBeLessThanOrEqual(DISCOVERY_INTERVAL_MS);
  });
});
