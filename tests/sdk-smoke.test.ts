/**
 * SDK publish smoke test — runs against the *installed* @percolatorct/sdk package.
 *
 * Purpose: catch publish-time regressions (missing exports, bad tarball, files: glob
 * mistakes, dist/ not regenerated) that are invisible when pnpm uses a workspace link.
 *
 * This test does NOT make RPC calls. Everything is pure in-process computation so it
 * runs reliably in CI without any environment secrets.
 *
 * Updated for SDK 3.0.0 (v17 convergence):
 *   - encodeKeeperCrank() now throws (v12.17 wire format rejected by v17 wrapper)
 *   - encodeExecuteAdl()  now throws (ExecuteAdl not in v17 wrapper)
 *   - encodePermissionlessCrank() / CrankAction are the v17 replacements
 *   - encodeRestartAssetOracle() is the new tag-69 recovery path
 */

import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";

// ── 1. Named-export existence ─────────────────────────────────────────────────
// Every symbol the keeper actually imports must resolve without throwing.
//
// v17 keeper sources:
//   liquidation.ts — fetchSlab, parseConfig, parseEngine, parseParams, parseAccount,
//                    parseUsedIndices, detectLayout, buildIx,
//                    encodePermissionlessCrank, CrankAction,
//                    derivePythPushOraclePDA, DiscoveredMarket (type)
//   crank.ts       — discoverMarkets, encodePermissionlessCrank, CrankAction,
//                    buildIx, derivePythPushOraclePDA, fetchSlab, parseHeader,
//                    parseConfig, parseEngine, parseParams, DiscoveredMarket (type)
//   adl.ts         — REMOVED (empty stub in v17)
//   monitor.ts     — fetchSlab, parseEngine, parseConfig
//   crank-types.ts — DiscoveredMarket (type only)
import {
  // slab parsing
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  parseAccount,
  parseUsedIndices,
  parseAllAccounts,
  detectLayout,
  detectSlabLayout,
  // v17 instruction encoding (replaces encodeKeeperCrank)
  encodePermissionlessCrank,
  CrankAction,
  // legacy encoders — still exported but encodeKeeperCrank/encodeExecuteAdl throw
  encodeKeeperCrank,
  encodeLiquidateAtOracle,
  encodeExecuteAdl,
  encodeUpdateHyperpMark,
  // account meta helpers
  buildAccountMetas,
  buildIx,
  // ACCOUNTS_ constants (still exported for reference)
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_EXECUTE_ADL,
  // PDA derivation
  derivePythPushOraclePDA,
  // market discovery
  discoverMarkets,
  detectDexType,
} from "@percolatorct/sdk";

// Type-only imports — these exercise the .d.ts surface without runtime cost.
import type {
  DiscoveredMarket,
  MarketConfig,
  EngineState,
  RiskParams,
  SlabLayout,
  AccountSpec,
  DexType,
} from "@percolatorct/sdk";

// ── 2. Constants / account specs ──────────────────────────────────────────────

describe("@percolatorct/sdk exports — account specs (keeper)", () => {
  it("ACCOUNTS_KEEPER_CRANK is a non-empty readonly array (retained for reference)", () => {
    expect(Array.isArray(ACCOUNTS_KEEPER_CRANK)).toBe(true);
    expect(ACCOUNTS_KEEPER_CRANK.length).toBeGreaterThan(0);
  });

  it("ACCOUNTS_PERMISSIONLESS_CRANK_BASE is a non-empty readonly array (v17)", () => {
    expect(Array.isArray(ACCOUNTS_PERMISSIONLESS_CRANK_BASE)).toBe(true);
    expect(ACCOUNTS_PERMISSIONLESS_CRANK_BASE.length).toBeGreaterThan(0);
  });

  it("ACCOUNTS_LIQUIDATE_AT_ORACLE is a non-empty readonly array", () => {
    expect(Array.isArray(ACCOUNTS_LIQUIDATE_AT_ORACLE)).toBe(true);
    expect(ACCOUNTS_LIQUIDATE_AT_ORACLE.length).toBeGreaterThan(0);
  });

  it("ACCOUNTS_EXECUTE_ADL is a non-empty readonly array (retained for reference)", () => {
    expect(Array.isArray(ACCOUNTS_EXECUTE_ADL)).toBe(true);
    expect(ACCOUNTS_EXECUTE_ADL.length).toBeGreaterThan(0);
  });
});

// ── 3. encodeKeeperCrank removal guard + encodePermissionlessCrank round-trip ──
// v17: encodeKeeperCrank throws at runtime — v12.17 wire format rejected by wrapper.
// encodePermissionlessCrank is the canonical v17 replacement.

