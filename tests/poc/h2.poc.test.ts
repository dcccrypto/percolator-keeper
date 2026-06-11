/**
 * H2 PoC — pre-submit margin recheck silently bypassed when freshPrice===0.
 *
 * THE BUG (pre-fix):
 *   The pre-submit recheck in liquidate() was wrapped in
 *     if (freshPrice > 0n) { ... margin recompute ... }
 *   When resolveMarketPrice() returned 0n (admin oracle stale +
 *   lastEffectivePriceE6===0 on a brand-new market, OR a pyth-pinned market
 *   with no prior crank), the entire recompute block was SKIPPED. Control
 *   fell through to keeperSend without verifying the account was still
 *   undercollateralized.
 *
 * THE FIX (this PR):
 *   Invert the guard. When freshPrice===0n, log + return null (bail). The
 *   margin recheck now runs unconditionally on any positive freshPrice.
 *   Mirrors scanMarket's own posture (returns [] on price===0n) so the
 *   submit-time policy matches the scan-time policy.
 *
 * Scope note: scanMarket already short-circuits on price===0n, so this bug
 * only fires on a RACE — scan saw a non-zero price, then by submit time the
 * source collapsed. Shipped as fail-safe defense in depth.
 */
import { describe, it, expect } from "vitest";

interface RecheckInput {
  freshPrice: bigint;
  positionSize: bigint;
  equity: bigint;
  notional: bigint;
  maintenanceMarginBps: bigint;
}

// OLD pre-submit recheck — the bug shape.
function oldRecheckProceedsToSend(i: RecheckInput): boolean {
  if (i.freshPrice > 0n) {
    const notional = i.positionSize * i.freshPrice / 1_000_000n;
    const marginRatioBps = notional === 0n
      ? 0n
      : (i.equity <= 0n ? 0n : (i.equity * 10_000n) / notional);
    if (notional > 0n && i.equity > 0n && marginRatioBps >= i.maintenanceMarginBps) {
      return false; // recovered → abort, would return null in real code
    }
  }
  // ↑ When freshPrice===0n, recompute is SKIPPED → falls through here:
  return true; // proceeds to keeperSend even though we never re-verified
}

// NEW pre-submit recheck — fail-safe on no price.
function newRecheckProceedsToSend(i: RecheckInput): boolean {
  if (i.freshPrice === 0n) {
    return false; // bail — we cannot verify, so we don't submit
  }
  const notional = i.positionSize * i.freshPrice / 1_000_000n;
  const marginRatioBps = notional === 0n
    ? 0n
    : (i.equity <= 0n ? 0n : (i.equity * 10_000n) / notional);
  if (notional > 0n && i.equity > 0n && marginRatioBps >= i.maintenanceMarginBps) {
    return false; // recovered → abort
  }
  return true;
}

describe("H2 PoC — fresh-price bail fail-safe", () => {
  it("OLD path: freshPrice=0n at submit time SKIPS recheck and proceeds to send", () => {
    const result = oldRecheckProceedsToSend({
      freshPrice: 0n, // race: scanMarket saw a price; by submit it's 0
      positionSize: 10_000_000_000n,
      equity: 100_000_000n, // imagine the account RECOVERED since scan
      notional: 0n,
      maintenanceMarginBps: 500n,
    });
    expect(result).toBe(true);
    // ↑ Submits a liquidation tx without verifying. If the on-chain check
    //   doesn't catch it, the user is wrongfully liquidated.
  });

  it("NEW path: freshPrice=0n bails immediately — no send", () => {
    const result = newRecheckProceedsToSend({
      freshPrice: 0n,
      positionSize: 10_000_000_000n,
      equity: 100_000_000n,
      notional: 0n,
      maintenanceMarginBps: 500n,
    });
    expect(result).toBe(false); // bailed
  });

  it("NEW path: freshPrice>0n and still underwater → proceeds (legitimate liquidation)", () => {
    const result = newRecheckProceedsToSend({
      freshPrice: 1_000_000n, // healthy oracle
      positionSize: 10_000_000_000n,
      equity: 1_000_000n,    // tiny — undercollateralized
      notional: 0n,           // recomputed inside
      maintenanceMarginBps: 500n,
    });
    expect(result).toBe(true);
  });

  it("NEW path: freshPrice>0n and recovered → bails (existing race-condition guard preserved)", () => {
    const result = newRecheckProceedsToSend({
      freshPrice: 1_000_000n,
      positionSize: 10_000_000n,
      equity: 100_000_000_000n, // huge equity → recovered
      notional: 0n,
      maintenanceMarginBps: 500n,
    });
    expect(result).toBe(false);
  });
});
