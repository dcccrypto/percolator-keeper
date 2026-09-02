/**
 * PoC + regression guard for #404.
 *
 * The v17 fee-crank pass — which carries tag 89 `ExpireBackingBucket` — was fed
 * exclusively from `succeededSlabs`, i.e. markets that CRANKED SUCCESSFULLY
 * this cycle. `crankAll` drops markets from `toCrank` for reasons unrelated to
 * whether bucket recovery is due:
 *
 *   - foreignOracleSkipped   (admin oracle the keeper is not authority for — permanent)
 *   - !keeperPortfolio       (not provisioned yet)
 *   - stale-oracle pause
 *   - consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
 *
 * Those are precisely the markets whose backing domain is most likely stuck, so
 * the control was inverted. Tag 89 takes one account, no signer, moves no
 * tokens, and `fee-crank.ts` documents it as LIVENESS running every cycle with
 * no economic threshold — it must not depend on crankability at all.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { selectFeeCrankMarkets } from "../../src/services/crank.js";

const PROGRAM = new PublicKey("11111111111111111111111111111111");

function state(overrides: Record<string, unknown> = {}) {
  return {
    market: { slabAddress: PublicKey.unique(), programId: PROGRAM },
    ...overrides,
  } as Parameters<typeof selectFeeCrankMarkets>[0] extends Iterable<infer T> ? T : never;
}

describe("#404 — tag-89 recovery is not gated on crank success", () => {
  it("includes a market the keeper can NEVER crank (foreign admin oracle)", () => {
    // The sharpest case: permanently un-crankable, so under the old gating it
    // could never recover its backing bucket, forever.
    const s = state({ foreignOracleSkipped: true });
    expect(selectFeeCrankMarkets([s]).map((m) => m.address)).toEqual([s.market.slabAddress]);
  });

  it("includes markets skipped for every other structural reason", () => {
    const noPortfolio = state({ keeperPortfolio: null });
    const stalePaused = state({});
    const failing = state({ consecutiveFailures: 99 });

    const picked = selectFeeCrankMarkets([noPortfolio, stalePaused, failing]);

    expect(picked).toHaveLength(3);
  });

  it("EXCLUDES permanentlySkipped — that account is not initialized on-chain", () => {
    // The one exclusion that is correct: error 0x4 means there is no market
    // there, so there is nothing to recover.
    const live = state({});
    const dead = state({ permanentlySkipped: true });

    const picked = selectFeeCrankMarkets([live, dead]);

    expect(picked).toHaveLength(1);
    expect(picked[0].address).toEqual(live.market.slabAddress);
  });

  it("REGRESSION: selection is independent of this cycle's crank outcome", () => {
    // Pins the defect. Under the old code the pass was fed from succeededSlabs,
    // so a cycle where NOTHING cranked successfully ran tag 89 zero times. The
    // selector has no notion of success at all — which is the point.
    const markets = [state({}), state({ consecutiveFailures: 10 }), state({ foreignOracleSkipped: true })];
    expect(selectFeeCrankMarkets(markets)).toHaveLength(3);
  });

  it("carries the programId through per market, not a shared default", () => {
    const other = new PublicKey("SysvarC1ock11111111111111111111111111111111");
    const a = state({});
    const b = state({ market: { slabAddress: PublicKey.unique(), programId: other } });

    const picked = selectFeeCrankMarkets([a, b]);

    expect(picked[0].programId).toEqual(PROGRAM);
    expect(picked[1].programId).toEqual(other);
  });

  it("an empty tracked set selects nothing", () => {
    expect(selectFeeCrankMarkets([])).toEqual([]);
  });
});
