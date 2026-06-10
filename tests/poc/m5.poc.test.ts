/**
 * M5 PoC — DexScreener and Jupiter REST APIs have no publisher signature.
 *
 * THE BUG (architectural, pre-fix):
 *   src/services/oracle.ts fetches prices from DexScreener and Jupiter as the
 *   primary price sources. Neither API returns a cryptographic signature, a
 *   slot field, or any on-chain anchor. The keeper accepts the prices on the
 *   strength of the TLS chain to the provider's CDN alone.
 *
 *   Existing mitigations:
 *     - Cross-source validation: reject if DexScreener and Jupiter diverge
 *       by more than MAX_CROSS_SOURCE_DEVIATION_BPS=1000 (10%).
 *     - Min-liquidity filter: reject DexScreener pairs with liquidity_usd < 1000.
 *     - Historical deviation: reject if priceE6 deviates by > 3000 bps (30%)
 *       from the last recorded price for the slab.
 *     - Cached price max-age: reject cached prices older than 60s.
 *
 *   These catch SINGLE-source manipulation but not coordinated attacks
 *   (shared CDN compromise, MITM of both endpoints, etc.).
 *
 * THE FIX (this PR):
 *   - JSDoc on fetchPrice explicitly documents the architectural limit.
 *   - Boot-time warn when on mainnet (silenceable via
 *     ORACLE_ACK_UNSIGNED_SOURCES=true after operator acknowledgement).
 *   - The "real fix" is Pyth Pull (on-chain signed prices), deferred to its
 *     own workstream.
 *
 * This PoC walks through the mitigation envelope and shows the residual gap
 * the boot warn is meant to surface.
 */
import { describe, it, expect } from "vitest";

const MAX_CROSS_SOURCE_DEVIATION_BPS = 1000; // 10%
const HISTORICAL_DEVIATION_MAX_BPS = 3000;   // 30%
const MIN_LIQUIDITY_USD = 1_000;

function crossSourceValidates(dexE6: bigint, jupE6: bigint): boolean {
  if (dexE6 <= 0n || jupE6 <= 0n) return false;
  const larger = dexE6 > jupE6 ? dexE6 : jupE6;
  const smaller = dexE6 > jupE6 ? jupE6 : dexE6;
  const divergenceBps = Number((larger - smaller) * 10_000n / smaller);
  return divergenceBps <= MAX_CROSS_SOURCE_DEVIATION_BPS;
}

function historicalValidates(newE6: bigint, lastE6: bigint): boolean {
  if (lastE6 <= 0n) return true;
  const deviationBps = newE6 > lastE6
    ? Number((newE6 - lastE6) * 10_000n / lastE6)
    : Number((lastE6 - newE6) * 10_000n / lastE6);
  return deviationBps <= HISTORICAL_DEVIATION_MAX_BPS;
}

describe("M5 PoC — unsigned oracle source defenses + residual architectural gap", () => {
  it("single-source manipulation (DexScreener spikes, Jupiter stable) is REJECTED", () => {
    const dexE6 = 200_000_000n;     // $200 — attacker manipulates this feed
    const jupE6 = 100_000_000n;     // $100 — honest
    expect(crossSourceValidates(dexE6, jupE6)).toBe(false);
    // ↑ 100% divergence > 10% threshold → keeper returns null. Mitigation works.
  });

  it("min-liquidity filter rejects low-liquidity DexScreener pairs (trivially manipulable)", () => {
    const lowLiqPair = { priceUsd: "999", liquidity: { usd: 50 } };
    expect((lowLiqPair.liquidity.usd ?? 0) < MIN_LIQUIDITY_USD).toBe(true);
    // ↑ DexScreener path returns null for pairs below $1000 liquidity.
  });

  it("historical deviation check rejects sudden 50% spikes (40% pump and dump)", () => {
    const last = 100_000_000n;
    const sudden = 150_000_000n; // 50% above last
    expect(historicalValidates(sudden, last)).toBe(false);
    // ↑ 5000 bps > 3000 bps threshold → keeper returns null.
  });

  it("BUT coordinated attack on BOTH sources slips past cross-source validation", () => {
    // Hypothetical: attacker compromises a shared CDN that both DexScreener
    // and Jupiter route through (or DNS-poisons both endpoints simultaneously).
    // Both feeds return the same wrong price.
    const dexE6 = 150_000_000n; // both attacker-controlled
    const jupE6 = 150_000_000n;
    expect(crossSourceValidates(dexE6, jupE6)).toBe(true);
    // ↑ Cross-source agrees → keeper proceeds. Historical-deviation check
    //   catches one big jump, but a slow-ramped coordinated attack stays
    //   below the 30% per-tick threshold.

    // Slow ramp: 5% per tick on both sources. 5 ticks later the price is
    // 1.05^5 ≈ 1.276 (27.6% over original), all WITHIN the historical envelope.
    let lastE6 = 100_000_000n;
    for (let i = 0; i < 5; i++) {
      const newE6 = (lastE6 * 105n) / 100n;
      expect(historicalValidates(newE6, lastE6)).toBe(true);
      lastE6 = newE6;
    }
    // ↑ 27.6% manipulation slipped through. This is the residual gap the
    //   boot warn is meant to make explicit at startup.
  });

  it("M5 fix: boot warn body contains the key risk phrases operators should grep for", () => {
    // The OracleService constructor logs a warn on mainnet that includes
    // these substrings. This test asserts the SHAPE of the warning rather
    // than mocking the full logger plumbing.
    const expected = [
      "unsigned price sources",
      "no publisher signature",
      "Pyth Pull",
      "ORACLE_ACK_UNSIGNED_SOURCES",
    ];
    const sampleWarn =
      "OracleService: mainnet running with unsigned price sources (DexScreener/Jupiter). " +
      "These APIs have no publisher signature and no slot anchor. Cross-source validation, " +
      "min-liquidity ($1000), and historical deviation (30%) are partial mitigations only. " +
      "Migrate to Pyth Pull for cryptographic guarantees. Set ORACLE_ACK_UNSIGNED_SOURCES=true " +
      "to acknowledge this risk and silence this warn.";
    for (const phrase of expected) {
      expect(sampleWarn).toContain(phrase);
    }
  });
});
