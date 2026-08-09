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
}));

vi.mock("@percolatorct/shared", () => ({
  getConnection: vi.fn(() => ({ id: "connection" })),
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
}));

import { MonitorService } from "../../src/services/monitor.js";
import * as sdk from "@percolatorct/sdk";

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

  it("#347: never reports a v17 market as ok:true — an unevaluated check is not a passing one", async () => {
    // The load-bearing assertion. Since the v17 cutover every production market
    // takes this branch, so `ok: true` here meant the only fund-conservation
    // tripwire in the codebase emitted green across the entire live market set
    // without ever computing anything.
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
});
