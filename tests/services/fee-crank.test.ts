import { describe, expect, it, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Connection, Keypair } from "@solana/web3.js";

// keeperSend / the tx queue reach for RPC and budget state. Stub them so these
// tests exercise the crank's own decision logic and nothing else.
const sendMock = vi.fn();
vi.mock("../../src/lib/keeper-send.js", () => ({
  keeperSend: (...args: unknown[]) => sendMock(...args),
  sharedBudget: {},
}));
vi.mock("../../src/lib/tx-queue.js", () => ({
  sharedTxQueue: { enqueue: (_k: string, fn: () => Promise<unknown>) => fn() },
}));

// vi.mock calls above are hoisted by vitest, so a static import here still
// receives the stubbed modules.
import {
  classifyRejection,
  extractCustomErrorCode,
  BENIGN_PROGRAM_ERRORS,
  runLegsForMarket,
  runFeeCrankCycle,
  buildSnapshot,
  loadFeeCrankThresholds,
  describeBucketExpiryUrgency,
  expireBackingBucketLeg,
  ALL_LEGS,
} from "../../src/services/fee-crank.js";
import type {
  CrankLeg,
  MarketSnapshot,
  LegContext,
  PendingWork,
} from "../../src/services/fee-crank.js";

const MARKET = new PublicKey("11111111111111111111111111111112");
const PROGRAM = new PublicKey("11111111111111111111111111111113");

function fakeCtx(): LegContext {
  return {
    connection: {} as Connection,
    keypair: { publicKey: new PublicKey("11111111111111111111111111111114") } as Keypair,
    thresholds: loadFeeCrankThresholds(),
  };
}

function fakeSnapshot(): MarketSnapshot {
  return {
    address: MARKET,
    programId: PROGRAM,
    data: new Uint8Array(0),
    group: {
      mode: 0,
      currentSlot: 0n,
      insurance: 0n,
      cTot: 0n,
      materializedPortfolioCount: 0n,
      sourceInsuranceCreditReservedTotalAtoms: 0n,
      insuranceDomainBudgetRemainingTotal: 0n,
      maxMarketSlots: 1,
      assetSlotCount: 1,
    },
    chainSlot: 0n,
  };
}

const work = (reason = "test work"): PendingWork => ({
  reason,
  expectedAtoms: 1_000n,
  instructions: [],
});

function legThatFinds(name: string, items: PendingWork[]): CrankLeg {
  return {
    name: name as CrankLeg["name"],
    tag: 78,
    detect: async () => items,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 0, simulatedCu: 0 });
});

describe("extractCustomErrorCode", () => {
  it("parses the decimal Custom(N) form", () => {
    expect(extractCustomErrorCode(new Error("Transaction failed: Custom(38)"))).toBe(38);
    expect(extractCustomErrorCode(new Error("Error: Custom: 21"))).toBe(21);
    expect(extractCustomErrorCode(new Error("Custom 61 raised"))).toBe(61);
  });

  it("parses the hex custom-program-error form", () => {
    expect(extractCustomErrorCode(new Error("custom program error: 0x26"))).toBe(38);
    expect(extractCustomErrorCode(new Error("custom program error: 0x15"))).toBe(21);
  });

  it("returns null when there is no program error code", () => {
    expect(extractCustomErrorCode(new Error("fetch failed"))).toBeNull();
    expect(extractCustomErrorCode(new Error("blockhash not found"))).toBeNull();
  });
});

describe("classifyRejection — by-design rejections must not alarm", () => {
  it("treats every documented by-design code as benign", () => {
    // The brief's list plus the two the program actually raises for the same
    // situations (41 = no LP shares, 61 = bucket not Fresh-and-lapsed).
    for (const code of [19, 21, 27, 38, 41, 53, 61]) {
      const result = classifyRejection(new Error(`Custom(${code})`));
      expect(result.benign, `Custom(${code}) should be benign`).toBe(true);
      expect(result.code).toBe(code);
      expect(BENIGN_PROGRAM_ERRORS.has(code)).toBe(true);
    }
  });

  it("does NOT swallow an unrecognised program error", () => {
    // The old crankLpVault treated any message containing "Custom" as
    // "no fees to crank". Unauthorized, a bad account, or a genuinely broken
    // market would all have been invisible.
    const result = classifyRejection(new Error("Custom(4)"));
    expect(result.benign).toBe(false);
    expect(result.code).toBe(4);
    expect(result.reason).toMatch(/unexpected program error/i);
  });

  it("does NOT swallow non-program failures", () => {
    for (const message of ["fetch failed", "blockhash not found", "429 Too Many Requests"]) {
      const result = classifyRejection(new Error(message));
      expect(result.benign, `${message} should not be benign`).toBe(false);
      expect(result.code).toBeNull();
    }
  });
});

