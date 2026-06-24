/**
 * PoC — proves the fraud-detector pair (MEDIUM): wrong mark field (INS-4) and
 * over-strict HYPERP detection (INS-5).
 *
 * INS-4: the detector reads `engine.markPriceE6`, but on v12.17+ layouts the
 *   engine mark field was dropped (parseEngine returns 0n). The on-chain HYPERP
 *   mark lives in MarketConfig; the SDK surfaces it as `config.authorityPriceE6`
 *   (config offset 176 == program `hyperp_mark_e6`). So the detector skips every
 *   market (markPriceE6 === 0n) and never compares anything.
 * INS-5: HYPERP detection requires index_feed_id == 0 AND oracle_authority == 0,
 *   but the program defines HYPERP purely by index_feed_id == 0 — so a HYPERP
 *   market with a non-zero hyperp_authority is never checked.
 *
 * These tests assert the CORRECT behavior: they FAIL on the unfixed code and PASS
 * after the fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ sendWarningAlert: vi.fn(() => Promise.resolve()) }));

vi.mock("@percolatorct/shared", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  sendWarningAlert: h.sendWarningAlert,
}));

import { FraudDetectorService } from "../../src/services/fraud-detector.js";

function bytes(zero: boolean, marker = 1): { toBytes: () => Uint8Array } {
  const a = new Uint8Array(32);
  if (!zero) a[0] = marker;
  return { toBytes: () => a };
}

interface MarketOpts { feedZero: boolean; authZero: boolean; engineMark: bigint; configMark: bigint; }
function makeState(o: MarketOpts) {
  return {
    market: {
      config: {
        indexFeedId: bytes(o.feedZero),
        oracleAuthority: bytes(o.authZero, 9),
        collateralMint: { toBase58: () => "Mint1111111111111111111111111111111111" },
        // SDK surfaces program hyperp_mark_e6 (offset 176) as authorityPriceE6.
        authorityPriceE6: o.configMark,
      },
      engine: { markPriceE6: o.engineMark },
    },
    // #336: the detector skips !isActive markets; these PoC markets are active.
    isActive: true,
    mainnetCA: undefined,
  };
}

const SLAB = "Slab11111111111111111111111111111111111111";

describe("PoC: fraud detector mark field + HYPERP detection", () => {
  let oracle: { fetchPrice: ReturnType<typeof vi.fn>; peekPrice: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    oracle = { fetchPrice: vi.fn(), peekPrice: vi.fn() };
  });

  function svcFor(state: ReturnType<typeof makeState>): FraudDetectorService {
    const markets = new Map<string, any>([[SLAB, state]]);
    return new FraudDetectorService(oracle as any, () => markets);
  }

  it("INS-4: uses the on-chain config mark, not engine.markPriceE6 (which is 0n on v12.17+)", async () => {
    // engine.markPriceE6 == 0n (current layout); the real mark is in config.authorityPriceE6.
    const svc = svcFor(makeState({ feedZero: true, authZero: true, engineMark: 0n, configMark: 100_000_000n }));
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n }); // 100% divergence vs the config mark
    await svc._runCheck();
    expect(h.sendWarningAlert).toHaveBeenCalled(); // FAILS unfixed: reads 0n → skipped
  });

  it("INS-5: checks a HYPERP market that carries a non-zero oracle authority", async () => {
    const svc = svcFor(makeState({ feedZero: true, authZero: false, engineMark: 100_000_000n, configMark: 100_000_000n }));
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n });
    await svc._runCheck();
    expect(h.sendWarningAlert).toHaveBeenCalled(); // FAILS unfixed: isZeroAuthority false → skipped
  });

  it("does not alert when the on-chain mark agrees with off-chain consensus", async () => {
    const svc = svcFor(makeState({ feedZero: true, authZero: true, engineMark: 0n, configMark: 50_000_000n }));
    oracle.peekPrice.mockResolvedValue({ priceE6: 50_000_000n }); // 0 divergence
    await svc._runCheck();
    expect(h.sendWarningAlert).not.toHaveBeenCalled();
  });
});
