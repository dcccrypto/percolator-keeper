/**
 * Unit tests for AdlService — PERC-8276
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── mocks (factories — no top-level variable references) ────────────────────

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => "SysvarC1ock11111111111111111111111111111111",
      equals: () => false,
    },
  };
});

vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(),
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseAllAccounts: vi.fn(),
  encodeExecuteAdl: vi.fn(() => Buffer.from([50, 0, 0])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({ keys: [], data: Buffer.from([]) })),
  derivePythPushOraclePDA: vi.fn(() => [
    { toBase58: () => "pythOracle111111111111111111111111111111111" },
    255,
  ]),
  ACCOUNTS_EXECUTE_ADL: {},
}));

vi.mock("@percolatorct/shared", () => ({
  getConnection: vi.fn(() => ({})),
  loadKeypair: vi.fn(() => ({
    publicKey: {
      toBase58: () => "keeperPubkey1111111111111111111111111111111",
      equals: (_other: unknown) => false,
    },
    secretKey: new Uint8Array(64),
  })),
  sendWithRetryKeeper: vi.fn(async () => "mockSig123"),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(async () => {}),
  sendCriticalAlert: vi.fn(async () => {}),
}));

// ─── import (after mocks) ─────────────────────────────────────────────────────

import * as sdk from "@percolatorct/sdk";
import * as shared from "@percolatorct/shared";
import { AdlService } from "../../src/services/adl.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const zeroKey = {
  toBase58: () => "11111111111111111111111111111111",
  equals: (other: { toBase58: () => string }) =>
    other.toBase58() === "11111111111111111111111111111111",
  toBytes: () => new Uint8Array(32),
};

const slabKey = {
  toBase58: () => "slabKey1111111111111111111111111111111111",
  equals: () => false,
  toBytes: () => new Uint8Array(32),
};

function makeMarket() {
  return {
    slabAddress: slabKey,
    programId: { toBase58: () => "progId1111111111111111111111111111111111111" },
    config: {
      oracleAuthority: zeroKey,
      indexFeedId: {
        toBase58: () => "feedId111111111111111111111111111111111111",
        toBytes: () => new Uint8Array(32), // all zeros = HYPERP
      },
    },
    engine: {},
    params: {},
    header: {},
  };
}

function makeEngine(overrides: Partial<{ pnlPosTot: bigint }> = {}) {
  return {
    pnlPosTot: overrides.pnlPosTot ?? 1_000_000n,
    insuranceFund: {
      balance: 5_000_000n,
      feeRevenue: 0n,
      isolatedBalance: 0n,
      isolationBps: 0,
    },
  };
}

function makeConfig(overrides: Partial<{
  maxPnlCap: bigint;
  indexFeedId: { toBytes: () => Uint8Array };
}> = {}) {
  return {
    maxPnlCap: overrides.maxPnlCap ?? 500_000n,
    oracleAuthority: zeroKey,
    indexFeedId: overrides.indexFeedId ?? { toBytes: () => new Uint8Array(32) },
  };
}

function makeAccounts(entries: { idx: number; pnl: bigint; capital: bigint; positionSize: bigint }[]) {
  return entries.map(({ idx, pnl, capital, positionSize }) => ({
    idx,
    account: {
      pnl,
      capital,
      positionSize,
      kind: 0,
      accountId: BigInt(idx),
      reservedPnl: 0n,
      warmupStartedAtSlot: 0n,
      warmupSlopePerStep: 0n,
      entryPrice: 0n,
      fundingIndex: 0n,
      matcherProgram: zeroKey,
      matcherContext: zeroKey,
      owner: zeroKey,
      feeCredits: 0n,
      lastFeeSlot: 0n,
    },
  }));
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("AdlService", () => {
  let service: AdlService;
  const slabAddress = "slabKey1111111111111111111111111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRANK_KEYPAIR = "mock-keypair";
  });

  afterEach(() => {
    service?.stop();
    delete process.env.ADL_INSURANCE_THRESHOLD_LAMPORTS;
    delete process.env.ADL_MAX_TX_PER_SCAN;
  });

  describe("scanMarket — ADL not needed", () => {
    beforeEach(() => {
      service = new AdlService();
    });

    it("returns 0 when pnl_pos_tot <= max_pnl_cap", async () => {
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 400_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
      expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    });

    it("returns 0 when max_pnl_cap is 0 (ADL disabled on market)", async () => {
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 9_999_999n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 0n }) as any);

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
    });
  });

  describe("scanMarket — ADL triggered", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
    });

    it("sends one ADL tx for the top-ranked position", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 3, pnl: 600_000n, capital: 1_000_000n, positionSize: 100n },
          { idx: 7, pnl: -100_000n, capital: 500_000n, positionSize: 50n }, // losing — skip
        ]) as any
      );

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(1);
      expect(sdk.encodeExecuteAdl).toHaveBeenCalledWith({ targetIdx: 3 });
      expect(shared.sendWithRetryKeeper).toHaveBeenCalledTimes(1);
    });

    // M3: success-path observer is invoked exactly once per successful ADL tx,
    // with the slab address as the argument. Until this hook was wired, the
    // MonitorService.notifyAdlTx() method existed but was never called →
    // per-market `cycleCountAtLastAdl` invariant gauge stayed at 0 forever.
    it("M3: invokes setOnAdlTx callback with slabAddress after each successful ADL tx", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 3, pnl: 600_000n, capital: 1_000_000n, positionSize: 100n },
        ]) as any
      );

      const onAdlTx = vi.fn();
      service.setOnAdlTx(onAdlTx);

      await service.scanMarket(slabAddress, makeMarket() as any);

      expect(onAdlTx).toHaveBeenCalledTimes(1);
      expect(onAdlTx).toHaveBeenCalledWith(slabAddress);
    });

    it("M3: does NOT invoke setOnAdlTx callback when the send fails", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 3, pnl: 600_000n, capital: 1_000_000n, positionSize: 100n },
        ]) as any
      );
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValueOnce(new Error("send failed"));

      const onAdlTx = vi.fn();
      service.setOnAdlTx(onAdlTx);

      await service.scanMarket(slabAddress, makeMarket() as any);

      expect(onAdlTx).not.toHaveBeenCalled();
    });

    it("M3: callback throwing does NOT abort the ADL cycle (errors swallowed as warn)", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 3, pnl: 600_000n, capital: 1_000_000n, positionSize: 100n },
          { idx: 5, pnl: 500_000n, capital: 1_000_000n, positionSize: 100n },
        ]) as any
      );

      service.setOnAdlTx(() => {
        throw new Error("observer threw");
      });

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      // Both ADL targets should still get processed despite the callback throwing.
      expect(result).toBeGreaterThanOrEqual(1);
    });

    it("targets the highest PnL% position first (not highest abs PnL)", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 5, pnl: 800_000n, capital: 10_000_000n, positionSize: 200n }, // 8%
          { idx: 2, pnl: 300_000n, capital: 1_000_000n, positionSize: 100n }, // 30%
        ]) as any
      );

      await service.scanMarket(slabAddress, makeMarket() as any);

      // First call should target idx 2 (highest PnL%)
      expect(sdk.encodeExecuteAdl).toHaveBeenNthCalledWith(1, { targetIdx: 2 });
    });

    it("returns 0 when no profitable positions exist", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 1, pnl: -500_000n, capital: 1_000_000n, positionSize: 100n },
          { idx: 2, pnl: 0n, capital: 500_000n, positionSize: 50n },
        ]) as any
      );

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
      expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
    });

    it("skips positions with zero positionSize", async () => {
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 9, pnl: 999_999n, capital: 1_000n, positionSize: 0n }, // no open position
        ]) as any
      );

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      expect(result).toBe(0);
    });
  });

  describe("scanMarket — oracle key selection", () => {
    beforeEach(() => {
      service = new AdlService();
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([{ idx: 0, pnl: 600_000n, capital: 500_000n, positionSize: 100n }]) as any
      );
    });

    it("uses slab as oracle for HYPERP market (indexFeedId=zeros, oracleAuthority=zeros)", async () => {
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({
        maxPnlCap: 500_000n,
        indexFeedId: { toBytes: () => new Uint8Array(32) }, // all zeros
      }) as any);

      await service.scanMarket(slabAddress, makeMarket() as any);

      expect(sdk.buildAccountMetas).toHaveBeenCalled();
      const callArgs = vi.mocked(sdk.buildAccountMetas).mock.calls[0];
      // 4th key is oracle — for HYPERP it should be the slab
      expect(callArgs[1][3]).toBe(slabKey);
    });

    it("derives Pyth oracle PDA for non-zero indexFeedId", async () => {
      const nonZeroFeed = new Uint8Array(32);
      nonZeroFeed[0] = 0xab;
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({
        maxPnlCap: 500_000n,
        indexFeedId: { toBytes: () => nonZeroFeed },
      }) as any);

      await service.scanMarket(slabAddress, makeMarket() as any);

      expect(sdk.derivePythPushOraclePDA).toHaveBeenCalled();
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

    it("continues to next position when a tx fails (partial success)", async () => {
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 2_000_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([
          { idx: 1, pnl: 900_000n, capital: 1_000_000n, positionSize: 100n }, // 90% PnL
          { idx: 2, pnl: 600_000n, capital: 1_000_000n, positionSize: 100n }, // 60% PnL
        ]) as any
      );

      // First tx (highest PnL%) fails, second succeeds
      vi.mocked(shared.sendWithRetryKeeper)
        .mockRejectedValueOnce(new Error("tx failed"))
        .mockResolvedValueOnce("sig2");

      const result = await service.scanMarket(slabAddress, makeMarket() as any);
      // Should have sent 1 successfully (idx 2)
      expect(result).toBe(1);
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
      // Setup: start the service with a market source
      const markets = new Map();
      service.start(() => markets);

      // Simulate a stuck cycle: manually set _cycling=true with an old timestamp
      // Access internal state for testing
      (service as any)._cycling = true;
      (service as any)._cycleStartedAt = Date.now() - 60_000; // 60s ago (> 5 * 10s default)

      // Advance timer to trigger the next interval tick
      await vi.advanceTimersByTimeAsync(10_001);

      // The watchdog should have reset _cycling to false
      expect((service as any)._cycling).toBe(false);
      // Should have sent a warning alert about the hung cycle
      expect(shared.sendWarningAlert).toHaveBeenCalledWith(
        "ADL cycle hung — watchdog reset",
        expect.any(Array),
      );
    });

    it("does not trigger watchdog when cycle completes within MAX_CYCLE_MS", async () => {
      const markets = new Map();
      service.start(() => markets);

      // Advance timer — scanAll returns immediately (no markets), well within limit
      await vi.advanceTimersByTimeAsync(10_001);

      // Watchdog alert should NOT have been sent
      expect(shared.sendWarningAlert).not.toHaveBeenCalledWith(
        "ADL cycle hung — watchdog reset",
        expect.any(Array),
      );
    });

    it("skips new cycle when previous cycle is still running (within timeout)", async () => {
      const markets = new Map();
      service.start(() => markets);

      // Simulate a running cycle that hasn't exceeded MAX_CYCLE_MS
      (service as any)._cycling = true;
      (service as any)._cycleStartedAt = Date.now(); // just started

      // Advance timer — should skip (not reset, not run new cycle)
      await vi.advanceTimersByTimeAsync(10_001);

      // _cycling should still be true (not reset by watchdog, not cleared by new cycle)
      expect((service as any)._cycling).toBe(true);
      // No watchdog alert
      expect(shared.sendWarningAlert).not.toHaveBeenCalledWith(
        "ADL cycle hung — watchdog reset",
        expect.any(Array),
      );
    });
  });

  describe("getStats", () => {
    beforeEach(() => {
      service = new AdlService();
    });

    it("tracks adlTxSent per market", async () => {
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([{ idx: 0, pnl: 600_000n, capital: 500_000n, positionSize: 100n }]) as any
      );

      await service.scanMarket(slabAddress, makeMarket() as any);

      const stats = service.getStats();
      const marketStats = stats.get(slabAddress);
      expect(marketStats?.adlTxSent).toBe(1);
      expect(marketStats?.consecutiveErrors).toBe(0);
    });

    it("increments consecutiveErrors on tx failure", async () => {
      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([{ idx: 0, pnl: 600_000n, capital: 500_000n, positionSize: 100n }]) as any
      );
      vi.mocked(shared.sendWithRetryKeeper).mockRejectedValue(new Error("fail"));

      await service.scanMarket(slabAddress, makeMarket() as any);

      const stats = service.getStats();
      const marketStats = stats.get(slabAddress);
      expect(marketStats?.consecutiveErrors).toBeGreaterThan(0);
    });
  });

  // A.9 (HIGH): ADL no longer bypasses KeeperBudget. The two behaviours
  // that the budget should now guard:
  //   1. budget halt blocks ADL from sending
  //   2. successful ADL records to the budget (so cap math sees ADL spend)
  describe("A.9: ADL through KeeperBudget + keeperSend", () => {
    beforeEach(() => {
      service = new AdlService();
    });

    it("does NOT send when sharedBudget is halted", async () => {
      const { sharedBudget } = await import("../../src/lib/keeper-send.js");
      sharedBudget.haltManually("A.9 test halt");

      try {
        vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
        vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
        vi.mocked(sdk.parseAllAccounts).mockReturnValue(
          makeAccounts([{ idx: 0, pnl: 600_000n, capital: 500_000n, positionSize: 100n }]) as any,
        );

        await service.scanMarket(slabAddress, makeMarket() as any);

        expect(shared.sendWithRetryKeeper).not.toHaveBeenCalled();
      } finally {
        sharedBudget.resume("a9-test-cleanup");
      }
    });

    it("records a successful ADL tx to sharedBudget (cycleTxCount and cycleSpend both grow)", async () => {
      const { sharedBudget } = await import("../../src/lib/keeper-send.js");
      sharedBudget.resume("a9-pre-test"); // ensure not halted from a prior test
      const before = sharedBudget.getStats();

      vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(sdk.parseEngine).mockReturnValue(makeEngine({ pnlPosTot: 1_000_000n }) as any);
      vi.mocked(sdk.parseConfig).mockReturnValue(makeConfig({ maxPnlCap: 500_000n }) as any);
      vi.mocked(sdk.parseAllAccounts).mockReturnValue(
        makeAccounts([{ idx: 0, pnl: 600_000n, capital: 500_000n, positionSize: 100n }]) as any,
      );

      await service.scanMarket(slabAddress, makeMarket() as any);

      const after = sharedBudget.getStats();
      expect(after.cycleTxCount).toBe(before.cycleTxCount + 1);
      expect(after.cycleSpend).toBeGreaterThan(before.cycleSpend);
    });
  });
});