describe("never crank blind", () => {
  it("sends nothing when every leg reports no pending work", async () => {
    const idleLegs: CrankLeg[] = [
      legThatFinds("lpVaultCrankFees", []),
      legThatFinds("protocolFee", []),
    ];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), idleLegs);
    expect(sendMock).not.toHaveBeenCalled();
    expect(outcomes.every((o) => o.status === "idle")).toBe(true);
  });

  it("sends exactly one transaction per unit of detected work", async () => {
    const legs: CrankLeg[] = [legThatFinds("lpVaultCrankFees", [work("a"), work("b")])];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(2);
  });

  it("tag 89 detection returns nothing on a non-Live market", async () => {
    const snapshot = fakeSnapshot();
    snapshot.group.mode = 2; // Recovery
    const found = await expireBackingBucketLeg.detect(snapshot, fakeCtx());
    expect(found).toEqual([]);
  });
});

describe("failure isolation", () => {
  it("a leg that throws in detect does not stop later legs", async () => {
    const legs: CrankLeg[] = [
      { name: "expireBackingBucket", tag: 89, detect: async () => { throw new Error("boom"); } },
      legThatFinds("lpVaultCrankFees", [work()]),
    ];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    expect(outcomes[0]!.status).toBe("error");
    expect(outcomes[1]!.status).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("a leg whose send fails does not stop later legs", async () => {
    sendMock.mockRejectedValueOnce(new Error("fetch failed"));
    const legs: CrankLeg[] = [
      legThatFinds("lpVaultCrankFees", [work()]),
      legThatFinds("protocolFee", [work()]),
    ];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    expect(outcomes[0]!.status).toBe("error");
    expect(outcomes[1]!.status).toBe("sent");
  });

  it("one failing unit of work does not stop the rest within the same leg", async () => {
    sendMock.mockRejectedValueOnce(new Error("fetch failed"));
    const legs: CrankLeg[] = [legThatFinds("expireBackingBucket", [work("d0"), work("d1"), work("d2")])];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    // A bricked domain must not be left bricked because a sibling domain's
    // transaction happened to fail first.
    expect(outcomes.map((o) => o.status)).toEqual(["error", "sent", "sent"]);
  });

  it("a benign rejection is reported as such, not as an error", async () => {
    sendMock.mockRejectedValueOnce(new Error("Custom(38)"));
    const legs: CrankLeg[] = [legThatFinds("lpVaultCrankFees", [work()])];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    expect(outcomes[0]!.status).toBe("benign-reject");
    expect(outcomes[0]!.reason).toMatch(/LpVaultNoFeesToCrank/);
  });

  it("one market erroring does not stop the loop for other markets", async () => {
    const good = fakeSnapshot();
    const bad = { ...fakeSnapshot(), address: PROGRAM };
    const legs: CrankLeg[] = [
      {
        name: "lpVaultCrankFees",
        tag: 78,
        detect: async (s) => {
          if (s.address.equals(PROGRAM)) throw new Error("market-specific failure");
          return [work()];
        },
      },
    ];
    const outcomes = await runFeeCrankCycle([bad, good], fakeCtx(), legs);
    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "error")).toHaveLength(1);
  });

  it("a budget-gate decline is idle, not an error", async () => {
    sendMock.mockResolvedValueOnce(null);
    const legs: CrankLeg[] = [legThatFinds("lpVaultCrankFees", [work()])];
    const outcomes = await runLegsForMarket(fakeSnapshot(), fakeCtx(), legs);
    expect(outcomes[0]!.status).toBe("idle");
  });
});

describe("leg ordering and thresholds", () => {
  it("runs the liveness-critical bucket expiry before the revenue legs", () => {
    // If a cycle runs out of budget it should run out on revenue, not on the
    // leg that unbricks user funds.
    expect(ALL_LEGS[0]!.tag).toBe(89);
    expect(ALL_LEGS.map((l) => l.tag)).toEqual([89, 78, 87, 84]);
  });

  it("documents why tag 89 has no economic threshold", () => {
    expect(describeBucketExpiryUrgency()).toMatch(/only exit/i);
  });

  it("reads thresholds from env with sensible defaults", () => {
    delete process.env.KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS;
    expect(loadFeeCrankThresholds().protocolAtoms).toBe(1_000_000n);

    process.env.KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS = "250000";
    expect(loadFeeCrankThresholds().protocolAtoms).toBe(250_000n);

    // A malformed threshold must fall back to the default, not become 0 (which
    // would turn the gate off and sweep dust at a loss on every cycle).
    process.env.KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS = "not-a-number";
    expect(loadFeeCrankThresholds().protocolAtoms).toBe(1_000_000n);

    process.env.KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS = "-5";
    expect(loadFeeCrankThresholds().protocolAtoms).toBe(1_000_000n);

    delete process.env.KEEPER_PROTOCOL_FEE_SWEEP_MIN_ATOMS;
  });
});

describe("buildSnapshot", () => {
  it("returns null for an account too short to be a v17 market", () => {
    expect(buildSnapshot(MARKET, PROGRAM, new Uint8Array(512), 0n)).toBeNull();
    expect(buildSnapshot(MARKET, PROGRAM, new Uint8Array(0), 0n)).toBeNull();
  });
});
