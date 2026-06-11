/**
 * H7 PoC — RPC pool failover to a secondary that's behind the high-water mark
 * moves callers BACKWARDS in slot time.
 *
 * THE BUG (pre-fix):
 *   pickProvider() routed solely on isHealthy flags. When Helius failed mid-tick
 *   and Alchemy was "healthy by its own metrics" but ~50 slots behind, the pool
 *   would happily route reads to Alchemy. Downstream consumers observed slot
 *   regression. The existing cross-provider lag check in
 *   RpcProviderHealth.evaluate() runs only every healthCheckIntervalMs (default
 *   5s), leaving a within-tick window where the secondary can be "healthy by
 *   stale data."
 *
 * THE FIX (this PR):
 *   Track a global _highestServedSlot. pickProvider() refuses Alchemy when
 *   alchemy.lastSeenSlot < _highestServedSlot - slack (default 10). Degraded
 *   primary beats backwards secondary. Configurable via
 *   RPC_FAILOVER_SLOT_FLOOR_SLACK env var. Cold-start safe.
 *
 * This PoC demonstrates the bug shape with a minimal pickProvider clone.
 */
import { describe, it, expect } from "vitest";

interface PoolState {
  heliusHealthy: boolean;
  alchemyHealthy: boolean;
  alchemyLastSeenSlot: number;
  highestServedSlot: number;
  slack: number;
}

function pickProviderOld(s: PoolState): "helius" | "alchemy" {
  if (s.heliusHealthy) return "helius";
  if (s.alchemyHealthy) return "alchemy"; // ← no slot floor — THE BUG
  return "helius";
}

function pickProviderNew(s: PoolState): "helius" | "alchemy" {
  if (s.heliusHealthy) return "helius";
  if (s.alchemyHealthy) {
    if (
      s.highestServedSlot > 0 &&
      s.alchemyLastSeenSlot < s.highestServedSlot - s.slack
    ) {
      return "helius"; // degraded primary > backwards secondary
    }
    return "alchemy";
  }
  return "helius";
}

describe("H7 PoC — RPC pool slot-floor failover guard", () => {
  it("OLD path: Helius unhealthy, Alchemy 50 slots behind → routes to Alchemy (BACKWARDS slot)", () => {
    const s: PoolState = {
      heliusHealthy: false,           // just failed
      alchemyHealthy: true,           // healthy by its own metrics
      alchemyLastSeenSlot: 950,       // but its last probe was 50 slots ago
      highestServedSlot: 1000,        // we've served slot 1000 already
      slack: 10,
    };
    expect(pickProviderOld(s)).toBe("alchemy");
    // ↑ Caller will next see slot 950, after just having seen 1000.
    //   Downstream consumers may re-fire on already-handled state.
  });

  it("NEW path: same scenario → refuses Alchemy, returns Helius (degraded)", () => {
    const s: PoolState = {
      heliusHealthy: false,
      alchemyHealthy: true,
      alchemyLastSeenSlot: 950,
      highestServedSlot: 1000,
      slack: 10,
    };
    expect(pickProviderNew(s)).toBe("helius");
  });

  it("NEW path: Alchemy within slack window → accepted normally", () => {
    const s: PoolState = {
      heliusHealthy: false,
      alchemyHealthy: true,
      alchemyLastSeenSlot: 992, // 8 slots behind, within 10 slack
      highestServedSlot: 1000,
      slack: 10,
    };
    expect(pickProviderNew(s)).toBe("alchemy");
  });

  it("NEW path: cold start (highestServedSlot=0) does NOT reject Alchemy", () => {
    const s: PoolState = {
      heliusHealthy: false,
      alchemyHealthy: true,
      alchemyLastSeenSlot: 0,
      highestServedSlot: 0, // no observations yet
      slack: 10,
    };
    expect(pickProviderNew(s)).toBe("alchemy");
  });

  it("PoC — env-configurable slack widens the acceptable window", () => {
    const s: PoolState = {
      heliusHealthy: false,
      alchemyHealthy: true,
      alchemyLastSeenSlot: 950,
      highestServedSlot: 1000,
      slack: 100, // operator overrode via RPC_FAILOVER_SLOT_FLOOR_SLACK
    };
    expect(pickProviderNew(s)).toBe("alchemy"); // 50 < 100 slack
  });
});
