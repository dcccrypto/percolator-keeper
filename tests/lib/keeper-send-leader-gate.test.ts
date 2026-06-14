/**
 * Single-writer guard: keeperSend must refuse to send when the node is not the
 * leader (e.g. a task dequeued from sharedTxQueue after an HA demotion). This is
 * the host-local barrier against a demoted node double-landing on-chain txs,
 * since the on-chain programs are permissionless.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWithRetryKeeper: vi.fn(async () => "mock-signature"),
}));
vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator { estimate = vi.fn(async () => 1_000); }
  return { HeliusPriorityFeeEstimator };
});
vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator { estimate = vi.fn(async () => 200_000); }
  return { CuEstimator };
});

import * as shared from "@percolatorct/shared";
import { keeperSend, setLeaderCheck } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";

function makeDummyIx(): TransactionInstruction {
  return new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([]) });
}
function makeConnection() {
  return {
    simulateTransaction: vi.fn(async () => ({ value: { unitsConsumed: 200_000, err: null, logs: [] } })),
  } as any;
}

describe("keeperSend single-writer (leadership) gate", () => {
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
  afterEach(() => {
    setLeaderCheck(() => true); // restore module default so other suites are unaffected
    delete process.env.DRY_RUN;
  });

  it("returns null and does NOT send when the node is not leader", async () => {
    setLeaderCheck(() => false);

    const result = await keeperSend(connection, [makeDummyIx()], [keypair], "liquidation", budget);

    expect(result).toBeNull();
    expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    expect(connection.simulateTransaction).not.toHaveBeenCalled(); // gated before any RPC
    expect(budget.getStats().cycleTxCount).toBe(0); // budget not charged
  });

  it("sends normally when the node is leader", async () => {
    setLeaderCheck(() => true);

    const result = await keeperSend(connection, [makeDummyIx()], [keypair], "liquidation", budget);

    expect(result).not.toBeNull();
    expect(result?.signature).toBe("mock-signature");
    expect(shared.sendWithRetryKeeper).toHaveBeenCalledTimes(1);
  });
});
