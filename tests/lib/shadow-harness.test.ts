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

function makeConnection(signatureCount = 5): Connection {
  const now = Math.floor(Date.now() / 1000);
  return {
    getSignaturesForAddress: vi.fn(async () =>
      Array.from({ length: signatureCount }, (_, i) => ({
        signature: `sig_${i}`,
        slot: 1_000_000 + i,
        // All within the last 60s so they always fall inside the 300s window
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
  threshold = 1.0,
): ShadowHarness {
  const conn = makeConnection(signatureCount);
  return new ShadowHarness({
    connection: conn,
    programId: PROGRAM_ID,
    readDecisions: vi.fn(async () => decisions),
    compareWindowMs: 300_000,
    divergenceThresholdPct: threshold,
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

  it("discord alert fires when divergence_pct > threshold", async () => {
    const decisions = Array.from({ length: 1 }, () => makeDecision());
    const harness = makeHarness(decisions, 100, 1.0); // shadow=1, live=100 → ~99% divergence
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalledOnce();
    const [title] = vi.mocked(shared.sendWarningAlert).mock.calls[0]!;
    expect(title).toContain("divergence");
  });

  it("discord alert does NOT fire when divergence_pct <= threshold", async () => {
    const decisions = Array.from({ length: 10 }, () => makeDecision());
    const harness = makeHarness(decisions, 10, 1.0); // perfect match → 0% divergence
    await harness.runCycle();
    expect(vi.mocked(shared.sendWarningAlert)).not.toHaveBeenCalled();
  });

  it("discord alert does NOT fire when divergence_pct is exactly at threshold", async () => {
    // shadow=50, live=100 → 50% divergence; threshold=51 → no alert
    const decisions = Array.from({ length: 50 }, () => makeDecision());
    const harness = makeHarness(decisions, 100, 51.0);
    await harness.runCycle();
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
      divergenceThresholdPct: 99,
    });
    const result = await harness.runCycle();
    expect(result.liveTotal).toBe(0);
    expect(result.shadowTotal).toBe(1);
    // 100% divergence but threshold is 99 — should still alert
    expect(vi.mocked(shared.sendWarningAlert)).toHaveBeenCalled();
  });

  it("decision read failure is swallowed — result has shadowTotal=0", async () => {
    const conn = makeConnection(5);
    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: vi.fn(async () => { throw new Error("fs failure"); }),
      compareWindowMs: 300_000,
      divergenceThresholdPct: 99,
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
