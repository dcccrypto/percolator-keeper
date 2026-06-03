import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  shadowDecisionsTotal: { inc: vi.fn() },
  shadowMatchTotal: { inc: vi.fn() },
  shadowDivergencePct: { set: vi.fn() },
}));

import * as shared from "@percolatorct/shared";
import { ShadowHarness, computeDivergencePct } from "../../src/lib/shadow-harness.js";
import type { DecisionEntry } from "../../src/lib/decision-log.js";
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

function makeDecision(
  txType: DecisionEntry["txType"] = "crank",
  market = "F4HytAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
): DecisionEntry {
  return {
    timestamp: new Date().toISOString(),
    txType,
    market,
    accounts: ["pk1", "pk2"],
    instructionData: "AQIDBAUG",
    estimatedCost: 5_000,
    reasonChain: [],
  };
}

function makeConnection(signatureCount = 5, nowMs?: number): Connection {
  // Anchor blockTimes inside the harness's window. Defaults to real wall-clock
  // so tests not using `now:` injection keep working; tests with mocked time
  // pass the same `nowMs` so blockTimes fall in [now-60s, now].
  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  return {
    getSignaturesForAddress: vi.fn(async () =>
      Array.from({ length: signatureCount }, (_, i) => ({
        signature: `sig_${i}`,
        slot: 1_000_000 + i,
        blockTime: now - (i % 60),
        err: null,
        memo: null,
        confirmationStatus: "finalized" as const,
      })),
    ),
  } as unknown as Connection;
}

function makeHarness(
  decisions: DecisionEntry[],
  signatureCount = decisions.length,
): ShadowHarness {
  const conn = makeConnection(signatureCount);
  return new ShadowHarness({
    connection: conn,
    programId: PROGRAM_ID,
    readDecisions: vi.fn(async () => decisions),
    compareWindowMs: 300_000,
    // C4: knobs default to production values; individual tests override.
    silentCyclesBeforeAlert: 3,
    runawayMultiplier: 3,
    runawayMinSamples: 10,
    alertCooldownMs: 3_600_000,
  });
}

describe("computeDivergencePct — pure formula", () => {
  it("returns 0 when both are 0", () => {
    expect(computeDivergencePct(0, 0)).toBe(0);
  });

  it("returns 0 when shadow === live (perfect match)", () => {
    expect(computeDivergencePct(10, 10)).toBe(0);
    expect(computeDivergencePct(1, 1)).toBe(0);
    expect(computeDivergencePct(1000, 1000)).toBe(0);
  });

  it("returns 100 when one side is 0", () => {
    expect(computeDivergencePct(0, 100)).toBe(100);
    expect(computeDivergencePct(100, 0)).toBe(100);
  });

  it("returns correct percentage for partial divergence", () => {
    // shadow=50, live=100 → diff=50, max=100 → 50%
    expect(computeDivergencePct(50, 100)).toBe(50);
    // shadow=100, live=50 → diff=50, max=100 → 50%
    expect(computeDivergencePct(100, 50)).toBe(50);
  });

  it("result is always in [0, 100]", () => {
    expect(computeDivergencePct(0, 0)).toBeGreaterThanOrEqual(0);
    expect(computeDivergencePct(Number.MAX_SAFE_INTEGER, 0)).toBeLessThanOrEqual(100);
  });
});

