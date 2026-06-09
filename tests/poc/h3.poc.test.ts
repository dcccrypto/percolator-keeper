/**
 * H3 PoC — wall-clock vs cluster-time staleness asymmetry.
 *
 * THE BUG (pre-fix, on main):
 *   resolveMarketPrice() computed
 *     const now = BigInt(Math.floor(Date.now() / 1000));
 *     const priceAge = now - cfg.authorityTimestamp;
 *   `authorityTimestamp` is written on-chain using the Solana Clock sysvar
 *   (cluster time). `Date.now()` is wall-clock. The two can diverge by
 *   seconds during NTP step corrections or validator congestion. The
 *   keeper would mark a price stale (or fresh) using the wrong reference,
 *   causing rejected txs or stale-fallback when on-chain says otherwise.
 *
 * THE FIX (this PR):
 *   resolveMarketPrice() now takes nowSec as a parameter. Both call sites
 *   (scanMarket, liquidate pre-submit recheck) fetch cluster time via
 *   fetchClusterUnixTimeSec(), which reads SYSVAR_CLOCK_PUBKEY and parses
 *   unix_timestamp at offset 32.
 *
 * This PoC demonstrates the asymmetry: under the OLD code path, the
 * keeper would have flipped its decision based on wall-clock drift; under
 * the NEW code path, the cluster-time injection produces a consistent
 * decision regardless of what wall-clock says.
 */
import { describe, it, expect } from "vitest";

// Reimplementation of the OLD (pre-fix) staleness check for direct contrast.
function oldStalenessCheck(
  authorityTs: bigint,
  authorityPriceE6: bigint,
  wallNowSec: bigint,
): { stale: boolean } {
  const priceAge = authorityTs > 0n ? wallNowSec - authorityTs : wallNowSec;
  const fresh = authorityPriceE6 > 0n && priceAge <= 60n;
  return { stale: !fresh };
}

// Reimplementation of the NEW (post-fix) staleness check that takes nowSec.
function newStalenessCheck(
  authorityTs: bigint,
  authorityPriceE6: bigint,
  nowSec: bigint,
): { stale: boolean } {
  const priceAge = authorityTs > 0n ? nowSec - authorityTs : nowSec;
  const fresh = authorityPriceE6 > 0n && priceAge <= 60n;
  return { stale: !fresh };
}

describe("H3 PoC — wall-clock vs cluster-time decision divergence", () => {
  it("OLD path: wall-clock 70s ahead of cluster falsely marks fresh authority STALE", () => {
    const authorityTs = 1_780_000_000n; // cluster says: priced at this slot
    const clusterNow = authorityTs + 30n; // cluster says: 30s old → FRESH
    const wallNowAhead = authorityTs + 70n; // wall clock drifted ahead → fakes stale

    // The OLD code used wall-clock and would say STALE.
    const oldDecision = oldStalenessCheck(authorityTs, 1_000_000n, wallNowAhead);
    // The on-chain program (using cluster time) would say FRESH.
    const onChainDecision = oldStalenessCheck(authorityTs, 1_000_000n, clusterNow);

    expect(oldDecision.stale).toBe(true);
    expect(onChainDecision.stale).toBe(false);
    // ↑ This divergence is the bug: keeper falls back to lastEffectivePriceE6
    //   when on-chain would have accepted the authority price. Submitting on
    //   the stale fallback can produce a tx the on-chain program rejects.
  });

  it("NEW path: passing cluster time eliminates the divergence", () => {
    const authorityTs = 1_780_000_000n;
    const clusterNow = authorityTs + 30n;
    const wallNowAhead = authorityTs + 70n; // wall is wrong; ignored by NEW

    // The NEW code reads Clock sysvar and passes nowSec — matches on-chain.
    const newDecision = newStalenessCheck(authorityTs, 1_000_000n, clusterNow);
    expect(newDecision.stale).toBe(false);

    // Independently: a wall-clock value is no longer used, so its drift is
    // irrelevant to the staleness decision.
    void wallNowAhead;
  });

  it("PoC: keeper boundary — at 60s exactly fresh, 61s stale (both checks)", () => {
    const authorityTs = 1_780_000_000n;
    // Both implementations share the boundary; the bug is the INPUT they
    // each receive, not the formula. Verify the formula stays correct.
    expect(newStalenessCheck(authorityTs, 1_000_000n, authorityTs + 60n).stale).toBe(false);
    expect(newStalenessCheck(authorityTs, 1_000_000n, authorityTs + 61n).stale).toBe(true);
  });
});
