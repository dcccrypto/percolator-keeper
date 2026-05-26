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
import { keeperSend } from "../../src/lib/keeper-send.js";
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
});
