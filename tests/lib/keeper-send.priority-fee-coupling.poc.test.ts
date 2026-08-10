/**
 * PoC — CRITICAL: budget gate is decoupled from the priority fee actually broadcast.
 *
 * keeperSend computes a tier-aware priority-fee estimate (HeliusPriorityFeeEstimator)
 * and a CU estimate, then gates the budget on
 *     estimatedCost = base + microLamports * simulatedCu / 1e6
 * ...and hands `sendWithRetryKeeper` an options object containing NEITHER
 * `priorityFeeMicroLamports` NOR `computeUnitLimit`.
 *
 * Per @percolatorct/shared (#311), when those overrides are absent the shared
 * sender derives the broadcast fee ITSELF from `getRecentPrioritizationFees` — a
 * DIFFERENT, RPC-controlled source — with a floor-only `Math.max(fee, 1_000)` and
 * NO ceiling, then broadcasts it via setComputeUnitPrice(microLamports).
 *
 * Exploit: a malicious or merely spiking RPC answers the keeper's estimator call
 * with a small fee (budget approves ~5_200 lamports) and answers
 * getRecentPrioritizationFees with an arbitrarily large p75. The keeper signs and
 * broadcasts a priority bid bounded only by wallet balance, while the budget
 * booked the small estimate. The override that prevents exactly this already
 * exists in shared — its JSDoc says "so the budget the caller gated on is the one
 * actually broadcast" — the keeper simply never populates it.
 *
 * This PoC captures the options keeperSend hands the (mocked) shared sender and
 * asserts the broadcast fee + CU equal the budget-gated estimate. It FAILS before
 * the fix (options undefined → shared would broadcast the RPC's fee) and PASSES
 * after keeperSend plumbs its gated estimate through.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// What the keeper's estimator returns — the value the budget gate approves.
const GATED_FEE_MICROLAMPORTS = 1_000;
const GATED_CU = 200_000;
// What a hostile/degraded RPC returns from getRecentPrioritizationFees — the
// value the shared sender broadcasts when the keeper passes no override.
const HOSTILE_RPC_P75_MICROLAMPORTS = 1_000_000_000;

// Capture the keeperOpts (5th arg) keeperSend hands the shared sender.
const captured: { opts: any } = { opts: undefined };

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWithRetryKeeper: vi.fn(async (_conn, _ix, _signers, _maxRetries, keeperOpts) => {
    captured.opts = keeperOpts;
    return "mock-sig";
  }),
}));

vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    estimate = vi.fn(async () => GATED_FEE_MICROLAMPORTS);
  }
  return { HeliusPriorityFeeEstimator };
});

vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    estimate = vi.fn(async () => ({ cu: GATED_CU, provenToFail: false }));
  }
  return { CuEstimator };
});

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
    simulateTransaction: vi.fn(async () => ({
      value: { unitsConsumed: GATED_CU, err: null, logs: [] },
    })),
    getTransaction: vi.fn(async () => ({ meta: { fee: 5_000, err: null } })),
  } as any;
}

describe("PoC: budget-gated priority fee must equal the broadcast priority fee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.opts = undefined;
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    process.env.KEEPER_REALIZED_COST_SAMPLE_PCT = "0"; // no post-send reconciliation timer
    delete process.env.PRIORITY_FEE_MICROLAMPORTS;
    delete process.env.DRY_RUN;
  });

  it("plumbs the gated priority fee + CU into the shared sender (no RPC-controlled bid)", async () => {
    // Cap approves the GATED cost (~5_200) but is ~192_000x below the hostile bid
    // (base 5_000 + 1e9 * 200_000 / 1e6 = ~200_005_000 lamports).
    const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
    const keypair = Keypair.generate();

    const result = await keeperSend(
      makeConnection(),
      [makeDummyIx()],
      [keypair],
      "liquidation",
      budget,
      3,
    );

    expect(result).not.toBeNull();
    expect(captured.opts).toBeDefined();

    // Model the shared sender's selection (verified in @percolatorct/shared):
    //   fee = keeperOpts?.priorityFeeMicroLamports ?? getRecentPrioritizationFees()
    //   cu  = keeperOpts?.computeUnitLimit          ?? 400_000
    const broadcastFee =
      captured.opts.priorityFeeMicroLamports ?? HOSTILE_RPC_P75_MICROLAMPORTS;
    const broadcastCu = captured.opts.computeUnitLimit ?? 400_000;

    // The broadcast MUST equal what the budget gated on — not the RPC's fee.
    expect(broadcastFee).toBe(GATED_FEE_MICROLAMPORTS);
    expect(broadcastCu).toBe(GATED_CU);
  });

  it("the override fee equals the estimator output the budget approved (coupling invariant)", async () => {
    const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
    const keypair = Keypair.generate();

    const result = await keeperSend(
      makeConnection(),
      [makeDummyIx()],
      [keypair],
      "crank",
      budget,
      3,
    );

    expect(result).not.toBeNull();
    expect(captured.opts?.priorityFeeMicroLamports).toBe(GATED_FEE_MICROLAMPORTS);
  });

  it("a caller-supplied override still wins (does not clobber an explicit fee)", async () => {
    const budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000 });
    const keypair = Keypair.generate();

    const result = await keeperSend(
      makeConnection(),
      [makeDummyIx()],
      [keypair],
      "crank",
      budget,
      3,
      { priorityFeeMicroLamports: 7_777, computeUnitLimit: 123_456 },
    );

    expect(result).not.toBeNull();
    expect(captured.opts?.priorityFeeMicroLamports).toBe(7_777);
    expect(captured.opts?.computeUnitLimit).toBe(123_456);
  });
});