describe("@percolatorct/sdk exports — encodeKeeperCrank removal guard (v17)", () => {
  it("encodeKeeperCrank is a function (still exported for type-only callers)", () => {
    expect(typeof encodeKeeperCrank).toBe("function");
  });

  it("encodeKeeperCrank throws at runtime in SDK 3.0.0 — v12.17 wire rejected by v17 wrapper", () => {
    expect(() => encodeKeeperCrank({ callerIdx: 0 })).toThrow(
      /v12\.17 wire format is not accepted/,
    );
  });
});

describe("@percolatorct/sdk exports — encodePermissionlessCrank (v17 replacement)", () => {
  it("encodePermissionlessCrank is a function", () => {
    expect(typeof encodePermissionlessCrank).toBe("function");
  });

  it("CrankAction has FeeSweep=0 and Liquidate=1", () => {
    expect(CrankAction.FeeSweep).toBe(0);
    expect(CrankAction.Liquidate).toBe(1);
  });

  it("encodePermissionlessCrank(FeeSweep) returns a non-empty Uint8Array", () => {
    const data = encodePermissionlessCrank({
      action: CrankAction.FeeSweep,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    expect(data).toBeInstanceOf(Uint8Array);
    // tag(1) + action(1) + assetIndex(2) + nowSlot(8) + fundingRateE9(16) + closeQ(16) + feeBps(8) + recoveryReason(1) = 53 bytes
    expect(data.length).toBeGreaterThanOrEqual(10);
  });

  it("encodePermissionlessCrank tag byte is IX_TAG.PermissionlessCrank (5)", () => {
    const data = encodePermissionlessCrank({
      action: CrankAction.FeeSweep,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    expect(data[0]).toBe(5);
  });

  it("encodePermissionlessCrank action byte is 0 for FeeSweep", () => {
    const data = encodePermissionlessCrank({
      action: CrankAction.FeeSweep,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    expect(data[1]).toBe(0); // FeeSweep = 0
  });

  it("encodePermissionlessCrank action byte is 1 for Liquidate", () => {
    const data = encodePermissionlessCrank({
      action: CrankAction.Liquidate,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    expect(data[1]).toBe(1); // Liquidate = 1
  });
});

// ── 4. encodeLiquidateAtOracle round-trip ─────────────────────────────────────

describe("@percolatorct/sdk exports — encodeLiquidateAtOracle (keeper)", () => {
  it("encodeLiquidateAtOracle is a function", () => {
    expect(typeof encodeLiquidateAtOracle).toBe("function");
  });

  // v17: LiquidateAtOracle (v12 tag 7) is NOT in the v17 wrapper — replaced by
  // PermissionlessCrank (tag 5). encodeLiquidateAtOracle() throws removedInstruction()
  // so it can't be accidentally used against a v17 program.
  it("encodeLiquidateAtOracle throws at runtime in v17 — replaced by PermissionlessCrank", () => {
    expect(() => encodeLiquidateAtOracle({ targetIdx: 0 })).toThrow();
  });

  it("encodeLiquidateAtOracle throws for any targetIdx", () => {
    expect(() => encodeLiquidateAtOracle({ targetIdx: 42 })).toThrow();
  });
});

// ── 5. encodeExecuteAdl removal guard (v17) ──────────────────────────────────
// v17: ExecuteAdl (v12 tag 50/101) is not in the v17 wrapper program.
// encodeExecuteAdl() throws removedInstruction() — runtime guard prevents
// accidental use against v17 programs.

describe("@percolatorct/sdk exports — encodeExecuteAdl removal guard (v17)", () => {
  it("encodeExecuteAdl is a function (still exported for type compatibility)", () => {
    expect(typeof encodeExecuteAdl).toBe("function");
  });

  it("encodeExecuteAdl throws at runtime in SDK 3.0.0 — ExecuteAdl not in v17 wrapper", () => {
    expect(() => encodeExecuteAdl({ targetIdx: 0 })).toThrow();
  });

  it("encodeExecuteAdl throws for any targetIdx", () => {
    expect(() => encodeExecuteAdl({ targetIdx: 5 })).toThrow();
  });
});

// ── 6. encodeUpdateHyperpMark round-trip ──────────────────────────────────────

describe("@percolatorct/sdk exports — encodeUpdateHyperpMark (keeper/crank)", () => {
  it("encodeUpdateHyperpMark is a function", () => {
    expect(typeof encodeUpdateHyperpMark).toBe("function");
  });

  // v17: UpdateHyperpMark (v12 DEX-pool mark crank, tag 34) is removed — tag 34 is
  // ConfigureHybridOracle in v17. encodeUpdateHyperpMark() throws removedInstruction();
  // mark refresh now goes through PermissionlessCrank (tag 5) / ConfigureEwmaMark (tag 35).
  it("encodeUpdateHyperpMark throws at runtime in v17 — tag 34 is now ConfigureHybridOracle", () => {
    expect(() => encodeUpdateHyperpMark()).toThrow();
  });
});

// ── 7. PDA derivation ─────────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — PDA derivation (keeper)", () => {
  it("derivePythPushOraclePDA is a function", () => {
    expect(typeof derivePythPushOraclePDA).toBe("function");
  });

  it("derivePythPushOraclePDA returns [PublicKey, number] for a 64-char hex feed id", () => {
    const feedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const [pda, bump] = derivePythPushOraclePDA(feedId);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it("derivePythPushOraclePDA is deterministic", () => {
    const feedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    const [a] = derivePythPushOraclePDA(feedId);
    const [b] = derivePythPushOraclePDA(feedId);
    expect(a.toBase58()).toBe(b.toBase58());
  });
});

// ── 8. buildIx round-trip ─────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — buildIx (keeper)", () => {
  it("buildIx is a function", () => {
    expect(typeof buildIx).toBe("function");
  });

  it("buildIx constructs a TransactionInstruction with correct fields", () => {
    const DUMMY = new PublicKey("11111111111111111111111111111111");
    const data = encodePermissionlessCrank({
      action: CrankAction.FeeSweep,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    const ix = buildIx({ programId: DUMMY, keys: [], data });
    expect(ix).toBeDefined();
    expect(ix.programId.toBase58()).toBe(DUMMY.toBase58());
    expect(Array.isArray(ix.keys)).toBe(true);
  });
});

// ── 9. buildAccountMetas ──────────────────────────────────────────────────────

describe("@percolatorct/sdk exports — buildAccountMetas (keeper)", () => {
  it("buildAccountMetas is a function", () => {
    expect(typeof buildAccountMetas).toBe("function");
  });
});

// ── 10. slab layout detection ────────────────────────────────────────────────

describe("@percolatorct/sdk exports — detectLayout / detectSlabLayout (keeper)", () => {
  it("detectLayout is a function", () => {
    expect(typeof detectLayout).toBe("function");
  });

  it("detectSlabLayout is a function", () => {
    expect(typeof detectSlabLayout).toBe("function");
  });

  it("detectLayout returns null for an unknown size", () => {
    expect(detectLayout(1)).toBeNull();
  });

  it("detectSlabLayout returns null for an unknown size", () => {
    expect(detectSlabLayout(1)).toBeNull();
  });

  it("detectSlabLayout returns a V12_19 layout for 96784 bytes (mainnet small)", () => {
    // v12.19 small slab — what the live mainnet program produces under --features small.
    // Wrapper anchor: percolator-prog post v12.19 af43efc redeploy (mainnet 2026-05-01).
    const layout = detectSlabLayout(96784);
    expect(layout).not.toBeNull();
    if (layout !== null) {
      expect(layout.maxAccounts).toBe(256);
      expect(layout.configLen).toBe(480);
      expect(layout.accountSize).toBe(360);
    }
  });
});

// ── 11. market discovery & dex oracle (shape-only, no network) ───────────────

describe("@percolatorct/sdk exports — market discovery / dex oracle (keeper)", () => {
  it("discoverMarkets is a function", () => {
    expect(typeof discoverMarkets).toBe("function");
  });

  it("detectDexType is a function", () => {
    expect(typeof detectDexType).toBe("function");
  });

  it("detectDexType returns null for system program (not a DEX)", () => {
    const SYSTEM = new PublicKey("11111111111111111111111111111111");
    expect(detectDexType(SYSTEM)).toBeNull();
  });
});

// ── 12. parse functions are functions ─────────────────────────────────────────

describe("@percolatorct/sdk exports — parse function shapes (keeper)", () => {
  it("fetchSlab is a function", () => {
    expect(typeof fetchSlab).toBe("function");
  });

  it("parseHeader is a function", () => {
    expect(typeof parseHeader).toBe("function");
  });

  it("parseConfig is a function", () => {
    expect(typeof parseConfig).toBe("function");
  });

  it("parseEngine is a function", () => {
    expect(typeof parseEngine).toBe("function");
  });

  it("parseParams is a function", () => {
    expect(typeof parseParams).toBe("function");
  });

  it("parseAccount is a function", () => {
    expect(typeof parseAccount).toBe("function");
  });

  it("parseUsedIndices is a function", () => {
    expect(typeof parseUsedIndices).toBe("function");
  });

  it("parseAllAccounts is a function", () => {
    expect(typeof parseAllAccounts).toBe("function");
  });
});
