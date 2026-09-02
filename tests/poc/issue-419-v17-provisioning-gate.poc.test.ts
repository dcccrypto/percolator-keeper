/**
 * PoC + regression guard for #419.
 *
 * `discover()` called `ensureKeeperPortfolio` for every newly-discovered or
 * portfolio-less market, and `ensureKeeperPortfolio` did not check the market
 * version — it went straight to `provisionKeeperPortfolio`, which submits a
 * v17 `createAccount` (9347 bytes of rent) plus `InitPortfolio` (tag 1).
 * `registerMarket()` gated on this; the `discover()` paths did not.
 *
 * A legacy v12 market therefore drew a fresh provisioning attempt every
 * discovery cycle: wasted rent and fees, and a keeper-signed tag 1 that a v12
 * program may decode as an entirely different instruction.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { isV17DiscoveredMarket } from "../../src/services/crank.js";

const KEY = PublicKey.default;
const base = { slabAddress: KEY, programId: KEY, config: {}, params: {} };

describe("#419 — v17 provisioning is gated on the market actually being v17", () => {
  it("recognises a v17 market by its raw config", () => {
    // The v17 discovery path stamps _rawV17Config.
    expect(isV17DiscoveredMarket({ ...base, _rawV17Config: {} } as never)).toBe(true);
  });

  it("recognises a v17 market by header version+kind", () => {
    // Markets arriving by another route carry the header instead.
    expect(
      isV17DiscoveredMarket({ ...base, header: { version: 16, kind: 1 } } as never),
    ).toBe(true);
  });

  it("REJECTS a legacy v12 market — the defect", () => {
    expect(
      isV17DiscoveredMarket({ ...base, header: { version: 12, kind: 0 } } as never),
    ).toBe(false);
  });

  it("requires BOTH version and kind, not either", () => {
    // v16/kind!=1 is a different account shape; version alone must not qualify.
    expect(isV17DiscoveredMarket({ ...base, header: { version: 16, kind: 0 } } as never)).toBe(false);
    expect(isV17DiscoveredMarket({ ...base, header: { version: 12, kind: 1 } } as never)).toBe(false);
  });

  it("accepts bigint header fields, which is how they arrive from the parser", () => {
    expect(
      isV17DiscoveredMarket({ ...base, header: { version: 16n, kind: 1n } } as never),
    ).toBe(true);
  });

  it("REJECTS a market with no header and no raw config rather than assuming v17", () => {
    // Fail closed: an unknown shape must not draw a v17 provisioning attempt.
    expect(isV17DiscoveredMarket({ ...base } as never)).toBe(false);
  });
});
