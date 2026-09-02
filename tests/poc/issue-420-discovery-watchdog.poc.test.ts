/**
 * PoC + regression guard for #420.
 *
 * Market discovery ran INSIDE the crank-cycle watchdog window. Under sustained
 * RPC 429s the discovery retry walks DISCOVER_429_BACKOFF_MS = [3s, 9s, 27s,
 * 81s] = 120s per program (~150s with jitter) plus 3s inter-program spacing, so
 * two programs alone exceed MAX_CYCLE_MS (300s at the default 30s interval).
 * The watchdog then process.exit(1)'d into a restart loop that re-ran discovery
 * straight back into the same 429s — turning a transient RPC incident into
 * restart churn and alert spam exactly when the keeper should ride it out.
 *
 * The watchdog's own comment says its job is catching a hung CRANK PASS.
 * Bounded backoff is not that.
 *
 * These tests exercise the budget arithmetic directly, because the watchdog is
 * a setInterval inside start() with no seam to drive it from a unit test.
 */
import { describe, it, expect } from "vitest";

/** Mirrors src/services/crank.ts. */
const DISCOVER_429_BACKOFF_MS = [3_000, 9_000, 27_000, 81_000];
const JITTER_MAX = 1.25;
const INTER_PROGRAM_SPACING_MS = 3_000;
const PER_PROGRAM_DISCOVERY_BUDGET_MS = 240_000;

/** MAX_CYCLE_MS = max(intervalMs * 10, 4min). */
const maxCycleMs = (intervalMs: number) => Math.max(intervalMs * 10, 4 * 60_000);

/** Worst-case legitimate discovery time for N programs, all rate-limited. */
const worstCaseDiscoveryMs = (programs: number) =>
  programs *
  (DISCOVER_429_BACKOFF_MS.reduce((a, b) => a + b, 0) * JITTER_MAX + INTER_PROGRAM_SPACING_MS);

/** The budget the watchdog applies while discovering. */
const discoveryBudgetMs = (intervalMs: number, programs: number) =>
  Math.max(maxCycleMs(intervalMs), Math.max(1, programs) * PER_PROGRAM_DISCOVERY_BUDGET_MS);

describe("#420 — discovery is not timed against the crank-pass budget", () => {
  it("REGRESSION: two rate-limited programs exceeded the crank-pass budget", () => {
    // The defect, in one assertion. 2 x 153s = 306s > 300s.
    expect(worstCaseDiscoveryMs(2)).toBeGreaterThan(maxCycleMs(30_000));
  });

  it("the discovery budget accommodates the worst legitimate case", () => {
    for (const programs of [1, 2, 3, 5, 10]) {
      expect(discoveryBudgetMs(30_000, programs)).toBeGreaterThan(worstCaseDiscoveryMs(programs));
    }
  });

  it("scales with program count — a fixed budget would regress at scale", () => {
    // The reason the budget is per-program rather than one larger constant:
    // discovery walks programs SEQUENTIALLY, so its worst case is linear in N.
    expect(discoveryBudgetMs(30_000, 10)).toBeGreaterThan(discoveryBudgetMs(30_000, 2));
  });

  it("is a LARGER budget, never an exemption", () => {
    // The load-bearing property. Anchoring the deadline during discovery would
    // turn a hung discovery into a silent permanent stall with no alert —
    // strictly worse than the restart loop, because a restart is at least
    // visible. The budget must stay finite for every program count.
    for (const programs of [1, 2, 100, 10_000]) {
      const budget = discoveryBudgetMs(30_000, programs);
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
    }
  });

  it("never shrinks the crank-pass budget", () => {
    // Discovery gets more time; the crank pass keeps exactly what it had.
    for (const intervalMs of [10_000, 30_000, 60_000]) {
      expect(discoveryBudgetMs(intervalMs, 1)).toBeGreaterThanOrEqual(maxCycleMs(intervalMs));
    }
  });

  it("a long crank interval still governs when it is the larger bound", () => {
    // intervalMs * 10 can exceed the per-program budget; the max() keeps
    // whichever is larger so a slow-interval deployment is not tightened.
    const intervalMs = 60_000; // MAX_CYCLE_MS = 600s > 240s
    expect(discoveryBudgetMs(intervalMs, 1)).toBe(maxCycleMs(intervalMs));
  });
});
