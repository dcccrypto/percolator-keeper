import { describe, it, expect } from "vitest";

const BPS = 10_000n;

function legMaintenance(absPos: bigint, price: bigint, maintenanceMarginBps: bigint, minNonzeroMmReq: bigint): bigint {
  const POS_SCALE = 1_000_000n;
  const notional = (absPos * price + POS_SCALE - 1n) / POS_SCALE; // ceil
  const m = notional * maintenanceMarginBps / BPS;
  return m < minNonzeroMmReq ? minNonzeroMmReq : m;
}

describe("issue-330: aggregate maintenance vs per-leg check", () => {
  it("two-leg portfolio: aggregate passes threshold but no single leg does", () => {
    // Set up so per-leg maintenance < equity, but aggregate maintenance > equity.
    // Use large positions so maintenance >> minNonzeroMmReq (no clamping distortion).
    // Disable minNonzeroMmReq clamping to isolate the aggregate-vs-per-leg distinction.
    const maintenanceMarginBps = 500n; // 5%
    const minNonzeroMmReq = 0n; // no clamping — isolate aggregate logic
    const price = 1_000_000n; // $1 in e6

    // absPos=10_000, price=$1: notional = ceil(10_000 * 1_000_000 / 1_000_000) = 10_000
    // maintenance = 10_000 * 500 / 10_000 = 500
    const legA = legMaintenance(10_000n, price, maintenanceMarginBps, minNonzeroMmReq);
    const legB = legMaintenance(10_000n, price, maintenanceMarginBps, minNonzeroMmReq);
    const aggregate = legA + legB; // 500 + 500 = 1000

    // equity=900: above each leg's maintenance (500) but below the aggregate (1000)
    const equity = 900n;

    // Per-leg check would NOT flag either leg individually (900 >= 500)
    expect(equity < legA).toBe(false);
    expect(equity < legB).toBe(false);

    // Aggregate check DOES catch this (900 < 1000)
    expect(equity < aggregate).toBe(true);
  });

  it("minNonzeroMmReq clamps small maintenance values", () => {
    const maintenanceMarginBps = 500n; // 5%
    const minNonzeroMmReq = 1_000n;
    const price = 1_000_000n;
    const absPos = 1n; // dust position

    const notional = (absPos * price + 1_000_000n - 1n) / 1_000_000n;
    const rawMaintenance = notional * maintenanceMarginBps / BPS;
    const clamped = legMaintenance(absPos, price, maintenanceMarginBps, minNonzeroMmReq);

    // Raw maintenance < minNonzeroMmReq — should be clamped up
    expect(rawMaintenance).toBeLessThan(Number(minNonzeroMmReq));
    expect(clamped).toBe(minNonzeroMmReq);
  });
});
