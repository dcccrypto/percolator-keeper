/**
 * PoC for finding M13: TOCTOU in keeperSend single-writer guard.
 *
 * PR #191 added `_isLeader()` check at the ENTRY of keeperSend (line 190). But
 * the actual on-chain `sendWithRetryKeeper` call doesn't happen until line 282,
 * after an `await estimateCost(...)` that takes 100-500ms (priority-fee fetch +
 * CU simulation). If the node loses leadership during that await window — a
 * single Redis blip is enough — the demoted node still sends, defeating the
 * host-local single-writer barrier and racing with the new leader.
 *
 * Threat model:
 *   1. Node A is leader, dequeues a liquidation tx; keeperSend gate at line 190
 *      sees leader=true.
 *   2. estimateCost begins (~200ms: priority-fee fetch + CU sim).
 *   3. During the await, a Redis renew blip flips Node A to standby.
 *   4. estimateCost returns; canSpend passes; sendWithRetryKeeper at line 282
 *      runs WITHOUT a re-check, landing the tx after demotion.
 *   5. New leader Node B also picks up the same liquidation candidate. Double-send.
 *
 * Fix: re-check `_isLeader()` immediately before sendWithRetryKeeper and abort
 * (release reservation as "drop", return null) if leadership was lost.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWithRetryKeeper: vi.fn(async () => "mock-signature"),
}));
vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    // Slow estimate to simulate the realistic ~100-500ms fetch latency.
    estimate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 1_000;
    });
  }
  return { HeliusPriorityFeeEstimator };
});
vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    estimate = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 200_000;
    });
  }
  return { CuEstimator };
});

import * as shared from "@percolatorct/shared";
import { keeperSend, setLeaderCheck } from "../../src/lib/keeper-send.js";
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
function makeConnection() {
  return {
    simulateTransaction: vi.fn(async () => ({
      value: { unitsConsumed: 200_000, err: null, logs: [] },
    })),
  } as any;
}

describe("M13 PoC — keeperSend leader gate TOCTOU between entry-check and send", () => {
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
    setLeaderCheck(() => true);
  });

  it("REGRESSION: a node demoted DURING estimateCost must NOT call sendWithRetryKeeper", async () => {
    // Stateful leader check: starts true (so the entry gate passes), then flips
    // to false partway through the call to simulate a renew-driven demotion
    // mid-flight while estimateCost is still awaiting.
    let isLeader = true;
    setLeaderCheck(() => isLeader);

    // Kick off the send and, after a short delay, demote.
    const sendPromise = keeperSend(
      connection,
      [makeDummyIx()],
      [keypair],
      "liquidation",
      budget,
    );
    // Demote ~30ms in — well before the estimateCost mocks (50ms each, ~100ms
    // total) finish.
    setTimeout(() => {
      isLeader = false;
    }, 30);

    const result = await sendPromise;

    // PRE-FIX: result is non-null, sendWithRetryKeeper was called, budget charged.
    // POST-FIX: result is null, no send, no spend booked.
    expect(result).toBeNull();
    expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    // No spend should be booked on a demotion-aborted send.
    expect(budget.getStats().cycleSpend).toBe(0);
  });

  it("REGRESSION: leadership lost between canSpend reservation and send must release the reservation", async () => {
    // After the fix, the second leader check sits between canSpend (which
    // reserves) and sendWithRetryKeeper. If we abort there, the reservation
    // must be released as "drop" (no spend booked) so the budget stays sane.
    let isLeader = true;
    setLeaderCheck(() => isLeader);

    const sendPromise = keeperSend(
      connection,
      [makeDummyIx()],
      [keypair],
      "liquidation",
      budget,
    );
    setTimeout(() => {
      isLeader = false;
    }, 30);
    const result = await sendPromise;

    expect(result).toBeNull();
    // Reservation drained, no settled spend.
    expect(budget.getStats().cycleSpend).toBe(0);
    expect(budget.getStats().reservedLamports).toBe(0);
    expect(budget.getStats().reservedTxCount).toBe(0);
    // Attempt was counted but it was a "drop" — no success/fail success-rate poison.
    expect(budget.getStats().cycleTxCount).toBe(1);
  });

  it("BASELINE: when leadership is held throughout, send proceeds as normal", async () => {
    setLeaderCheck(() => true);
    const result = await keeperSend(
      connection,
      [makeDummyIx()],
      [keypair],
      "liquidation",
      budget,
    );
    expect(result).not.toBeNull();
    expect(shared.sendWithRetryKeeper).toHaveBeenCalledTimes(1);
  });
});
