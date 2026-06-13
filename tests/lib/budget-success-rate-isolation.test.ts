/**
 * Regression test for the success-rate cross-market DoS.
 *
 * KeeperBudget's tx-success-rate breaker halts ALL sends when the landed-tx
 * success rate over a rolling window drops below the threshold. The window used
 * to count an on-chain REVERT (a tx that landed in a block and the program
 * rejected) as a "fail" — so an attacker who front-runs liquidations to make
 * them revert, or one persistently-reverting market, could drive the GLOBAL
 * rate down and halt cranks/marks/liquidations on every market.
 *
 * The fix: keeperSend classifies a landed-but-reverted tx as "reverted"
 * (counts as spend + attempt, but excluded from the success-rate window), while
 * genuine never-landed failures stay "fail" and still feed the breaker.
 *
 * These tests drive the REAL keeperSend + KeeperBudget. The first asserts that
 * localized reverts no longer halt healthy unrelated sends (fails on old main,
 * passes after the fix); the second asserts a genuine "nothing lands" outage
 * still halts (the breaker is not gutted).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(async () => "mock-signature") }));

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWithRetryKeeper: h.send,
}));
vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator { estimate = vi.fn(async () => 1_000); }
  return { HeliusPriorityFeeEstimator };
});
vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator { estimate = vi.fn(async () => 200_000); }
  return { CuEstimator };
});

import { keeperSend } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import { Keypair, TransactionInstruction, PublicKey } from "@solana/web3.js";
import type { TxType } from "../../src/lib/budget.js";

function ix(): TransactionInstruction {
  return new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([]) });
}
function conn() {
  return { simulateTransaction: vi.fn(async () => ({ value: { unitsConsumed: 200_000, err: null, logs: [] } })) } as any;
}

describe("success-rate breaker: reverts excluded, systemic failures still halt", () => {
  let budget: KeeperBudget;
  const c = conn();
  const kp = Keypair.generate();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    delete process.env.DRY_RUN;
    h.send.mockResolvedValue("mock-signature");
    budget = new KeeperBudget(); // defaults: threshold 0.70, minSamples 10, window 60s
  });

  async function attempt(txType: TxType): Promise<"ok" | "refused" | "failed"> {
    try {
      const r = await keeperSend(c, [ix()], [kp], txType, budget);
      return r === null ? "refused" : "ok";
    } catch {
      return "failed";
    }
  }

  it("FIXED: liquidation reverts do NOT halt healthy cranks (cross-market DoS closed)", async () => {
    // 12 healthy cranks land — well past minSamples, rate 1.0.
    for (let i = 0; i < 12; i++) expect(await attempt("crank")).toBe("ok");

    // Attacker dodges liquidations → each keeper liquidation LANDS and REVERTS.
    // pollSignatureStatus throws "Transaction failed: ..." → classified "reverted".
    h.send.mockRejectedValue(new Error('Transaction failed: {"InstructionError":[0,{"Custom":1}]}'));
    for (let i = 0; i < 15; i++) expect(await attempt("liquidation")).toBe("failed");

    // The keeper is NOT halted, and a healthy crank still goes through — reverts
    // never entered the success-rate window.
    h.send.mockResolvedValue("mock-signature");
    expect(budget.isHalted()).toBe(false);
    expect(await attempt("crank")).toBe("ok");
    expect(budget.getStats().haltKind).toBeUndefined();
    // Window saw only the (successful) cranks — no failures recorded from reverts.
    expect(budget.getStats().txSuccessRate).toBe(1);
  });

  it("reverts still count as spend and attempts (they paid fees)", async () => {
    const before = budget.getStats();
    h.send.mockRejectedValue(new Error('Transaction failed: {"InstructionError":[0,{"Custom":1}]}'));
    await attempt("liquidation");
    const after = budget.getStats();
    expect(after.cycleTxCount).toBe(before.cycleTxCount + 1);
    expect(after.cycleSpend).toBeGreaterThan(before.cycleSpend);
  });

  it("SYSTEMIC: genuine never-landed failures still halt the keeper (breaker intact)", async () => {
    for (let i = 0; i < 5; i++) expect(await attempt("crank")).toBe("ok");
    // Confirmation timeout — the tx never landed. Not a revert → stays "fail".
    h.send.mockRejectedValue(new Error("Transaction 5xZ not confirmed after 60000ms"));
    for (let i = 0; i < 10; i++) await attempt("liquidation");

    expect(budget.isHalted()).toBe(true);
    expect(budget.getStats().haltKind).toBe("tx-success-rate");
    // Latched: a healthy crank is still refused until manual resume.
    h.send.mockResolvedValue("mock-signature");
    expect(await attempt("crank")).toBe("refused");
  });

  it("SYSTEMIC: RPC/send errors (never landed) also still halt", async () => {
    for (let i = 0; i < 5; i++) expect(await attempt("crank")).toBe("ok");
    h.send.mockRejectedValue(new Error("failed to send transaction: 429 Too Many Requests"));
    for (let i = 0; i < 10; i++) await attempt("crank");
    expect(budget.isHalted()).toBe(true);
    expect(budget.getStats().haltKind).toBe("tx-success-rate");
  });
});
