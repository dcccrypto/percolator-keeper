import { describe, it, expect, beforeEach } from "vitest";
import {
  recordAttempt,
  recordLanded,
  recordFailed,
  snapshotMetrics,
  resetMetrics,
} from "../../src/lib/sender-metrics.js";

describe("sender-metrics", () => {
  beforeEach(() => resetMetrics());

  it("starts at zero", () => {
    const m = snapshotMetrics();
    expect(m.attempts).toBe(0);
    expect(m.landed).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.tipLamportsSpent).toBe(0);
  });

  it("increments attempts", () => {
    recordAttempt();
    recordAttempt();
    expect(snapshotMetrics().attempts).toBe(2);
  });

  it("records landed with tip", () => {
    recordLanded(1200, 200_000);
    const m = snapshotMetrics();
    expect(m.landed).toBe(1);
    expect(m.tipLamportsSpent).toBe(200_000);
    expect(m.lastTxElapsedMs).toBe(1200);
  });

  it("accumulates tip spend across landings", () => {
    recordLanded(800, 200_000);
    recordLanded(1000, 300_000);
    expect(snapshotMetrics().tipLamportsSpent).toBe(500_000);
  });

  it("records failures", () => {
    recordFailed();
    recordFailed();
    expect(snapshotMetrics().failed).toBe(2);
  });

  it("snapshot returns a copy (not a live reference)", () => {
    recordAttempt();
    const snap = snapshotMetrics();
    recordAttempt();
    expect(snap.attempts).toBe(1);
    expect(snapshotMetrics().attempts).toBe(2);
  });
});
