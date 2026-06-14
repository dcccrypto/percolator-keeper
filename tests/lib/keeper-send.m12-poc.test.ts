/**
 * PoC for finding M12: budget records estimated cost, not realized cost.
 *
 * BEFORE the fix: `keeperSend` calls `budget.recordTx(estimatedCost, …)` and
 * never reconciles against the actual on-chain fee. If the CU estimator
 * systematically under-counts the units consumed, the budget gate keeps
 * letting tx through long after the keeper's real SOL spend exceeds the
 * cycle/hour/day caps. This PoC demonstrates the gap and proves the
 * `adjustForRealizedCost` reconciliation closes it.
 *
 * The PoC operates at the budget+keeperSend layer (no live RPC) so it runs
 * deterministically in CI. The realistic numbers are:
 *   estimated CU = 200_000 (CuEstimator default) → estimatedCost = 5_000 + 200 = 5_200
 *   realized CU  = 600_000 (3× under-estimate)   → realizedFee = 5_000 + 600 = 5_600
 * Per-tx drift = +400 lamports. Over 100 tx that's 40_000 lamports of
 * unaccounted spend — enough to silently blow through a tight cycle cap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWithRetryKeeper: vi.fn(async () => "mock-sig"),
}));

vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    estimate = vi.fn(async () => 1_000); // microLamports
  }
  return { HeliusPriorityFeeEstimator };
});

vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    // Simulator says 200k. Reality (below) will be 600k.
    estimate = vi.fn(async () => 200_000);
  }
  return { CuEstimator };
});

import { keeperSend } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import {
  Keypair,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";

function makeDummyIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: PublicKey.default,
    keys: [],
    data: Buffer.from([]),
  });
}

function makeConnection(realizedFeePerTx: number) {
  return {
    simulateTransaction: vi.fn(async () => ({
      value: { unitsConsumed: 200_000, err: null, logs: [] },
    })),
    // The reconciliation fetcher reads `meta.fee` off the tx receipt.
    getTransaction: vi.fn(async () => ({
      meta: { fee: realizedFeePerTx, err: null },
    })),
  } as any;
}

describe("M12 PoC — budget reconciliation against realized on-chain cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    // Reconcile every tx so the assertion is deterministic.
    process.env.KEEPER_REALIZED_COST_SAMPLE_PCT = "100";
    // Speed up the reconciliation timer to avoid 5s per tx in tests.
    // (The keeper-send module reads it lazily inside the IIFE.)
  });

  it("VULN: without reconciliation, budget under-counts when CU is under-estimated", async () => {
    // Pretend M12 fix isn't installed: just record estimated and look at the gap.
    const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
    // estimatedCost for these mocks: base 5_000 + ceil(1_000 * 200_000 / 1_000_000) = 5_200
    const estimatedCost = 5_200;
    const realizedCost = 5_600; // what it would have been with CU=600k
    const N = 100;
    for (let i = 0; i < N; i++) {
      budget.recordTx(estimatedCost, "crank", "success");
    }
    const stats = budget.getStats();
    expect(stats.cycleSpend).toBe(N * estimatedCost); // 520_000
    // The "true" spend the keeper actually paid on-chain:
    const trueSpend = N * realizedCost; // 560_000
    const undercount = trueSpend - stats.cycleSpend;
    expect(undercount).toBe(40_000); // 8% blind spot per 100 tx
  });

  it("FIX: adjustForRealizedCost closes the gap between estimated and realized spend", async () => {
    const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
    const estimatedCost = 5_200;
    const realizedCost = 5_600;
    const N = 100;
    for (let i = 0; i < N; i++) {
      budget.recordTx(estimatedCost, "crank", "success");
      budget.adjustForRealizedCost(estimatedCost, realizedCost, "crank");
    }
    const stats = budget.getStats();
    // cycleSpend now reflects actual on-chain cost, not the estimator's view.
    expect(stats.cycleSpend).toBe(N * realizedCost); // 560_000
    expect(stats.realizedCostSamples).toBe(N);
    expect(stats.realizedCostDriftLamports).toBe(N * (realizedCost - estimatedCost)); // 40_000
  });

  it("INTEGRATION: keeperSend schedules a reconciliation that updates budget after send", async () => {
    // 5s reconciliation timer — use fake timers to fast-forward.
    vi.useFakeTimers();
    try {
      const realizedFee = 5_600;
      const connection = makeConnection(realizedFee);
      const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
      const keypair = Keypair.generate();

      const result = await keeperSend(
        connection,
        [makeDummyIx()],
        [keypair],
        "crank",
        budget,
      );

      expect(result).not.toBeNull();
      // recordTx fires synchronously in keeperSend's finally block:
      const before = budget.getStats();
      expect(before.cycleSpend).toBe(result!.estimatedCost);
      expect(before.realizedCostSamples).toBe(0);

      // The reconciliation sleeps 5s before calling getTransaction.
      // Advance timers + flush microtasks so the async block runs to completion.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(connection.getTransaction).toHaveBeenCalledTimes(1);
      const after = budget.getStats();
      expect(after.realizedCostSamples).toBe(1);
      // realizedTotal = realizedFee + 0 jito tip (USE_HELIUS_SENDER=false)
      const delta = realizedFee - result!.estimatedCost;
      expect(after.realizedCostDriftLamports).toBe(delta);
      expect(after.cycleSpend).toBe(result!.estimatedCost + delta);
    } finally {
      vi.useRealTimers();
    }
  });

  it("INTEGRATION: getTransaction failure does NOT propagate or halt the keeper", async () => {
    vi.useFakeTimers();
    try {
      const connection = {
        simulateTransaction: vi.fn(async () => ({
          value: { unitsConsumed: 200_000, err: null, logs: [] },
        })),
        getTransaction: vi.fn(async () => {
          throw new Error("RPC down");
        }),
      } as any;
      const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
      const keypair = Keypair.generate();

      const result = await keeperSend(
        connection,
        [makeDummyIx()],
        [keypair],
        "crank",
        budget,
      );

      expect(result).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      // No reconciliation recorded, but the keeper is still healthy.
      const stats = budget.getStats();
      expect(stats.realizedCostSamples).toBe(0);
      expect(stats.halted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
