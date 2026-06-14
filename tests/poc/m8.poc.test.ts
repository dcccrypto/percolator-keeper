/**
 * M8 PoC — registerMarket bypasses _cycling, allowing duplicate KeeperCrank
 * txs for the same slab when an HTTP /register arrives mid-cycle.
 *
 * THE BUG (pre-fix):
 *   - `_cycling` is a process-wide guard preventing two crankAll cycles
 *     from running concurrently. Set by start()'s setInterval body.
 *   - registerMarket (called by the /register HTTP endpoint) calls
 *     crankMarket(slabAddress) DIRECTLY at line 1222 — bypassing _cycling.
 *   - If the timer-driven crankAll is iterating its market map at the
 *     moment a /register HTTP arrives:
 *       1. registerMarket.set(slab → newState) at line 1208
 *       2. registerMarket.crankMarket(slab) at line 1222
 *       3. crankAll's fan-out may also call crankMarket(slab) on its
 *          next iteration, depending on Map iteration semantics
 *     → two concurrent crankMarket calls → two concurrent KeeperCrank txs
 *       → wasted gas + doubled funding accrual within the same window.
 *
 *   The single-source-of-truth `_cycling` flag was supposed to gate ALL
 *   crank activity, but only the setInterval body honors it.
 *
 * THE FIX (this PR):
 *   - Add `_inflightMarkets: Set<string>` field.
 *   - In crankMarket, check at entry: if slab is in the set, bail
 *     (return false). Else add to set.
 *   - Wrap the existing try/catch with `finally { delete }` so the guard
 *     is always released, even on throws.
 *   - registerMarket's call to crankMarket now respects the same guard
 *     without any code change to registerMarket itself.
 *
 *   This is also the deferred Option F defense-in-depth from H4 (Agent C
 *   recommended a per-market in-flight guard alongside the watchdog fix).
 *
 * This PoC walks through the race at the observer-shape level.
 */
import { describe, it, expect, vi } from "vitest";

// Mini-reproduction of the relevant shapes.
class Service {
  private _inflightMarkets = new Set<string>();
  onSend = vi.fn<(slab: string) => void>();

  async crankMarket(slab: string, opts: { simulateBody: () => Promise<void> }): Promise<boolean> {
    if (this._inflightMarkets.has(slab)) return false;
    this._inflightMarkets.add(slab);
    try {
      await opts.simulateBody();
      this.onSend(slab);
      return true;
    } finally {
      this._inflightMarkets.delete(slab);
    }
  }
}

describe("M8 PoC — per-market in-flight guard", () => {
  it("OLD pattern: two concurrent calls each send a tx (DUPLICATE)", async () => {
    let sent = 0;
    async function oldCrankMarket(): Promise<boolean> {
      // No guard — just runs the body.
      await new Promise((r) => setTimeout(r, 10));
      sent++;
      return true;
    }

    const [a, b] = await Promise.all([oldCrankMarket(), oldCrankMarket()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(sent).toBe(2); // ← DUPLICATE TX
  });

  it("NEW pattern: second concurrent call returns false, only ONE tx sent", async () => {
    const svc = new Service();

    let releaseBody: (value: unknown) => void;
    const bodyHangs = new Promise((resolve) => { releaseBody = resolve; });

    // First call hangs in the body; second call should see it in flight.
    const first = svc.crankMarket("SLAB-A", { simulateBody: () => bodyHangs as Promise<void> });
    await new Promise((r) => setTimeout(r, 0));
    const second = await svc.crankMarket("SLAB-A", { simulateBody: async () => {} });

    expect(second).toBe(false);
    expect(svc.onSend).not.toHaveBeenCalled();

    releaseBody!(undefined);
    expect(await first).toBe(true);
    expect(svc.onSend).toHaveBeenCalledTimes(1);
  });

  it("NEW pattern: guard is per-slab (different slabs don't block each other)", async () => {
    const svc = new Service();

    let releaseA: (value: unknown) => void;
    const aHangs = new Promise((resolve) => { releaseA = resolve; });

    // SLAB-A hangs.
    const a = svc.crankMarket("SLAB-A", { simulateBody: () => aHangs as Promise<void> });
    await new Promise((r) => setTimeout(r, 0));

    // SLAB-B is a DIFFERENT slab — not blocked by A.
    const b = await svc.crankMarket("SLAB-B", { simulateBody: async () => {} });
    expect(b).toBe(true);
    expect(svc.onSend).toHaveBeenCalledWith("SLAB-B");

    releaseA!(undefined);
    expect(await a).toBe(true);
    expect(svc.onSend).toHaveBeenCalledTimes(2);
  });

  it("NEW pattern: guard releases even when the body throws", async () => {
    const svc = new Service();

    const failed = await svc.crankMarket("SLAB-C", {
      simulateBody: async () => { throw new Error("body crashed"); },
    }).catch(() => "threw");

    // The throw propagates here in this mini-shape, but the SERVICE's
    // finally still ran. A follow-up call on SLAB-C must work.
    expect(failed).toBe("threw");

    const recovery = await svc.crankMarket("SLAB-C", { simulateBody: async () => {} });
    expect(recovery).toBe(true);
  });

  it("NEW pattern: sequential calls work fine (the guard is per-call, not permanent)", async () => {
    const svc = new Service();

    expect(await svc.crankMarket("SLAB-D", { simulateBody: async () => {} })).toBe(true);
    expect(await svc.crankMarket("SLAB-D", { simulateBody: async () => {} })).toBe(true);
    expect(await svc.crankMarket("SLAB-D", { simulateBody: async () => {} })).toBe(true);
    expect(svc.onSend).toHaveBeenCalledTimes(3);
  });
});
