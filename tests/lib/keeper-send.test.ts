import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWithRetryKeeper: vi.fn(async () => "mock-signature"),
}));

vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    estimate = vi.fn(async () => 1_000);
  }
  return { HeliusPriorityFeeEstimator };
});

vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    estimate = vi.fn(async () => 200_000);
  }
  return { CuEstimator };
});

import * as shared from "@percolatorct/shared";
import { keeperSend, classifySendError } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";

function makeDummyIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: PublicKey.default,
    keys: [],
    data: Buffer.from([]),
  });
}

function makeConnection() {
  return {
    simulateTransaction: vi.fn(async () => ({ value: { unitsConsumed: 200_000, err: null, logs: [] } })),
  } as any;
}

describe("keeperSend", () => {
  let budget: KeeperBudget;
  let connection: ReturnType<typeof makeConnection>;
  let keypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();
    budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000, maxTxPerCycle: 100 });
    connection = makeConnection();
    keypair = Keypair.generate();
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
  });

  it("returns a signature result on successful send", async () => {
    const result = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);

    expect(result).not.toBeNull();
    expect(result!.signature).toBe("mock-signature");
    expect(typeof result!.estimatedCost).toBe("number");
    expect(typeof result!.simulatedCu).toBe("number");
    // simulatedCu must match the CuEstimator mock value (200_000)
    expect(result!.simulatedCu).toBe(200_000);
  });

  it("calls sendWithRetryKeeper from shared", async () => {
    await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);

    expect(shared.sendWithRetryKeeper).toHaveBeenCalledTimes(1);
  });

  it("returns null when budget is halted", async () => {
    budget.haltManually("test halt");

    const result = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);

    expect(result).toBeNull();
    expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
  });

  it("records success in budget on successful send", async () => {
    await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);

    const stats = budget.getStats();
    expect(stats.cycleTxCount).toBe(1);
    // spend recorded: estimatedCost > 0
    expect(stats.cycleSpend).toBeGreaterThan(0);
  });

  it("records fail in budget when send throws", async () => {
    vi.mocked(shared.sendWithRetryKeeper).mockRejectedValueOnce(new Error("RPC error"));

    await expect(
      keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget),
    ).rejects.toThrow("RPC error");

    const stats = budget.getStats();
    expect(stats.cycleTxCount).toBe(1);
    // failed txs still consume lamports (fees paid on-chain if landed)
    expect(stats.cycleSpend).toBeGreaterThan(0);
  });

  describe("classifySendError", () => {
    it("classifies a landed-but-reverted tx as 'reverted'", () => {
      expect(classifySendError(new Error('Transaction failed: {"InstructionError":[0,{"Custom":1}]}'))).toBe("reverted");
    });

    it("classifies a confirmation timeout as 'fail' (never landed)", () => {
      expect(classifySendError(new Error("Transaction 5xZ not confirmed after 60000ms"))).toBe("fail");
    });

    it("classifies an RPC/send error as 'fail'", () => {
      expect(classifySendError(new Error("failed to send transaction: 429 Too Many Requests"))).toBe("fail");
      expect(classifySendError("some non-error value")).toBe("fail");
    });
  });

  it("records a reverted tx (excluded from success-rate window) when the send reverts on-chain", async () => {
    vi.mocked(shared.sendWithRetryKeeper).mockRejectedValueOnce(
      new Error('Transaction failed: {"InstructionError":[0,{"Custom":1}]}'),
    );

    await expect(
      keeperSend(connection, [makeDummyIx()], [keypair], "liquidation", budget),
    ).rejects.toThrow("Transaction failed:");

    const stats = budget.getStats();
    // Counts as an attempt + spend, but is NOT a success-rate sample.
    expect(stats.cycleTxCount).toBe(1);
    expect(stats.cycleSpend).toBeGreaterThan(0);
    expect(stats.txWindowSize).toBe(0);
  });

  it("passes maxRetries to sendWithRetryKeeper", async () => {
    await keeperSend(connection, [makeDummyIx()], [keypair], "liquidation", budget, 5);

    expect(shared.sendWithRetryKeeper).toHaveBeenCalledWith(
      connection,
      expect.any(Array),
      expect.any(Array),
      5,
      expect.anything(),
    );
  });

  it("merges keeperOpts with skipPreflight on mainnet+heliusSender", async () => {
    process.env.NETWORK = "mainnet";
    process.env.USE_HELIUS_SENDER = "true";

    await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget, 3, {
      multiRpcBroadcast: true,
    });

    expect(shared.sendWithRetryKeeper).toHaveBeenCalledWith(
      connection,
      expect.any(Array),
      expect.any(Array),
      3,
      expect.objectContaining({ skipPreflight: true, multiRpcBroadcast: true }),
    );

    delete process.env.NETWORK;
    delete process.env.USE_HELIUS_SENDER;
  });

  it("does NOT force skipPreflight on devnet", async () => {
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";

    await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget, 3, {
      skipPreflight: false,
    });

    const callArgs = vi.mocked(shared.sendWithRetryKeeper).mock.calls[0];
    // opts is the 5th arg — skipPreflight should remain false (devnet)
    expect(callArgs![4]).toEqual(expect.objectContaining({ skipPreflight: false }));
  });

  // A.10 (HIGH): DRY_RUN must intercept the actual sendTransaction. Without
  // this, shadow-keeper deployments would still hit mainnet RPC and could
  // accidentally land real transactions through retry/network blips.
  describe("A.10: DRY_RUN intercept", () => {
    let originalDryRun: string | undefined;
    beforeEach(() => {
      originalDryRun = process.env.DRY_RUN;
      process.env.DRY_RUN = "true";
    });
    afterEach(() => {
      if (originalDryRun === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = originalDryRun;
    });

    it("returns a synthetic dry_run_ signature instead of calling the sender", async () => {
      const result = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
      expect(result).not.toBeNull();
      expect(result!.signature).toMatch(/^dry_run_[0-9a-f-]{36}$/);
      expect(result!.simulatedCu).toBe(200_000);
      expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    });

    it("records the would-have-spent estimate to the budget", async () => {
      const before = budget.getStats();
      const result = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
      const after = budget.getStats();
      expect(after.cycleTxCount).toBe(before.cycleTxCount + 1);
      expect(after.cycleSpend).toBe(before.cycleSpend + result!.estimatedCost);
    });

    it("returns null when budget is halted, even in DRY_RUN", async () => {
      budget.haltManually("dry-run halt test");
      const result = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
      expect(result).toBeNull();
      expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    });

    it("each call returns a unique synthetic signature", async () => {
      const sigs = await Promise.all([
        keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget),
        keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget),
        keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget),
      ]);
      const uniq = new Set(sigs.map((r) => r!.signature));
      expect(uniq.size).toBe(3);
    });

    it.skipIf(!process.env.STRESS)(
      "STRESS: 1000 concurrent DRY_RUN sends — zero real RPC traffic, all unique sigs",
      { timeout: 30_000 },
      async () => {
        // A wider budget so the 1k sends don't hit cycle caps.
        const wideBudget = new (await import("../../src/lib/budget.js")).KeeperBudget({
          maxSolPerCycle: Number.MAX_SAFE_INTEGER,
          maxSolPerHour: Number.MAX_SAFE_INTEGER,
          maxSolPerDay: Number.MAX_SAFE_INTEGER,
          maxTxPerCycle: 10_000,
          txSuccessRateThreshold: 0,
          txSuccessRateMinSamples: 1_000_000,
        });
        const N = 1000;
        const sigs = await Promise.all(
          Array.from({ length: N }, () =>
            keeperSend(connection, [makeDummyIx()], [keypair], "crank", wideBudget),
          ),
        );
        const uniq = new Set(sigs.map((r) => r!.signature));
        expect(uniq.size).toBe(N);
        expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
      },
    );
  });

  // Reservation-leak guard: canSpend() reserves; recordTx() must release on
  // EVERY exit path. A leak silently shrinks the effective cap until the budget
  // wedges, so we assert the pending tally returns to zero after each path.
  describe("reservation release (no leak)", () => {
    it("releases the reservation on a successful real send", async () => {
      await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
      expect(budget.getStats().reservedLamports).toBe(0);
      expect(budget.getStats().reservedTxCount).toBe(0);
    });

    it("releases the reservation when the send throws", async () => {
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValueOnce(new Error("RPC error"));
      await expect(
        keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget),
      ).rejects.toThrow("RPC error");
      expect(budget.getStats().reservedLamports).toBe(0);
      expect(budget.getStats().reservedTxCount).toBe(0);
    });

    it("releases the reservation on the DRY_RUN path", async () => {
      process.env.DRY_RUN = "true";
      try {
        await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
        expect(budget.getStats().reservedLamports).toBe(0);
        expect(budget.getStats().reservedTxCount).toBe(0);
      } finally {
        delete process.env.DRY_RUN;
      }
    });

    it("makes NO reservation when canSpend refuses (returns null)", async () => {
      budget.haltManually("test");
      const r = await keeperSend(connection, [makeDummyIx()], [keypair], "crank", budget);
      expect(r).toBeNull();
      expect(budget.getStats().reservedLamports).toBe(0);
      expect(budget.getStats().reservedTxCount).toBe(0);
    });

    it("does not leak across many interleaved success/throw sends", async () => {
      const wide = new KeeperBudget({
        maxSolPerCycle: Number.MAX_SAFE_INTEGER,
        maxSolPerHour: Number.MAX_SAFE_INTEGER,
        maxSolPerDay: Number.MAX_SAFE_INTEGER,
        maxTxPerCycle: 100_000,
        txSuccessRateThreshold: 0,
        txSuccessRateMinSamples: 1_000_000,
      });
      let i = 0;
      vi.mocked(shared.sendWithRetryKeeper).mockImplementation(async () => {
        if (i++ % 2 === 0) throw new Error("flaky");
        return "sig";
      });
      await Promise.allSettled(
        Array.from({ length: 100 }, () =>
          keeperSend(connection, [makeDummyIx()], [keypair], "crank", wide),
        ),
      );
      expect(wide.getStats().reservedLamports).toBe(0);
      expect(wide.getStats().reservedTxCount).toBe(0);
    });
  });
});
