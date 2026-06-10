/**
 * M3 PoC — MonitorService.notifyAdlTx() exposed but never invoked by the
 * ADL success path. Dead wiring in the observability layer.
 *
 * THE BUG (pre-fix):
 *   src/services/monitor.ts:105-110 defines notifyAdlTx(slabAddress) which
 *   updates _adlTxCounts and the per-market cycleCountAtLastAdl invariant
 *   gauge. CrankService wires its analogous notifyCrankCycle via
 *   setOnCrankCycle (index.ts:225). But AdlService has NO equivalent
 *   notification hook, and adl.ts:508-553 (the success path) only logs
 *   "ADL tx sent" without invoking the monitor.
 *
 *   Consequence: the per-market cycleCountAtLastAdl gauge stays at 0
 *   forever, even when ADL fires. Downstream "ADL stale" invariants (which
 *   compute staleness as cycles-since-last-ADL) report perpetual staleness,
 *   masking real degradation.
 *
 * THE FIX (this PR):
 *   - Add setOnAdlTx(fn) to AdlService (mirrors setOnCrankCycle pattern).
 *   - Invoke _onAdlTx(slabAddress) in the success path after each
 *     successful ExecuteAdl tx.
 *   - Wire from index.ts: adlService.setOnAdlTx(slab =>
 *     monitorService.notifyAdlTx(slab)).
 *
 * This PoC demonstrates the dead-wiring pattern at the observer-shape level.
 */
import { describe, it, expect, vi } from "vitest";

// Mini reproduction of the relevant shapes.
class FakeMonitor {
  adlTxCounts = new Map<string, number>();
  notifyAdlTx(slabAddress: string): void {
    this.adlTxCounts.set(slabAddress, (this.adlTxCounts.get(slabAddress) ?? 0) + 1);
  }
}

// OLD pattern: ADL service has no observer hook. The monitor's notifyAdlTx
// is never called even though ExecuteAdl succeeds.
async function oldAdlCycle(monitor: FakeMonitor, slabAddress: string): Promise<{ sent: number }> {
  let sent = 0;
  // ...build ix, send tx, log "ADL tx sent"...
  // (NO call to monitor.notifyAdlTx — that's the bug)
  sent++;
  return { sent };
}

// NEW pattern: ADL service exposes setOnAdlTx and invokes it in the success path.
class NewAdlService {
  private _onAdlTx?: (slab: string) => void;
  setOnAdlTx(fn: (slab: string) => void): void { this._onAdlTx = fn; }
  async cycle(slabAddress: string): Promise<{ sent: number }> {
    let sent = 0;
    // ...send tx...
    if (this._onAdlTx) {
      try { this._onAdlTx(slabAddress); } catch { /* swallow */ }
    }
    sent++;
    return { sent };
  }
}

describe("M3 PoC — wire MonitorService.notifyAdlTx into ADL success path", () => {
  it("OLD pattern: monitor's notifyAdlTx is NEVER invoked even after a successful ADL tx", async () => {
    const monitor = new FakeMonitor();
    const spy = vi.spyOn(monitor, "notifyAdlTx");

    await oldAdlCycle(monitor, "MARKET-A");
    await oldAdlCycle(monitor, "MARKET-A");

    expect(spy).not.toHaveBeenCalled();
    expect(monitor.adlTxCounts.get("MARKET-A")).toBeUndefined();
    // ↑ cycleCountAtLastAdl invariant gauge stays at 0 forever.
  });

  it("NEW pattern: monitor.notifyAdlTx is invoked exactly once per successful ADL tx", async () => {
    const monitor = new FakeMonitor();
    const adl = new NewAdlService();
    adl.setOnAdlTx((slab) => monitor.notifyAdlTx(slab));

    await adl.cycle("MARKET-A");
    await adl.cycle("MARKET-A");
    await adl.cycle("MARKET-B");

    expect(monitor.adlTxCounts.get("MARKET-A")).toBe(2);
    expect(monitor.adlTxCounts.get("MARKET-B")).toBe(1);
    // ↑ Per-market gauges update; invariant layer sees ADL activity.
  });

  it("NEW pattern: observer throwing does not abort the ADL cycle (swallow + continue)", async () => {
    const adl = new NewAdlService();
    adl.setOnAdlTx(() => { throw new Error("observer crashed"); });

    // Cycle should still complete cleanly.
    const result = await adl.cycle("MARKET-A");
    expect(result.sent).toBe(1);
  });

  it("NEW pattern: no observer registered → cycle works exactly as before (zero subscribers OK)", async () => {
    const adl = new NewAdlService();
    // No setOnAdlTx call — _onAdlTx stays undefined.

    const result = await adl.cycle("MARKET-A");
    expect(result.sent).toBe(1);
  });
});