describe("ShadowHarness — comparison logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SHADOW_HARNESS_ENABLED;
  });

  it("returns zero divergence when shadow and live counts match", async () => {
    const decisions = Array.from({ length: 5 }, () => makeDecision());
    const harness = makeHarness(decisions, 5);
    const result = await harness.runCycle();
    expect(result.shadowTotal).toBe(5);
    expect(result.liveTotal).toBe(5);
    expect(result.divergencePct).toBe(0);
  });

  it("detects live-only divergence (live > shadow)", async () => {
    const decisions = Array.from({ length: 3 }, () => makeDecision());
    const harness = makeHarness(decisions, 10); // 10 live, 3 shadow
    const result = await harness.runCycle();
    expect(result.shadowTotal).toBe(3);
    expect(result.liveTotal).toBe(10);
    expect(result.divergencePct).toBeGreaterThan(0);
  });

  it("detects shadow-only divergence (shadow > live)", async () => {
    const decisions = Array.from({ length: 20 }, () => makeDecision());
    const harness = makeHarness(decisions, 5); // 5 live, 20 shadow
    const result = await harness.runCycle();
    expect(result.shadowTotal).toBe(20);
    expect(result.liveTotal).toBe(5);
    expect(result.divergencePct).toBeGreaterThan(0);
  });

  it("per-txType breakdown in shadowByType is accurate", async () => {
    const decisions = [
      ...Array.from({ length: 4 }, () => makeDecision("crank")),
      ...Array.from({ length: 6 }, () => makeDecision("liquidation")),
    ];
    const harness = makeHarness(decisions, 10);
    const result = await harness.runCycle();
    expect(result.shadowByType["crank"]).toBe(4);
    expect(result.shadowByType["liquidation"]).toBe(6);
    expect(result.shadowByType["oracle"]).toBeUndefined();
  });

  // C4 (CRITICAL): the old `divergencePct > threshold` alert was structurally
  // broken — liveTotal includes every program tx (traders/makers/oracles),
  // not just the keeper's. It would fire every cycle on day 1 of mainnet.
  // The tests below assert the replacement structural gates.
  it("C4: shadow keeper firing alongside busy program does NOT alert (no false-positive)", async () => {
    // This is THE C4 regression scenario: 5 shadow decisions, 500 live txs
    // (mostly user/maker/oracle traffic). The old code fired on every cycle.
    const decisions = Array.from({ length: 5 }, () => makeDecision());
    const harness = makeHarness(decisions, 500);
    await harness.runCycle();
    await harness.runCycle();
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("C4: shadow-silent + live-active streak < threshold does NOT alert", async () => {
    const harness = makeHarness([], 100); // shadow=0, live=100
    await harness.runCycle();
    await harness.runCycle();
    // 2 silent cycles, threshold is 3 — no alert yet.
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("C4: shadow-silent + live-active for N=silentCyclesBeforeAlert cycles fires ONE alert", async () => {
    const harness = makeHarness([], 100);
    await harness.runCycle();
    await harness.runCycle();
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledTimes(1);
    const [title] = vi.mocked(shared.sendWarningAlert).mock.calls[0]!;
    expect(title).toContain("silent");
  });

  it("C4: silent streak resets when shadow makes a decision", async () => {
    let decisions: DecisionEntry[] = [];
    const conn = makeConnection(100);
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => decisions),
      compareWindowMs: 300_000,
      silentCyclesBeforeAlert: 3,
      runawayMultiplier: 3,
      runawayMinSamples: 10,
      alertCooldownMs: 3_600_000,
    });
    await harness.runCycle(); // silent #1
    await harness.runCycle(); // silent #2
    decisions = [makeDecision()]; // shadow recovers
    await harness.runCycle(); // streak resets
    decisions = [];
    await harness.runCycle(); // silent #1 again
    await harness.runCycle(); // silent #2
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("C4: shadow-runaway alert fires when shadow >> live AND shadow >= minSamples", async () => {
    // shadow=100, live=5 → ratio=20x, both above minSamples=10
    const decisions = Array.from({ length: 100 }, () => makeDecision());
    const harness = makeHarness(decisions, 5);
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledTimes(1);
    const [title] = vi.mocked(shared.sendWarningAlert).mock.calls[0]!;
    expect(title).toContain("runaway");
  });

  it("C4: shadow-runaway does NOT fire below minSamples (small-sample guard)", async () => {
    // shadow=9, live=0 → infinite ratio but shadowTotal < minSamples=10
    const decisions = Array.from({ length: 9 }, () => makeDecision());
    const harness = makeHarness(decisions, 0);
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("C4: alerts honor cooldown — repeated silent cycles within cooldown only fire once", async () => {
    let nowMs = 1_000_000_000_000; // year ~2001 epoch ms, large enough for blockTime to be positive
    // Dynamic connection: blockTimes track nowMs so live sigs always fall in window.
    const conn = {
      getSignaturesForAddress: vi.fn(async () =>
        Array.from({ length: 100 }, (_, i) => ({
          signature: `sig_${i}`,
          slot: 1_000_000 + i,
          blockTime: Math.floor(nowMs / 1000) - (i % 60),
          err: null,
          memo: null,
          confirmationStatus: "finalized" as const,
        })),
      ),
    } as unknown as Connection;
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => []),
      compareWindowMs: 300_000,
      silentCyclesBeforeAlert: 3,
      runawayMultiplier: 3,
      runawayMinSamples: 10,
      alertCooldownMs: 3_600_000,
      now: () => nowMs,
    });
    await harness.runCycle(); nowMs += 300_000;
    await harness.runCycle(); nowMs += 300_000;
    await harness.runCycle(); nowMs += 300_000;
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) {
      await harness.runCycle();
      nowMs += 300_000;
    }
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledTimes(1);
  });

  it("C4: alerts re-fire after cooldown expires", async () => {
    let nowMs = 1_000_000_000_000;
    const conn = {
      getSignaturesForAddress: vi.fn(async () =>
        Array.from({ length: 100 }, (_, i) => ({
          signature: `sig_${i}`,
          slot: 1_000_000 + i,
          blockTime: Math.floor(nowMs / 1000) - (i % 60),
          err: null,
          memo: null,
          confirmationStatus: "finalized" as const,
        })),
      ),
    } as unknown as Connection;
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => []),
      compareWindowMs: 300_000,
      silentCyclesBeforeAlert: 3,
      runawayMultiplier: 3,
      runawayMinSamples: 10,
      alertCooldownMs: 600_000,
      now: () => nowMs,
    });
    await harness.runCycle(); nowMs += 300_000;
    await harness.runCycle(); nowMs += 300_000;
    await harness.runCycle(); // 1st alert at streak=3
    nowMs += 700_000; // past cooldown
    await harness.runCycle(); // streak=4, cooldown ready → 2nd alert
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledTimes(2);
  });

  it("C4: RPC failure suspends BOTH alert gates — no false positive on transient outage", async () => {
    // shadowTotal=20 with a sustained RPC outage. Old behavior: liveTotal=0,
    // shadow vastly exceeds 0 → runaway alert every cycle. New behavior:
    // liveFetchOk=false suspends alerts entirely so RPC blips don't page.
    const conn = {
      getSignaturesForAddress: vi.fn(async () => { throw new Error("RPC down"); }),
    } as unknown as Connection;
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => Array.from({ length: 20 }, () => makeDecision())),
      compareWindowMs: 300_000,
      silentCyclesBeforeAlert: 3,
      runawayMultiplier: 3,
      runawayMinSamples: 10,
      alertCooldownMs: 3_600_000,
    });
    for (let i = 0; i < 5; i++) {
      await harness.runCycle();
    }
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("RPC failure is swallowed — result has liveTotal=0", async () => {
    const conn = {
      getSignaturesForAddress: vi.fn(async () => { throw new Error("RPC down"); }),
    } as unknown as Connection;
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => [makeDecision()]),
      compareWindowMs: 300_000,
    });
    const result = await harness.runCycle();
    expect(result.liveTotal).toBe(0);
    expect(result.shadowTotal).toBe(1);
  });

  it("decision read failure is swallowed — result has shadowTotal=0", async () => {
    const conn = makeConnection(5);
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => { throw new Error("fs failure"); }),
      compareWindowMs: 300_000,
    });
    const result = await harness.runCycle();
    expect(result.shadowTotal).toBe(0);
    expect(result.liveTotal).toBeGreaterThan(0);
  });

  it("getLastResult() returns null before first cycle, then the result", async () => {
    const harness = makeHarness([], 0);
    expect(harness.getLastResult()).toBeNull();
    await harness.runCycle();
    expect(harness.getLastResult()).not.toBeNull();
  });

  it("start/stop lifecycle does not throw", () => {
    const harness = makeHarness([], 0);
    expect(() => harness.start()).not.toThrow();
    expect(() => harness.start()).not.toThrow(); // idempotent
    expect(() => harness.stop()).not.toThrow();
    expect(() => harness.stop()).not.toThrow(); // idempotent
  });
});

