/**
 * Stress + chaos tests for shadow-harness comparison loop.
 * Gated by STRESS=true so CI runs are fast.
 * Target: 10k decision-log entries + 10k live signatures — comparison <5s wall-clock.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

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

import { DecisionLog } from "../../src/lib/decision-log.js";
import { ShadowHarness } from "../../src/lib/shadow-harness.js";
import type { DecisionEntry } from "../../src/lib/decision-log.js";
import type { Connection } from "@solana/web3.js";

const N = 10_000;
const DIVERGENCE_FRACTION = 0.05; // 5% intentional divergence
const PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

// Span all entries within the last 60 seconds so the 5-min window covers all of them.
// Entry i gets timestamp = now - (N - i) * 6ms, so oldest is now - 60s, newest is now.
function makeEntry(i: number): DecisionEntry {
  return {
    timestamp: new Date(Date.now() - (N - i) * 6).toISOString(),
    txType: i % 4 === 0 ? "liquidation" : i % 4 === 1 ? "oracle" : i % 4 === 2 ? "adl" : "crank",
    market: `Market${(i % 10).toString().padStart(40, "A")}`,
    accounts: [`pk${i}`, `pk${i + 1}`],
    instructionData: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
    estimatedCost: 5_000 + i,
    reasonChain: [],
  };
}

function makeConnection(liveCount: number): Connection {
  const now = Math.floor(Date.now() / 1000);
  const sigs = Array.from({ length: liveCount }, (_, i) => ({
    signature: `livesig_${i}`,
    slot: 2_000_000 + i,
    // All within last 5 min window
    blockTime: now - Math.floor(Math.random() * 280),
    err: null,
    memo: null,
    confirmationStatus: "finalized" as const,
  }));
  return {
    getSignaturesForAddress: vi.fn(async () => sigs),
  } as unknown as Connection;
}

describe.skipIf(!process.env.STRESS)("ShadowHarness STRESS — 10k entries", { timeout: 30_000 }, () => {
  let logPath: string;
  let log: DecisionLog;

  beforeAll(async () => {
    logPath = path.join(os.tmpdir(), `keeper-stress-${Date.now()}.jsonl`);
    log = new DecisionLog(logPath);
    for (let i = 0; i < N; i++) {
      await log.append(makeEntry(i));
    }
    await log.close();
  });

  afterAll(async () => {
    await fs.unlink(logPath).catch(() => {});
  });

  it("10k decisions + 10k live sigs: comparison completes in <5s", async () => {
    // 5% divergence: shadow=10k, live=9500
    const liveCount = Math.floor(N * (1 - DIVERGENCE_FRACTION));
    const conn = makeConnection(liveCount);
    const readLog = new DecisionLog(logPath);

    const harness = new ShadowHarness({
      connection: conn,
      programId: PROGRAM_ID,
      readDecisions: (fromMs, toMs) => readLog.readWindow(fromMs, toMs),
      compareWindowMs: 300_000,
      divergenceThresholdPct: 99, // disable alert for stress test
    });

    const start = Date.now();
    const result = await harness.runCycle();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);
    expect(result.shadowTotal).toBe(N);
    expect(result.liveTotal).toBe(liveCount);
    expect(result.divergencePct).toBeGreaterThan(0);
    expect(result.divergencePct).toBeLessThanOrEqual(100);
  });

  it("CHAOS: prepend malformed line — comparison succeeds with 9999 valid entries", async () => {
    const chaoPath = path.join(os.tmpdir(), `keeper-chaos-stress-${Date.now()}.jsonl`);
    try {
      // Write the malformed line first, then all 10k good entries
      const goodRaw = await fs.readFile(logPath, "utf8");
      await fs.writeFile(chaoPath, "MALFORMED_JSON_LINE\n" + goodRaw, "utf8");

      const liveCount = N;
      const conn = makeConnection(liveCount);
      const readLog = new DecisionLog(chaoPath);

      const harness = new ShadowHarness({
        connection: conn,
        programId: PROGRAM_ID,
        readDecisions: (fromMs, toMs) => readLog.readWindow(fromMs, toMs),
        compareWindowMs: 300_000,
        divergenceThresholdPct: 99,
      });

      const start = Date.now();
      const result = await harness.runCycle();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5_000);
      // The malformed line is skipped; valid entries = N
      // (All N entries are within window since they're timestamped within last 5 min)
      expect(result.shadowTotal).toBe(N);
      expect(result.divergencePct).toBeGreaterThanOrEqual(0);
      expect(result.divergencePct).toBeLessThanOrEqual(100);
    } finally {
      await fs.unlink(chaoPath).catch(() => {});
    }
  });

  it("read 10k entries round-trip via DecisionLog", async () => {
    const readLog = new DecisionLog(logPath);
    const entries = await readLog.readAll();
    expect(entries).toHaveLength(N);
  });
});
