/**
 * Regression test for the CRITICAL budget self-halt.
 *
 * KeeperBudget caps maxTxPerCycle (default 60) and maxSolPerCycle (default
 * 0.05 SOL) per cycle. Those counters used to be reset only by beginCycle(),
 * which had NO production caller — so recordTx() accumulated them for the whole
 * process lifetime and canSpend() permanently latched a halt after ~60
 * cumulative sends, after which keeperSend() returned null for EVERY send
 * (cranks, liquidations, HYPERP marks, ADL), silently and unrecoverably.
 *
 * The fix makes the per-cycle window reset itself on a timer (cycleWindowMs),
 * so no caller is required. These tests drive the REAL keeperSend + KeeperBudget
 * with an injected clock and assert:
 *   1. under sustained, realistically-spaced load the keeper never self-halts;
 *   2. a genuine within-window burst still trips the cap (the brake survives)
 *      and is recoverable via resume().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWithRetryKeeper: vi.fn(async () => "mock-signature"),
  sendCriticalAlert: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator { estimate = vi.fn(async () => 1_000); }
  return { HeliusPriorityFeeEstimator };
});
vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator { estimate = vi.fn(async () => ({ cu: 200_000, provenToFail: false })); }
  return { CuEstimator };
});

import { keeperSend } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
function ix(): TransactionInstruction {
  return new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([]) });
}
function conn() {
  return { simulateTransaction: vi.fn(async () => ({ value: { unitsConsumed: 200_000, err: null, logs: [] } })) } as any;
}

describe("KeeperBudget cycle-reset regression (drives the real keeperSend)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    delete process.env.DRY_RUN;
  });

  it("FIXED: sustained multi-window load never self-halts (no beginCycle() caller)", async () => {
    // Default caps (maxTxPerCycle = 60, cycleWindowMs = 30s). Drive 50 cycles
    // of 30 sends each = 1_500 sends — 25x the old 60-send fuse — advancing the
    // clock one window between cycles, exactly how production spacing looks.
    const clock = makeClock();
    const budget = new KeeperBudget({}, { now: clock.now });
    const kp = Keypair.generate();
    const c = conn();
    let refused = 0;
    for (let cycle = 0; cycle < 50; cycle++) {
      for (let i = 0; i < 30; i++) {
        if ((await keeperSend(c, [ix()], [kp], "crank", budget)) === null) refused++;
      }
      clock.advance(30_000); // next cycle window
    }
    expect(budget.isHalted()).toBe(false);
    expect(refused).toBe(0);
  });

  it("#333: a within-window crank burst beyond the cap is soft-refused (no halt) and auto-recovers", async () => {
    // No clock advance → all sends fall in one window. With default config
    // (maxTxPerCycle=60, reservedCriticalTxPerCycle=10) "crank" sees an
    // effective cap of 50, so the 51st+ crank is refused — but as SOFT
    // backpressure, NOT a latching halt (#333). An attacker driving crank/
    // provisioning volume can no longer wedge the whole keeper.
    const clock = makeClock();
    const budget = new KeeperBudget({}, { now: clock.now });
    const kp = Keypair.generate();
    const c = conn();
    let refused = 0;
    for (let i = 0; i < 80; i++) {
      if ((await keeperSend(c, [ix()], [kp], "crank", budget)) === null) refused++;
    }
    expect(budget.isHalted()).toBe(false); // soft backpressure — no latch
    expect(budget.getStats().haltKind).toBeUndefined();
    expect(refused).toBeGreaterThan(0); // sends past the effective cap were deferred

    // Auto-recovers next window WITHOUT any operator resume().
    clock.advance(30_000);
    expect(await keeperSend(c, [ix()], [kp], "crank", budget)).not.toBeNull();
    expect(budget.isHalted()).toBe(false);
  });

  it("#333: reserved critical capacity — a crank flood still leaves room for a liquidation", async () => {
    // Saturate the routine (crank) lane within one window. The reserved slots
    // (default 10) are held back from crank, so a liquidation still lands even
    // though crank is fully backpressured.
    const clock = makeClock();
    const budget = new KeeperBudget({}, { now: clock.now });
    const kp = Keypair.generate();
    const c = conn();
    for (let i = 0; i < 60; i++) {
      await keeperSend(c, [ix()], [kp], "crank", budget); // floods up to the 50-slot crank cap
    }
    // crank is now refused (effective cap 50 reached)…
    expect(await keeperSend(c, [ix()], [kp], "crank", budget)).toBeNull();
    // …but a liquidation uses the FULL cap of 60, so reserved slots remain.
    expect(await keeperSend(c, [ix()], [kp], "liquidation", budget)).not.toBeNull();
    expect(budget.isHalted()).toBe(false);
  });
});