describe("ShadowHarness — buildReport (used by /shadow/report)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns expected report shape with fromMs and toMs", async () => {
    const decisions = Array.from({ length: 3 }, () => makeDecision("oracle"));
    const harness = makeHarness(decisions, 3);
    const report = await harness.buildReport();
    expect(typeof report.fromMs).toBe("number");
    expect(typeof report.toMs).toBe("number");
    expect(report.toMs).toBeGreaterThan(report.fromMs);
    expect(typeof report.shadowTotal).toBe("number");
    expect(typeof report.liveTotal).toBe("number");
    expect(typeof report.divergencePct).toBe("number");
    expect(typeof report.shadowByType).toBe("object");
  });

  it("accepts custom fromMs and toMs", async () => {
    const now = Date.now();
    const harness = makeHarness([], 0);
    const report = await harness.buildReport(now - 60_000, now);
    expect(report.fromMs).toBe(now - 60_000);
    expect(report.toMs).toBe(now);
  });

  it("returned divergencePct is in [0, 100]", async () => {
    const harness = makeHarness([], 5);
    const report = await harness.buildReport();
    expect(report.divergencePct).toBeGreaterThanOrEqual(0);
    expect(report.divergencePct).toBeLessThanOrEqual(100);
  });
});

describe("ShadowHarness — metrics wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shadowDivergencePct.set is called for all 4 txTypes after a cycle", async () => {
    const { shadowDivergencePct } = await import("../../src/lib/metrics.js");
    const harness = makeHarness([], 0);
    await harness.runCycle();
    // Should have been called for crank, liquidation, oracle, adl
    const callLabels = vi.mocked(shadowDivergencePct.set).mock.calls.map((c) => c[0]);
    expect(callLabels.some((l) => l.txType === "crank")).toBe(true);
    expect(callLabels.some((l) => l.txType === "liquidation")).toBe(true);
    expect(callLabels.some((l) => l.txType === "oracle")).toBe(true);
    expect(callLabels.some((l) => l.txType === "adl")).toBe(true);
  });
});
