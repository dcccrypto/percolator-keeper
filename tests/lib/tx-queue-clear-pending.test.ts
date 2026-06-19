/**
 * TxQueue.clearPending() drops queued-but-not-started tasks across all lanes.
 * Used on involuntary HA demotion so a node that lost leadership does not run a
 * backlog of doomed sends.
 */
import { describe, it, expect, vi } from "vitest";
import { TxQueue } from "../../src/lib/tx-queue.js";

describe("TxQueue.clearPending", () => {
  it("drops queued-but-not-started tasks; their fn never runs", async () => {
    // concurrency 1 so only the first task starts; the rest sit pending.
    const q = new TxQueue({
      liquidation: { concurrency: 1, intervalCap: 100, interval: 1 },
      oracle: { concurrency: 1, intervalCap: 100, interval: 1 },
      crank: { concurrency: 1, intervalCap: 100, interval: 1 },
    });

    let releaseFirst!: () => void;
    const block = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const ran: string[] = [];
    // First task blocks until we release it — keeps the single slot busy.
    const p1 = q.enqueue("liquidation", async () => { ran.push("first"); await block; });
    // These queue behind it and must be dropped by clearPending().
    const dropped = ["a", "b", "c"].map((id) =>
      q.enqueue("liquidation", async () => { ran.push(id); }),
    );

    // Let the first task start (occupy the slot) so a,b,c are pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(q.getStats().liquidation.pending).toBeGreaterThan(0);

    q.clearPending();

    await expect(Promise.all(dropped)).rejects.toThrow("TxQueue task cleared before dispatch");

    // Release the in-flight task and give the loop a few ticks — a,b,c must not run.
    releaseFirst();
    await p1;
    await new Promise((r) => setTimeout(r, 20));

    expect(ran).toEqual(["first"]); // only the already-started task ran
    expect(q.getStats().liquidation.pending).toBe(0);
  });

  it("is a safe no-op on an empty queue", () => {
    const q = new TxQueue();
    expect(() => q.clearPending()).not.toThrow();
    for (const lane of ["liquidation", "oracle", "crank"] as const) {
      expect(q.getStats()[lane].pending).toBe(0);
    }
  });
});
