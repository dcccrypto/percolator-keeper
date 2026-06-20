import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

vi.mock("@percolatorct/sdk", () => ({
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
    expect(status.invariants).toEqual([
      expect.objectContaining({
        slabAddress,
        ok: true,
        skippedReason: expect.stringContaining("v17 market account"),
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
