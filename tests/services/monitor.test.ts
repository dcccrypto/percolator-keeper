import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSlab: vi.fn(),
  isV17Account: vi.fn(() => false),
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseWrapperConfigV17: vi.fn(() => ({
    collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
  })),
  deriveCanonicalVault: vi.fn(() => [
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    255,
  ]),
}));

/** Mutable per-test stubs for the monitor's RPC reads. */
const getTokenAccountBalance = vi.fn();
const getMultipleAccountsInfo = vi.fn();

/** SPL token account bytes with `amount` at offset 64. */
function tokenAccount(amount: bigint): { data: Uint8Array } {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data };
}

vi.mock("@percolatorct/shared", () => ({
  getConnection: vi.fn(() => ({
    id: "connection",
    getTokenAccountBalance,
    getMultipleAccountsInfo,
  })),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendCriticalAlert: vi.fn(),
  sendWarningAlert: vi.fn(),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  cycleDurationSeconds: { observe: vi.fn() },
  conservationInvariantState: { set: vi.fn() },
}));

import { MonitorService } from "../../src/services/monitor.js";
import * as sdk from "@percolatorct/sdk";
import * as shared from "@percolatorct/shared";

describe("MonitorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records an explicit skip for v17 markets instead of running legacy v12 parsers", async () => {
    const service = new MonitorService();
    const slabAddress = "11111111111111111111111111111111";
    const market = {
      slabAddress: new PublicKey(slabAddress),
    };
    const markets = new Map([
      [slabAddress, { market }],
    ]);

    vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(sdk.isV17Account).mockReturnValue(true);
    vi.mocked(sdk.parseEngine).mockImplementation(() => {
      throw new Error("legacy parser should not run for v17");
    });

    service.setMarketSource(() => markets as any);
    await (service as any)._runChecks();

    const status = service.getStatus();
    expect(sdk.parseEngine).not.toHaveBeenCalled();
    expect(sdk.parseConfig).not.toHaveBeenCalled();
    // #347: this previously asserted `ok: true`, codifying the bug — a v17
    // market was reported healthy without the conservation invariant ever
    // running. `null` means "not evaluated" and is the whole point.
    expect(status.invariants).toEqual([
      expect.objectContaining({
        slabAddress,
        ok: null,
        skippedReason: expect.stringContaining("UNCHECKED"),
      }),
    ]);
    expect(status.adlStaleness).toEqual([
      expect.objectContaining({
        slabAddress,
        adlNeeded: false,
        stale: false,
        skippedReason: expect.stringContaining("v17 removed ExecuteAdl"),
      }),
    ]);
  });

  it("#347: an UNPARSEABLE v17 market is ok:null — a failed evaluation is not a passing one", async () => {
    // Originally this pinned that the v17 branch never reported ok:true while
    // the invariant was unimplemented. The invariant now runs, so what this
    // pins is the fail-safe: the market group cannot be read from a 3-byte
    // stub, and that must surface as unevaluated rather than healthy.
    const service = new MonitorService();
    const slabAddress = "11111111111111111111111111111111";
    const markets = new Map([
      [slabAddress, { market: { slabAddress: new PublicKey(slabAddress) } }],
    ]);

    vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(sdk.isV17Account).mockReturnValue(true);

    service.setMarketSource(() => markets as any);
    await (service as any)._runChecks();

    const [invariant] = service.getStatus().invariants;
    expect(invariant.ok).not.toBe(true);
    expect(invariant.ok).toBeNull();
  });

  it("#347: does not fabricate zeroed balances for an unevaluated v17 market", async () => {
    // shortfall "0" reads as "checked, nothing missing" on a dashboard, which is
    // the same false-green in a different field. Unevaluated must be null.
    const service = new MonitorService();
    const slabAddress = "11111111111111111111111111111111";
    const markets = new Map([
      [slabAddress, { market: { slabAddress: new PublicKey(slabAddress) } }],
    ]);

    vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(sdk.isV17Account).mockReturnValue(true);

    service.setMarketSource(() => markets as any);
    await (service as any)._runChecks();

    const [invariant] = service.getStatus().invariants;
    expect(invariant.shortfall).toBeNull();
    expect(invariant.vaultTokenBalance).toBeNull();
    expect(invariant.engineVault).toBeNull();
  });

  it("M-6: passes the market's programId to fetchSlab as expectedOwner", async () => {
    const service = new MonitorService();
    const slabAddress = "11111111111111111111111111111111";
    const programId = new PublicKey("So11111111111111111111111111111111111111112");
    const market = {
      slabAddress: new PublicKey(slabAddress),
      programId,
    };
    const markets = new Map([[slabAddress, { market }]]);

    vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(sdk.isV17Account).mockReturnValue(true);

    service.setMarketSource(() => markets as any);
    await (service as any)._runChecks();

    expect(sdk.fetchSlab).toHaveBeenCalledWith(
      expect.anything(),
      market.slabAddress,
      programId,
    );
  });

  describe("#347: the v17 conservation invariant actually runs", () => {
    // V17_MARKET_GROUP_OFF (592) + MG_VAULT_OFF (285) = 877. Building a real
    // buffer rather than mocking readMarketGroupState pins the OFFSET too — a
    // wrong offset silently compares the wrong u128, which is the failure mode
    // that would quietly recreate this bug.
    const VAULT_ABS_OFF = 877;

    function v17SlabWithVault(accountedVault: bigint): Uint8Array {
      const buf = new Uint8Array(4096);
      const dv = new DataView(buf.buffer);
      // Write the FULL u128 (both halves). Writing only the low 8 bytes would
      // let an off-by-8 that reads the high half still pass for small values.
      dv.setBigUint64(VAULT_ABS_OFF, accountedVault & 0xffffffffffffffffn, true);
      dv.setBigUint64(VAULT_ABS_OFF + 8, accountedVault >> 64n, true);
      // Poison the neighbouring u128s (insurance @ +16, and the 8 bytes before)
      // so reading an adjacent field produces a wrong answer rather than a
      // coincidentally-passing zero.
      dv.setBigUint64(VAULT_ABS_OFF + 16, 999_999_999n, true);
      dv.setBigUint64(VAULT_ABS_OFF - 8, 888_888_888n, true);
      return buf;
    }

    function marketsFor(slabAddress: string) {
      return new Map([
        [
          slabAddress,
          {
            market: {
              slabAddress: new PublicKey(slabAddress),
              programId: new PublicKey("11111111111111111111111111111111"),
            },
          },
        ],
      ]);
    }

    async function runWith(accountedVault: bigint, splBalance: string) {
      const service = new MonitorService();
      const slabAddress = "11111111111111111111111111111111";
      vi.mocked(sdk.fetchSlab).mockResolvedValue(v17SlabWithVault(accountedVault));
      vi.mocked(sdk.isV17Account).mockReturnValue(true);
      getMultipleAccountsInfo.mockResolvedValue([
        { data: v17SlabWithVault(accountedVault) },
        tokenAccount(BigInt(splBalance)),
      ]);
      service.setMarketSource(() => marketsFor(slabAddress) as any);
      await (service as any)._runChecks();
      return service.getStatus().invariants[0];
    }

    it("asks the RPC for the CORRECT vault address, not just some address", async () => {
      // The most consequential thing that can silently be wrong: a wrong
      // address means the balance read rejects, the market is ok:null forever,
      // and nothing pages. Both mocked derivations are pinned to their inputs.
      const slabAddress = "11111111111111111111111111111111";
      await runWith(1_000_000n, "1000000");

      expect(vi.mocked(sdk.deriveCanonicalVault)).toHaveBeenCalledWith(
        new PublicKey("11111111111111111111111111111111"),
        new PublicKey(slabAddress),
        new PublicKey("So11111111111111111111111111111111111111112"),
      );
      expect(getMultipleAccountsInfo).toHaveBeenCalledWith([
        new PublicKey(slabAddress),
        new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      ]);
    });

    it("a missing vault token account is ok:null, never healthy", async () => {
      const service = new MonitorService();
      const slabAddress = "11111111111111111111111111111111";
      service.setMarketSource(() => marketsFor(slabAddress) as any);
      vi.mocked(sdk.fetchSlab).mockResolvedValue(v17SlabWithVault(1_000_000n));
      vi.mocked(sdk.isV17Account).mockReturnValue(true);
      getMultipleAccountsInfo.mockResolvedValue([
        { data: v17SlabWithVault(1_000_000n) },
        null, // ATA not created yet — the program never creates it
      ]);
      await (service as any)._runChecks();

      const [invariant] = service.getStatus().invariants;
      expect(invariant.ok).toBeNull();
      expect(invariant.skippedReason).toContain("does not exist");
    });

    it("reports ok:true when the SPL balance covers the accounted vault", async () => {
      const invariant = await runWith(1_000_000n, "1000000");
      expect(invariant.ok).toBe(true);
      expect(invariant.engineVault).toBe("1000000");
      expect(invariant.vaultTokenBalance).toBe("1000000");
      expect(invariant.shortfall).toBe("0");
      expect(invariant.skippedReason).toBeUndefined();
    });

    it("DETECTS a shortfall — the whole point of the tripwire", async () => {
      const invariant = await runWith(1_000_000n, "999999");
      expect(invariant.ok).toBe(false);
      expect(invariant.shortfall).toBe("1");
    });

    it("pages on a violation", async () => {
      await runWith(5_000_000n, "4000000");
      expect(vi.mocked(shared.sendCriticalAlert)).toHaveBeenCalledWith(
        expect.stringContaining("v17 vault underfunded"),
        expect.anything(),
      );
    });

    it("a surplus is fine — rounding can leave the vault over-funded", async () => {
      const invariant = await runWith(1_000_000n, "1000001");
      expect(invariant.ok).toBe(true);
      expect(invariant.shortfall).toBe("0");
    });

    it("a fetchSlab failure INVALIDATES the previous result — no stale green", async () => {
      // Once v17 can evaluate to ok:true, leaving the prior cycle's entry in
      // place on an outer failure is the same false green with a stale
      // checkedAt. The invariant must go back to unevaluated.
      const service = new MonitorService();
      const slabAddress = "11111111111111111111111111111111";
      service.setMarketSource(() => marketsFor(slabAddress) as any);

      vi.mocked(sdk.fetchSlab).mockResolvedValue(v17SlabWithVault(1_000_000n));
      vi.mocked(sdk.isV17Account).mockReturnValue(true);
      getMultipleAccountsInfo.mockResolvedValue([
        { data: v17SlabWithVault(1_000_000n) },
        tokenAccount(1_000_000n),
      ]);
      await (service as any)._runChecks();
      expect(service.getStatus().invariants[0].ok).toBe(true);

      vi.mocked(sdk.fetchSlab).mockRejectedValue(new Error("rpc down"));
      await (service as any)._runChecks();

      const [invariant] = service.getStatus().invariants;
      expect(invariant.ok).not.toBe(true);
      expect(invariant.ok).toBeNull();
      expect(invariant.skippedReason).toContain("UNCHECKED");
    });

    it("a throw AFTER the comparison does not erase a detected violation", async () => {
      // The invalidation above must not overreach: if the shortfall was already
      // computed this cycle, a later failure (alert delivery, say) must leave
      // ok:false standing rather than downgrading it to "unknown".
      const service = new MonitorService();
      const slabAddress = "11111111111111111111111111111111";
      service.setMarketSource(() => marketsFor(slabAddress) as any);
      vi.mocked(sdk.fetchSlab).mockResolvedValue(v17SlabWithVault(1_000_000n));
      vi.mocked(sdk.isV17Account).mockReturnValue(true);
      getMultipleAccountsInfo.mockResolvedValue([
        { data: v17SlabWithVault(1_000_000n) },
        tokenAccount(999_999n),
      ]);
      vi.mocked(shared.sendCriticalAlert).mockImplementation(() => {
        throw new Error("discord down");
      });

      await (service as any)._runChecks();

      const [invariant] = service.getStatus().invariants;
      expect(invariant.ok).toBe(false);
      expect(invariant.shortfall).toBe("1");
    });

    it("an RPC failure is ok:null, NOT ok:true — the original defect", async () => {
      const service = new MonitorService();
      const slabAddress = "11111111111111111111111111111111";
      vi.mocked(sdk.fetchSlab).mockResolvedValue(v17SlabWithVault(1_000_000n));
      vi.mocked(sdk.isV17Account).mockReturnValue(true);
      getMultipleAccountsInfo.mockRejectedValue(new Error("rpc down"));
      service.setMarketSource(() => marketsFor(slabAddress) as any);
      await (service as any)._runChecks();

      const [invariant] = service.getStatus().invariants;
      expect(invariant.ok).toBeNull();
      expect(invariant.ok).not.toBe(true);
      expect(invariant.vaultTokenBalance).toBeNull();
      expect(invariant.shortfall).toBeNull();
      expect(invariant.skippedReason).toContain("UNCHECKED");
    });
  });
});
