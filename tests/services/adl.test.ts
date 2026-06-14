/**
 * Unit tests for AdlService — OBSERVE-ONLY.
 *
 * ExecuteAdl is admin/multisig-gated on dcccrypto/percolator-prog (require_admin +
 * insurance must be fully depleted), so the keeper does NOT send it. This service
 * only evaluates and reports the on-chain ADL preconditions. These tests assert
 * that behaviour: it never sends, and adlNeeded matches the program's gate
 * (insurance balance == 0 AND profit above the PnL cap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── mocks ───────────────────────────────────────────────────────────────────

vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(),
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseAllAccounts: vi.fn(() => []),
}));

vi.mock("@percolatorct/shared", () => ({
  getConnection: vi.fn(() => ({})),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(async () => {}),
}));

import * as sdk from "@percolatorct/sdk";
import * as shared from "@percolatorct/shared";
import { AdlService } from "../../src/services/adl.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const slabKey = {
  toBase58: () => "slabKey1111111111111111111111111111111111",
  equals: () => false,
  toBytes: () => new Uint8Array(32),
};

function makeMarket() {
  return {
    slabAddress: slabKey,
    programId: { toBase58: () => "progId1111111111111111111111111111111111111" },
  };
}

function makeEngine(
  overrides: Partial<{ pnlPosTot: bigint; balance: bigint; feeRevenue: bigint }> = {},
) {
  return {
    pnlPosTot: overrides.pnlPosTot ?? 1_000_000n,
    insuranceFund: {
      balance: overrides.balance ?? 0n, // depleted by default = ADL admissible
      feeRevenue: overrides.feeRevenue ?? 0n,
      isolatedBalance: 0n,
      isolationBps: 0,
    },
  };
}

function makeConfig(overrides: Partial<{ maxPnlCap: bigint }> = {}) {
  return { maxPnlCap: overrides.maxPnlCap ?? 500_000n };
}

function makeAccounts(
  entries: { idx: number; pnl: bigint; capital: bigint; positionSize: bigint }[],
) {
  return entries.map(({ idx, pnl, capital, positionSize }) => ({
    idx,
    account: { pnl, capital, positionSize },
  }));
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("AdlService (observe-only)", () => {
  let service: AdlService;
  const slabAddress = "slabKey1111111111111111111111111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    service?.stop();
  });

  describe("scanMarket — ADL preconditions NOT met", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
    });

    it("returns 0 when insurance fund is NOT depleted, even if pnl > cap (ADL-1 fix)", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 5_000_000n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
      expect(service.getStats().get(slabAddress)?.adlNeeded).toBe(false);
    });

    it("returns 0 when pnl <= cap (insurance depleted)", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 400_000n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
    });
  });

  describe("scanMarket — ADL preconditions met", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
    });

    it("returns 1 when insurance depleted AND pnl > cap, and SENDS NOTHING", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(1);
      expect(service.getStats().get(slabAddress)?.adlNeeded).toBe(true);
      // observe-only: a rate-limited operator alert may fire, but nothing is signed/sent.
    });

    it("returns 1 when cap is disabled (cap==0) AND insurance depleted AND profit exists", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 9_999_999n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 0n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(1);
    });

    it("emits a rate-limited 'admin/multisig action required' alert (not a tx)", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      await service.scanMarket(slabAddress, makeMarket() as any);
      await service.scanMarket(slabAddress, makeMarket() as any); // cooldown — second is suppressed

      expect(shared.sendWarningAlert).toHaveBeenCalledTimes(1);
      expect(vi.mocked(shared.sendWarningAlert).mock.calls[0][0]).toBe(
        "ADL conditions met — admin/multisig action required",
      );
    });
  });

  describe("getAdlState — read-only", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
    });

    it("reports adlNeeded=false with a non-zero insurance balance", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 5_000_000n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      const state = await service.getAdlState(slabAddress, makeMarket() as any);
      expect(state.adlNeeded).toBe(false);
      expect(state.insuranceDepleted).toBe(false);
      expect(state.capExceeded).toBe(true);
      expect(state.rankings).toEqual([]);
    });

    it("returns PnL%-ranked positions when ADL is admissible", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 5, pnl: 800_000n, capital: 10_000_000n, positionSize: 200n }, // 8%
          { idx: 2, pnl: 300_000n, capital: 1_000_000n, positionSize: 100n }, // 30%
        ]) as any,
      );

      const state = await service.getAdlState(slabAddress, makeMarket() as any);
      expect(state.adlNeeded).toBe(true);
      // highest PnL% ranked first
      expect(state.rankings[0].idx).toBe(2);
      expect(state.rankings[1].idx).toBe(5);
    });
  });

  describe("scanMarket — error handling", () => {
    beforeEach(() => {
      service = new AdlService();
    });

    it("returns 0 and logs when fetchSlab fails", async () => {
      vi.mocked(sdk.fetchSlab).mockRejectedValue(new Error("RPC timeout"));
      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
    });
  });

  describe("watchdog timer — cycling guard", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      service = new AdlService();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resets _cycling flag when cycle exceeds MAX_CYCLE_MS (5x interval)", async () => {
      const markets = new Map();
      service.start(() => markets);

      (service as any)._cycling = true;
      (service as any)._cycleStartedAt = Date.now() - 60_000; // > 5 * 10s default

      await vi.advanceTimersByTimeAsync(10_001);

      expect((service as any)._cycling).toBe(false);
      expect(shared.sendWarningAlert).toHaveBeenCalledWith(
        "ADL cycle hung — watchdog reset",
        expect.any(Array),
      );
    });

    it("skips a new cycle when the previous one is still running (within timeout)", async () => {
      const markets = new Map();
      service.start(() => markets);

      (service as any)._cycling = true;
      (service as any)._cycleStartedAt = Date.now();

      await vi.advanceTimersByTimeAsync(10_001);

      expect((service as any)._cycling).toBe(true);
      expect(shared.sendWarningAlert).not.toHaveBeenCalledWith(
        "ADL cycle hung — watchdog reset",
        expect.any(Array),
      );
    });
  });

  describe("getStats", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
    });

    it("tracks adlNeeded per market", async () => {
      vi.mocked(sdk.parseEngine).mockReturnValue(
        makeEngine({ pnlPosTot: 1_000_000n, balance: 0n }) as any,
      );
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      await service.scanMarket(slabAddress, makeMarket() as any);

      const marketStats = service.getStats().get(slabAddress);
      expect(marketStats?.adlNeeded).toBe(true);
      expect(marketStats?.lastAdlNeededTime).toBeGreaterThan(0);
    });
  });
});
