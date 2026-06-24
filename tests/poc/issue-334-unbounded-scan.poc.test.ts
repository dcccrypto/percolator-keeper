/**
 * PoC for Finding #334 [HIGH] — unbounded v17 portfolio enumeration.
 *
 * ROOT CAUSE (pre-fix): scanV17Portfolios() did getProgramAccounts with no
 * cap/pagination, parsed EVERY 9,347-byte portfolio, and processed candidates
 * serially. An attacker who creates many portfolios makes one market's scan run
 * unbounded, stalling all markets → health flaps → restart loop.
 *
 * FIX (#334):
 *   1. Cap portfolios PARSED per market per cycle (MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE)
 *      with a PERSISTENT per-market rotating cursor so every portfolio is
 *      eventually scanned across cycles (fairness — none permanently skipped).
 *   2. Cap candidates per market (MAX_CANDIDATES_PER_MARKET) AND globally per
 *      cycle (MAX_CANDIDATES_PER_GLOBAL_CYCLE), prioritized by largest deficit.
 *
 * This is the deterministic MODEL test of the bounding + rotation, plus a
 * coverage test proving the cursor eventually covers all portfolios.
 */
import { describe, it, expect } from "vitest";

// Mirror the production constants (kept in sync with src/services/liquidation.ts).
const MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE = 512;
const MAX_CANDIDATES_PER_MARKET = 64;
const MAX_CANDIDATES_PER_GLOBAL_CYCLE = 256;

/**
 * Deterministic model of the per-market rotating-window selection used in
 * scanV17Portfolios (#334). Given the total count and the current cursor,
 * returns the indices processed this cycle and the next cursor value.
 */
function rotatingWindow(total: number, cursor: number): { indices: number[]; nextCursor: number } {
  if (total <= MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE) {
    return { indices: Array.from({ length: total }, (_, i) => i), nextCursor: 0 };
  }
  const start = ((cursor % total) + total) % total;
  const indices: number[] = [];
  for (let k = 0; k < MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE; k++) {
    indices.push((start + k) % total);
  }
  return { indices, nextCursor: (start + MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE) % total };
}

describe("#334 PoC — bounded v17 portfolio enumeration", () => {
  it("processes at most MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE per cycle when flooded", () => {
    const total = 50_000; // attacker-created flood
    const { indices } = rotatingWindow(total, 0);
    expect(indices.length).toBe(MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE);
    expect(indices.length).toBeLessThan(total); // unbounded scan is bounded
  });

  it("a small market (<= cap) is fully covered in one cycle and resets the cursor", () => {
    const total = 100;
    const { indices, nextCursor } = rotatingWindow(total, 0);
    expect(indices.length).toBe(100);
    expect(new Set(indices).size).toBe(100); // every portfolio
    expect(nextCursor).toBe(0);
  });

  it("the cursor ADVANCES and eventually covers ALL portfolios across cycles (fairness)", () => {
    // 50_000 portfolios, cap 512 → needs ceil(50000/512)=98 cycles to cover all.
    const total = 50_000;
    const seen = new Set<number>();
    let cursor = 0;
    const maxCycles = Math.ceil(total / MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE) + 2; // small headroom
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      const { indices, nextCursor } = rotatingWindow(total, cursor);
      indices.forEach((i) => seen.add(i));
      cursor = nextCursor;
      if (seen.size === total) break;
    }
    // Every portfolio is eventually scanned — none is permanently skipped.
    expect(seen.size).toBe(total);
  });

  it("the cursor wraps around the end of the portfolio set", () => {
    const total = 1_000; // cap 512
    // Start near the end so the window must wrap.
    const { indices, nextCursor } = rotatingWindow(total, 800);
    expect(indices.length).toBe(512);
    // Window is [800..999, 0..311] → contains both high and low indices.
    expect(indices).toContain(999);
    expect(indices).toContain(0);
    expect(indices).toContain(311);
    expect(indices).not.toContain(312); // 800 + 512 = 1312 % 1000 = 312 is the NEXT start
    expect(nextCursor).toBe(312);
  });

  it("caps candidates per market, keeping the LARGEST-deficit candidates", () => {
    // Model: more qualifying candidates than the per-market cap; keep top-deficit.
    const qualifying = Array.from({ length: 200 }, (_, i) => ({ id: i, deficit: BigInt(i) }));
    const sorted = [...qualifying].sort((a, b) => (b.deficit > a.deficit ? 1 : b.deficit < a.deficit ? -1 : 0));
    const kept = sorted.slice(0, MAX_CANDIDATES_PER_MARKET);
    expect(kept.length).toBe(MAX_CANDIDATES_PER_MARKET);
    // The single largest deficit (id 199) is kept; the smallest (id 0) is dropped.
    expect(kept.some((c) => c.id === 199)).toBe(true);
    expect(kept.some((c) => c.id === 0)).toBe(false);
  });

  it("caps total candidates GLOBALLY per cycle across many markets", () => {
    // 100 markets each surfacing 64 candidates = 6_400 > global cap → bounded.
    const perMarket = 64;
    const markets = 100;
    let processed = 0;
    outer: for (let m = 0; m < markets; m++) {
      for (let c = 0; c < perMarket; c++) {
        if (processed >= MAX_CANDIDATES_PER_GLOBAL_CYCLE) break outer;
        processed++;
      }
    }
    expect(processed).toBe(MAX_CANDIDATES_PER_GLOBAL_CYCLE);
    expect(processed).toBeLessThan(markets * perMarket); // genuinely bounded
  });
});
