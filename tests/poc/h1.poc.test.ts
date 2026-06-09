/**
 * H1 PoC — ADL ranking truncation collision.
 *
 * THE BUG (pre-fix):
 *   rankProfitablePositions computed pnlPct = (pnl * 1_000_000n) / capital
 *   with BigInt floor division. Two positions with materially different
 *   TRUE ratios can collapse to the same TRUNCATED pnlPct, and the sort
 *   tie-breaks by pnlAbs descending — placing whichever position has the
 *   larger absolute PnL first. An attacker who tunes their position to
 *   bucket-collide with an honest counterparty AND has lower pnlAbs gets
 *   ranked SECOND while the honest party is deleveraged first.
 *
 * THE FIX (this PR):
 *   Replace the fixed-point comparator with cross-multiplication
 *   (a.pnl * b.capital vs b.pnl * a.capital). Exact BigInt arithmetic —
 *   every position with a strictly higher true ratio outranks every
 *   position with a strictly lower one, regardless of fixed-point bucket.
 *   Tie-break preserved on pnlAbs desc; final tie-break on idx asc
 *   (deterministic).
 *
 * This PoC walks through the collision math and shows the OLD sort orders
 * honest-first while the NEW sort orders attacker-first.
 */
import { describe, it, expect } from "vitest";

interface Pos { idx: number; pnl: bigint; capital: bigint; }

function oldSort(positions: Pos[]): Pos[] {
  return [...positions]
    .map((p) => ({ ...p, pnlPct: (p.pnl * 1_000_000n) / p.capital, pnlAbs: p.pnl }))
    .sort((a, b) => {
      if (b.pnlPct !== a.pnlPct) return b.pnlPct > a.pnlPct ? 1 : -1;
      return b.pnlAbs > a.pnlAbs ? 1 : -1;
    });
}

function newSort(positions: Pos[]): Pos[] {
  return [...positions].sort((a, b) => {
    const lhs = a.pnl * b.capital;
    const rhs = b.pnl * a.capital;
    if (lhs !== rhs) return rhs > lhs ? 1 : -1;
    if (b.pnl !== a.pnl) return b.pnl > a.pnl ? 1 : -1;
    return a.idx - b.idx;
  });
}

describe("H1 PoC — ADL ranking truncation collision", () => {
  it("collision quadruple: both positions truncate to pnlPct=5 but have different TRUE ratios", () => {
    const honest = { idx: 11, pnl: 1_000n,   capital: 200_000_000n }; // true: 5e-6
    const attacker = { idx: 22, pnl: 1n,     capital: 170_000n };    // true: ~5.88e-6

    const honestTruncated = (honest.pnl * 1_000_000n) / honest.capital;
    const attackerTruncated = (attacker.pnl * 1_000_000n) / attacker.capital;
    expect(honestTruncated).toBe(5n);
    expect(attackerTruncated).toBe(5n);
    // Truncated values match → tie. But the TRUE ratios differ:
    // honest:   1000 / 200_000_000 = 5 / 1_000_000
    // attacker: 1    / 170_000     ≈ 5.88 / 1_000_000  (17.6% higher!)
  });

  it("OLD sort: honest gets ranked first (deleveraged) — attacker skates", () => {
    const honest = { idx: 11, pnl: 1_000n, capital: 200_000_000n };
    const attacker = { idx: 22, pnl: 1n,   capital: 170_000n };

    const ranked = oldSort([honest, attacker]);
    expect(ranked[0]!.idx).toBe(11); // ← honest first (BUG)
    expect(ranked[1]!.idx).toBe(22); // ← attacker spared
  });

  it("NEW sort: attacker (truly higher ratio) is ranked first — honest spared", () => {
    const honest = { idx: 11, pnl: 1_000n, capital: 200_000_000n };
    const attacker = { idx: 22, pnl: 1n,   capital: 170_000n };

    const ranked = newSort([honest, attacker]);
    expect(ranked[0]!.idx).toBe(22); // ← attacker first (correct math)
    expect(ranked[1]!.idx).toBe(11); // ← honest spared
  });

  it("PoC — preserved invariant: positions with truly EQUAL ratios still tie-break by pnlAbs desc", () => {
    // Both 30% PnL: 300k/1M and 600k/2M.
    const small = { idx: 3, pnl: 300_000n,  capital: 1_000_000n };
    const big   = { idx: 8, pnl: 600_000n,  capital: 2_000_000n };

    const ranked = newSort([small, big]);
    expect(ranked[0]!.idx).toBe(8); // higher pnlAbs first — preserved
  });

  it("PoC — deterministic final tie-break on idx ascending when ratio AND pnlAbs are identical", () => {
    const a = { idx: 17, pnl: 500_000n, capital: 1_000_000n };
    const b = { idx: 4,  pnl: 500_000n, capital: 1_000_000n };
    const ranked = newSort([a, b]);
    expect(ranked[0]!.idx).toBe(4); // lower idx wins the final tie-break
  });
});
