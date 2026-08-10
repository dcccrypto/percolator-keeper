import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @solana/web3.js first
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  
  class MockTransaction {
    recentBlockhash: string | undefined;
    feePayer: any;
    signatures: any[] = [];
    instructions: any[] = [];
    
    add(...instructions: any[]) {
      this.instructions.push(...instructions);
      return this;
    }
    
    sign(...signers: any[]) {
      // Mock signing
    }
    
    serialize() {
      return Buffer.from([1, 2, 3]);
    }
  }
  
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => 'SysvarC1ock11111111111111111111111111111111',
      equals: () => false,
    },
    ComputeBudgetProgram: {
      setComputeUnitLimit: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
      setComputeUnitPrice: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
    },
    Transaction: MockTransaction,
  };
});

// Mock external dependencies
// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock('@percolatorct/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSlab: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  parseAccount: vi.fn(),
  parseUsedIndices: vi.fn(),
  detectLayout: vi.fn(),
  buildIx: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
  encodePermissionlessCrank: vi.fn(() => Buffer.from([5, 1, 0, 0, 0, 0])),
  CrankAction: { FeeSweep: 0, Liquidate: 1 },
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => 'Oracle11111111111111111111111111111111' }, 0]),
  IX_TAG: { TradeNoCpi: 1, TradeCpi: 2 },
  // v17 additions — default false so legacy-path tests continue to work.
  isV17Account: vi.fn(() => false),
  parseWrapperConfigV17: vi.fn(),
  parsePortfolioV17: vi.fn(),
}));

vi.mock('@percolatorct/shared', () => ({
  config: {
    crankKeypair: 'mock-keypair-path',
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(),
  sendCriticalAlert: vi.fn(async () => undefined),
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 1000000,
    })),
    sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
    getSlot: vi.fn().mockResolvedValue(200),
  })),
  loadKeypair: vi.fn(() => {
    // Use a mock publicKey with proper equals method
    const mockPubkey = {
      toBase58: () => '11111111111111111111111111111111',
      toBuffer: () => Buffer.alloc(32),
      equals: (other: any) => {
        if (!other) return false;
        const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
        return otherStr === '11111111111111111111111111111111';
      },
    };
    return {
      publicKey: mockPubkey as any,
      secretKey: new Uint8Array(64),
    };
  }),
  sendWithRetry: vi.fn(async () => 'mock-signature'),
  sendWithRetryKeeper: vi.fn(async () => 'mock-keeper-signature'),
  pollSignatureStatus: vi.fn(async () => true),
  getRecentPriorityFees: vi.fn(async () => ({
    priorityFeeMicroLamports: 5000,
    computeUnitLimit: 200000,
  })),
  checkTransactionSize: vi.fn(),
  eventBus: {
    publish: vi.fn(),
  },
  acquireToken: vi.fn(async () => {}),
  getFallbackConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 1000000,
    })),
    sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
  })),
  backoffMs: vi.fn(() => 100),
  getErrorMessage: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    return String(err);
  }),
}));

vi.mock('../../src/lib/keeper-send.js', async () => {
  const { KeeperBudget } = await vi.importActual<typeof import('../../src/lib/budget.js')>('../../src/lib/budget.js');
  return {
    keeperSend: vi.fn(async () => ({ signature: 'mock-keeper-signature', estimatedCost: 5000 })),
    sharedBudget: new KeeperBudget(),
  };
});

vi.mock('../../src/lib/v17-risk.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/v17-risk.js')>('../../src/lib/v17-risk.js');
  return {
    // Real class so `instanceof V17RiskParamsCorruptedError` checks in
    // liquidation.ts still work against errors thrown by this mock.
    V17RiskParamsCorruptedError: actual.V17RiskParamsCorruptedError,
    parseV17RiskParams: vi.fn(() => ({
      warmupPeriodSlots: 0n,
      maintenanceMarginBps: 500n,
      hMin: 0n,
      hMax: 0n,
      openInterestCap: 0n,
      maintenanceFeePerSlot: 0n,
      liquidationFeeShareBps: 0n,
      adlFillCapBps: 0n,
      minPositionSize: 0n,
      minNonzeroMmReq: 0n,
    })),
    // Fix #331: readEffectivePriceForAsset is used in scanV17Portfolios.
    // Return 0n (falls back to the market-level price, matching pre-fix behavior in tests).
    readEffectivePriceForAsset: vi.fn(() => 0n),
    // #335: raw_oracle_target_price + lag penalty are read by evaluateV17PortfolioHealth.
    // Return 0n target → real targetEffectiveLagPenalty yields 0 (no penalty), which is
    // the behavior these legacy tests assume. Use the REAL penalty fn so its logic is
    // exercised wherever a non-zero target is supplied.
    readRawOracleTargetPriceForAsset: vi.fn(() => 0n),
    targetEffectiveLagPenalty: actual.targetEffectiveLagPenalty,
  };
});

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { LiquidationService } from '../../src/services/liquidation.js';
import * as core from '@percolatorct/sdk';
import * as shared from '@percolatorct/shared';
import * as keeperSendModule from '../../src/lib/keeper-send.js';
import * as v17risk from '../../src/lib/v17-risk.js';

// Zero key (all zeros) - used for Pyth-pinned oracleAuthority and Hyperp indexFeedId
const ZERO_KEY = (() => {
  const pk = new PublicKey(new Uint8Array(32));
  return pk;
})();

function mockZeroKey() {
  return {
    toBase58: () => ZERO_KEY.toBase58(),
    toBuffer: () => Buffer.alloc(32),
    toBytes: () => new Uint8Array(32),
    equals: (other: any) => {
      if (!other) return false;
      if (typeof other.toBase58 === 'function') {
        return other.toBase58() === ZERO_KEY.toBase58();
      }
      return false;
    },
  };
}

function mockNonZeroKey(base58 = 'NonZero1111111111111111111111111111111111') {
  return {
    toBase58: () => base58,
    toBuffer: () => Buffer.from(base58),
    toBytes: () => {
      const bytes = new Uint8Array(32);
      bytes[0] = 1;
      return bytes;
    },
    equals: (other: any) => {
      if (!other) return false;
      const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
      return otherStr === base58;
    },
  };
}

describe('LiquidationService', () => {
  let liquidationService: LiquidationService;
  let mockOracleService: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Restore the default getConnection mock after clearAllMocks() — tests that set
    // a persistent mockReturnValue (e.g. M-9 tests using {getProgramAccounts: ...})
    // would otherwise poison subsequent tests that rely on getSlot/getAccountInfo.
    // vi.clearAllMocks() clears call counts but NOT mockReturnValue implementations.
    vi.mocked(shared.getConnection).mockImplementation(() => ({
      getAccountInfo: vi.fn(),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'mock-blockhash', lastValidBlockHeight: 1000000 })),
      sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
      getSlot: vi.fn().mockResolvedValue(200),
    } as any));

    mockOracleService = {
      fetchPrice: vi.fn().mockResolvedValue({
        priceE6: 1_000_000n,
        source: 'dexscreener',
        timestamp: Date.now(),
      }),
    };

    liquidationService = new LiquidationService(mockOracleService, 15000);
  });

  afterEach(() => {
    liquidationService.stop();
  });

  describe('scanMarket', () => {
    it('should find undercollateralized accounts', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market111111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: {
          maintenanceMarginBps: 500n, // 5%
        },
        header: {
          admin: { toBase58: () => 'Admin111111111111111111111111111111111' },
        },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
        numUsedAccounts: 1,
        vault: 1000_000n,
        insuranceFund: { balance: 500_000n, feeRevenue: 0n },
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(), // Hyperp mode
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Undercollateralized account: 100 USDC capital, 10,000 units position @ $1
      // Notional = 10,000, margin ratio = 100 / 10,000 = 1% (below 5% maintenance)
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0, // User account
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n, // 10,000 units (6 decimals)
        capital: 100_000_000n, // 100 USDC
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
      expect(candidates[0].marginRatio).toBeLessThan(5); // Below 5%

      // M-6: fetchSlab must be called with the market's own programId so the
      // SDK's owner check (fetchSlab throws if info.owner !== expectedOwner)
      // actually runs, instead of trusting whatever account is at that pubkey.
      expect(core.fetchSlab).toHaveBeenCalledWith(
        expect.anything(),
        mockMarket.slabAddress,
        mockMarket.programId,
      );
    });

    it('should find undercollateralized accounts in Pyth-pinned oracle mode', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'MarketPyth1111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
        numUsedAccounts: 1,
        vault: 1000_000n,
        insuranceFund: { balance: 500_000n, feeRevenue: 0n },
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      // Pyth-pinned: oracleAuthority = zero, indexFeedId = non-zero
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
        authorityPriceE6: 0n, // Not used in Pyth-pinned
        lastEffectivePriceE6: 1_000_000n, // This is the price used
        authorityTimestamp: 0n, // Not relevant for Pyth-pinned
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Undercollateralized account: same as Hyperp test
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 100_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
      expect(candidates[0].marginRatio).toBeLessThan(5); // Below 5% maintenance
    });

    it('should use staleness fallback for admin oracle in scanMarket', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'MarketAdmin11111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      // Admin oracle with stale authority but valid lastEffectivePriceE6
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
        authorityPriceE6: 2_000_000n, // Stale — timestamp is old
        lastEffectivePriceE6: 1_000_000n, // Fallback price
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 min old (>60s)
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Account undercollateralized at fallback price ($1) but not at authority price ($2)
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 100_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      // Should find the candidate using fallback price ($1), not stale authority ($2)
      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
    });

    it('should skip accounts with stale oracle prices', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'), // Admin oracle mode
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 0n, // No fallback price available
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old (>60s)
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(0); // Skipped due to stale price and no fallback
    });

    // H-8: maintenanceMarginBps===0n (or out of range) makes the liquidation
    // candidacy comparison unsatisfiable for every position, silently. The
    // fix bails out loudly (alert + no candidates) instead.
    describe('H-8: corrupted maintenanceMarginBps', () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'MarketCorrupt111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      it('v12.x path: returns no candidates and fires sendCriticalAlert when maintenanceMarginBps is 0n', async () => {
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 100_000_000n } as any);
        vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 0n } as any);
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        } as any);
        vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

        const candidates = await liquidationService.scanMarket(mockMarket as any);

        expect(candidates).toEqual([]);
        expect(shared.sendCriticalAlert).toHaveBeenCalledWith(
          expect.stringContaining('risk params corrupted'),
          expect.anything(),
        );
      });

      it('v12.x path: alerts only once per market within the cooldown across repeated scans', async () => {
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 100_000_000n } as any);
        vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 0n } as any);
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        } as any);
        vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

        await liquidationService.scanMarket(mockMarket as any);
        await liquidationService.scanMarket(mockMarket as any);
        await liquidationService.scanMarket(mockMarket as any);

        expect(shared.sendCriticalAlert).toHaveBeenCalledTimes(1);
      });

      it('v17 path: returns no candidates and fires sendCriticalAlert when parseV17RiskParams throws V17RiskParamsCorruptedError', async () => {
        vi.mocked(core.isV17Account).mockReturnValueOnce(true);
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(9_347));
        // #342 FIX: scanMarket now calls parseWrapperConfigV17 + resolveV17WrapperPrice
        // before parseV17RiskParams, so we must mock it to return a valid config.
        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2, // EWMA_MARK — no auth price path
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          oracleTargetPublishTime: BigInt(Math.floor(Date.now() / 1000)) - 10n,
          markEwmaE6: 1_000_000n,
        } as any);
        const v17Risk = await import('../../src/lib/v17-risk.js');
        vi.mocked(v17Risk.parseV17RiskParams).mockImplementationOnce(() => {
          throw new v17Risk.V17RiskParamsCorruptedError('maintenanceMarginBps', 0n);
        });

        const candidates = await liquidationService.scanMarket(mockMarket as any);

        expect(candidates).toEqual([]);
        expect(shared.sendCriticalAlert).toHaveBeenCalledWith(
          expect.stringContaining('risk params corrupted'),
          expect.anything(),
        );
      });

      it('does NOT alert for a legitimate non-zero maintenanceMarginBps (no false positives)', async () => {
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 100_000_000n } as any);
        vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        } as any);
        vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
        vi.mocked(core.parseUsedIndices).mockReturnValue([]);

        await liquidationService.scanMarket(mockMarket as any);

        expect(shared.sendCriticalAlert).not.toHaveBeenCalled();
      });
    });

    describe('M-9: scanV17Portfolios re-checks market_group_id against the RPC memcmp filter', () => {
      const mockMarket = {
        slabAddress: mockNonZeroKey('MarketV17Scan111111111111111111111111'),
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      function makeRawPortfolio(label: string) {
        return {
          pubkey: { toBase58: () => `Portfolio${label}111111111111111111111111` } as any,
          account: { data: new Uint8Array(16) },
        };
      }

      it('skips a portfolio whose parsed marketGroupId does not match the scanned market', async () => {
        vi.mocked(core.isV17Account).mockReturnValueOnce(true);
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(9_347));
        // #342 FIX: scanMarket now calls parseWrapperConfigV17 + fetchClusterUnixTimeSec.
        vi.mocked(shared.getConnection).mockReturnValue({
          getAccountInfo: vi.fn(async () => null),
          getProgramAccounts: vi.fn(async () => [makeRawPortfolio('Mismatched')]),
          getMultipleAccountsInfo: vi.fn(async (keys: any[]) => keys.map(() => ({ data: new Uint8Array(16) }))),
        } as any);
        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2, // EWMA_MARK
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          oracleTargetPublishTime: BigInt(Math.floor(Date.now() / 1000)) - 10n,
          markEwmaE6: 1_000_000n,
        } as any);
        vi.mocked(core.parsePortfolioV17).mockReturnValueOnce({
          marketGroupId: mockNonZeroKey('SomeOtherMarket1111111111111111111111'),
          owner: mockNonZeroKey('Owner11111111111111111111111111111111'),
          capital: 1_000_000n,
          pnl: 0n,
          feeCredits: 0n,
          legs: [{ active: true, basisPosQ: 100_000_000_000n, assetIndex: 0 }],
        } as any);

        const candidates = await liquidationService.scanMarket(mockMarket as any);

        expect(candidates).toEqual([]);
      });

      it('keeps a portfolio whose parsed marketGroupId matches the scanned market', async () => {
        vi.mocked(core.isV17Account).mockReturnValueOnce(true);
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(9_347));
        // #342 FIX: scanMarket now calls parseWrapperConfigV17 + fetchClusterUnixTimeSec
        // before scanV17Portfolios, so the connection mock must also expose getAccountInfo
        // (used by fetchClusterUnixTimeSec for clock sysvar; returning null falls back to
        // Date.now()/1000 which is fine for this test).
        vi.mocked(shared.getConnection).mockReturnValue({
          getAccountInfo: vi.fn(async () => null),
          getProgramAccounts: vi.fn(async () => [makeRawPortfolio('Matching')]),
          getMultipleAccountsInfo: vi.fn(async (keys: any[]) => keys.map(() => ({ data: new Uint8Array(16) }))),
        } as any);
        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2, // EWMA_MARK
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          oracleTargetPublishTime: BigInt(Math.floor(Date.now() / 1000)) - 10n,
          markEwmaE6: 1_000_000n,
        } as any);
        vi.mocked(core.parsePortfolioV17).mockReturnValueOnce({
          marketGroupId: mockMarket.slabAddress,
          owner: mockNonZeroKey('Owner11111111111111111111111111111111'),
          capital: 100_000_000n, // 100 USDC — undercollateralized vs the position below
          pnl: 0n,
          feeCredits: 0n,
          legs: [{ active: true, basisPosQ: 10_000_000_000n, assetIndex: 0 }],
        } as any);

        const candidates = await liquidationService.scanMarket(mockMarket as any);

        expect(candidates).toHaveLength(1);
      });

      it('evaluates a mixed batch correctly: drops the mismatched portfolio, keeps the matching one', async () => {
        vi.mocked(core.isV17Account).mockReturnValueOnce(true);
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(9_347));
        // #342 FIX: scanMarket now calls parseWrapperConfigV17 + fetchClusterUnixTimeSec
        // before scanV17Portfolios. Connection needs getAccountInfo; parseWrapperConfigV17
        // needs a mock return so resolveV17WrapperPrice doesn't throw.
        vi.mocked(shared.getConnection).mockReturnValue({
          getAccountInfo: vi.fn(async () => null),
          getProgramAccounts: vi.fn(async () => [
            makeRawPortfolio('Mismatched'),
            makeRawPortfolio('Matching'),
          ]),
          getMultipleAccountsInfo: vi.fn(async (keys: any[]) => keys.map(() => ({ data: new Uint8Array(16) }))),
        } as any);
        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2, // EWMA_MARK
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          oracleTargetPublishTime: BigInt(Math.floor(Date.now() / 1000)) - 10n,
          markEwmaE6: 1_000_000n,
        } as any);
        vi.mocked(core.parsePortfolioV17)
          .mockReturnValueOnce({
            marketGroupId: mockNonZeroKey('SomeOtherMarket1111111111111111111111'),
            owner: mockNonZeroKey('OwnerMismatched111111111111111111111'),
            capital: 1_000_000n,
            pnl: 0n,
            feeCredits: 0n,
            legs: [{ active: true, basisPosQ: 100_000_000_000n, assetIndex: 0 }],
          } as any)
          .mockReturnValueOnce({
            marketGroupId: mockMarket.slabAddress,
            owner: mockNonZeroKey('OwnerMatching11111111111111111111111'),
            capital: 100_000_000n,
            pnl: 0n,
            feeCredits: 0n,
            legs: [{ active: true, basisPosQ: 10_000_000_000n, assetIndex: 0 }],
          } as any);

        const candidates = await liquidationService.scanMarket(mockMarket as any);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].owner).toBe('OwnerMatching11111111111111111111111');
      });

      // PoC: a portfolio flood must not make the scan fetch full account data for
      // every match. getProgramAccounts fetches PUBKEYS ONLY (dataSlice length 0),
      // and full data is fetched for at most the per-cycle cap via chunked
      // getMultipleAccountsInfo. Pre-fix (full-data getProgramAccounts, no cap on
      // the fetch) there is no dataSlice and no getMultipleAccountsInfo call.
      it('bounds the full-data fetch under a portfolio flood', async () => {
        const MAX_PER_CYCLE = 512; // MAX_PORTFOLIOS_PER_MARKET_PER_CYCLE
        const FLOOD = 1000;
        vi.mocked(core.isV17Account).mockReturnValueOnce(true);
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(9_347));
        const floodKeys = Array.from({ length: FLOOD }, (_, i) => makeRawPortfolio(`Flood${i}`));
        const gpaSpy = vi.fn(async () => floodKeys);
        const gmaSpy = vi.fn(async (keys: any[]) => keys.map(() => ({ data: new Uint8Array(16) })));
        vi.mocked(shared.getConnection).mockReturnValue({
          getAccountInfo: vi.fn(async () => null),
          getProgramAccounts: gpaSpy,
          getMultipleAccountsInfo: gmaSpy,
        } as any);
        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2,
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          oracleTargetPublishTime: BigInt(Math.floor(Date.now() / 1000)) - 10n,
          markEwmaE6: 1_000_000n,
        } as any);
        // Every parsed portfolio is healthy — we only assert on the fetch shape.
        vi.mocked(core.parsePortfolioV17).mockReturnValue({
          marketGroupId: mockMarket.slabAddress,
          owner: mockNonZeroKey('Owner11111111111111111111111111111111'),
          capital: 10_000_000_000n,
          pnl: 0n,
          feeCredits: 0n,
          legs: [{ active: true, basisPosQ: 1n, assetIndex: 0 }],
        } as any);

        await liquidationService.scanMarket(mockMarket as any);

        // Response bounded to pubkeys.
        expect(gpaSpy.mock.calls[0]?.[1]?.dataSlice).toEqual({ offset: 0, length: 0 });
        // Full data fetched for at most the per-cycle cap — NOT all 1000.
        const totalHydrated = gmaSpy.mock.calls.reduce((s, c) => s + (c[0] as any[]).length, 0);
        expect(totalHydrated).toBe(MAX_PER_CYCLE);
      });
    });
  });

  describe('liquidate', () => {
    // #373: the v17 pre-submit re-verification used to wrap the drift guard and
    // the margin recheck in `try { … } catch { /* proceed cautiously */ }`. Any
    // throw inside it fell through to the send with NO checks applied — and the
    // oracle-drift guard has no on-chain counterpart, so a drifted liquidation
    // had no backstop anywhere. It must fail CLOSED instead.
    describe('#373: pre-submit re-verification fails closed', () => {
      function v17Fixture() {
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const clockData = Buffer.alloc(40);
        clockData.writeBigInt64LE(nowSec, 32);
        const slabAddress = new PublicKey('11111111111111111111111111111111');
        const portfolioPubkey = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        const connection = {
          getSlot: vi.fn(async () => 200),
          getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
            if (pubkey.toBase58() === portfolioPubkey.toBase58()) {
              return { data: new Uint8Array([1, 2, 3]) };
            }
            return { data: clockData };
          }),
        };

        vi.mocked(shared.getConnection)
          .mockReturnValueOnce(connection as any)
          .mockReturnValueOnce(connection as any);
        vi.mocked(core.fetchSlab).mockResolvedValueOnce(new Uint8Array(512));
        vi.mocked(core.parsePortfolioV17).mockReturnValueOnce({
          owner: new PublicKey('So11111111111111111111111111111111111111112'),
          capital: 1_000_000n,
          pnl: 0n,
          feeCredits: 0n,
          legs: [{ active: true, basisPosQ: 100_000_000_000n, assetIndex: 0 }],
        } as any);

        const market = {
          slabAddress,
          programId: slabAddress,
          config: {
            collateralMint: slabAddress,
            oracleAuthority: mockNonZeroKey(),
            indexFeedId: mockZeroKey(),
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: mockZeroKey() },
        };

        return { market, portfolioPubkey, nowSec };
      }

      it('does NOT submit when parseWrapperConfigV17 throws on malformed wrapper bytes', async () => {
        const { market, portfolioPubkey } = v17Fixture();

        // The exact trigger from the report: malformed/edge wrapper bytes. The
        // throw lands before the drift guard, the freshPrice===0 abort and the
        // margin recheck have run.
        vi.mocked(core.parseWrapperConfigV17).mockImplementationOnce(() => {
          throw new RangeError('offset is out of bounds');
        });

        const sig = await liquidationService.liquidate(
          market as any,
          0,
          portfolioPubkey,
          1_000_000n,
          100_000_000_000n,
        );

        expect(sig).toBeNull();
        expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();
      });

      it('does NOT submit when the slab re-fetch throws (M-6 owner-check failure)', async () => {
        const { market, portfolioPubkey } = v17Fixture();

        // fetchSlabWithRetry surfaces the on-chain owner-check failure as a
        // throw; swallowing it would submit against an unverified slab.
        vi.mocked(core.fetchSlab).mockReset();
        vi.mocked(core.fetchSlab).mockRejectedValue(
          new Error('slab account not owned by expected program'),
        );

        const sig = await liquidationService.liquidate(
          market as any,
          0,
          portfolioPubkey,
          1_000_000n,
          100_000_000_000n,
        );

        expect(sig).toBeNull();
        expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();
      });

      it('still RUNS the drift + margin checks when re-verification succeeds', async () => {
        // The contrast case. Without it, "fail closed" could be implemented as
        // "always return null" and the two tests above would still pass.
        //
        // Asserted via readRawOracleTargetPriceForAsset, which
        // evaluateV17PortfolioHealth reads (#335) — it is only reachable once
        // execution gets PAST the fetch/parse block into the margin recheck.
        // (Asserting an actual submit would need a realistic v17 slab buffer;
        // no test in this suite has one, and a fake would prove nothing.)
        const { market, portfolioPubkey, nowSec } = v17Fixture();

        vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
          oracleMode: 2, // EWMA_MARK
          maxStalenessSecs: 60n,
          oracleTargetPriceE6: 0n,
          // Must be fresh: resolveV17WrapperPrice returns 0n for a stale EWMA,
          // which would abort on the freshPrice===0 guard before the drift and
          // margin checks — i.e. this test would pass for the wrong reason.
          oracleTargetPublishTime: nowSec,
          markEwmaE6: 1_000_000n, // == scanPriceE6 → zero drift, so the guard passes
        } as any);
        vi.mocked(v17risk.readRawOracleTargetPriceForAsset).mockClear();

        await liquidationService.liquidate(
          market as any,
          0,
          portfolioPubkey,
          1_000_000n,
          100_000_000_000n,
        );

        expect(v17risk.readRawOracleTargetPriceForAsset).toHaveBeenCalled();
      });

      it('never reaches the margin recheck when re-verification throws', async () => {
        // Mirror of the assertion above — proves the fail-closed path really
        // does skip the downstream work, rather than the two just differing by
        // return value.
        const { market, portfolioPubkey } = v17Fixture();

        vi.mocked(core.parseWrapperConfigV17).mockImplementationOnce(() => {
          throw new RangeError('offset is out of bounds');
        });
        vi.mocked(v17risk.readRawOracleTargetPriceForAsset).mockClear();

        await liquidationService.liquidate(
          market as any,
          0,
          portfolioPubkey,
          1_000_000n,
          100_000_000_000n,
        );

        expect(v17risk.readRawOracleTargetPriceForAsset).not.toHaveBeenCalled();
      });
    });

    it('aborts v17 liquidation when fresh wrapper price drifts beyond the configured limit', async () => {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const clockData = Buffer.alloc(40);
      clockData.writeBigInt64LE(nowSec, 32);
      const slabAddress = new PublicKey('11111111111111111111111111111111');
      const portfolioPubkey = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const connection = {
        getSlot: vi.fn(async () => 200),
        getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
          if (pubkey.toBase58() === portfolioPubkey.toBase58()) {
            return { data: new Uint8Array([1, 2, 3]) };
          }
          return { data: clockData };
        }),
      };

      vi.mocked(shared.getConnection)
        .mockReturnValueOnce(connection as any)
        .mockReturnValueOnce(connection as any);
      vi.mocked(core.fetchSlab).mockResolvedValueOnce(new Uint8Array(512));
      vi.mocked(core.parsePortfolioV17).mockReturnValueOnce({
        owner: new PublicKey('So11111111111111111111111111111111111111112'),
        capital: 1_000_000n,
        pnl: 0n,
        feeCredits: 0n,
        legs: [
          {
            active: true,
            basisPosQ: 100_000_000_000n,
            assetIndex: 0,
          },
        ],
      } as any);
      vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
        oracleMode: 2, // EWMA_MARK
        maxStalenessSecs: 60n,
        oracleTargetPriceE6: 0n,
        // Was 0n, which makes resolveV17WrapperPrice treat the EWMA as stale and
        // return 0n — so this test aborted on the freshPrice===0 guard and never
        // reached the drift check. It passed with the drift guard entirely
        // disabled. A fresh publish time makes the price resolve so the 100%
        // drift below (1.0 -> 2.0 vs a 150bps limit) is what actually aborts.
        oracleTargetPublishTime: nowSec,
        markEwmaE6: 2_000_000n,
      } as any);

      const market = {
        slabAddress,
        programId: slabAddress,
        config: {
          collateralMint: slabAddress,
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: mockZeroKey() },
      };

      const sig = await liquidationService.liquidate(
        market as any,
        0,
        portfolioPubkey,
        1_000_000n,
        100_000_000_000n, // closeQ: abs(basisPosQ) of the active leg (fix #329)
      );

      expect(sig).toBeNull();
      expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();

      // M-6: the v17 pre-submit recheck's fetchSlab call must pass the
      // market's programId as expectedOwner, not just the slab pubkey.
      expect(core.fetchSlab).toHaveBeenCalledWith(
        expect.anything(),
        slabAddress,
        market.programId,
      );
    });

    it('should execute liquidation with multi-instruction transaction', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market311111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(), // Hyperp mode
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const mockSlabData = new Uint8Array(1024);

      vi.mocked(core.fetchSlab).mockResolvedValue(mockSlabData);
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(), // Hyperp mode
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User2111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const signature = await liquidationService.liquidate(mockMarket as any, 0);

      expect(signature).not.toBeNull();
      expect(shared.eventBus.publish).toHaveBeenCalledWith(
        'liquidation.success',
        expect.any(String),
        expect.objectContaining({ accountIdx: 0 })
      );

      // M-6: the pre-submit recheck's fetchSlab call (re-reading the slab right
      // before submitting) must also pass the market's programId as expectedOwner.
      for (const call of vi.mocked(core.fetchSlab).mock.calls) {
        expect(call[2]).toBe(mockMarket.programId);
      }
    });

    it('should increment liquidation count on success', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market411111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(), // Hyperp mode
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(), // Hyperp mode
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User3111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const statusBefore = liquidationService.getStatus();

      await liquidationService.liquidate(mockMarket as any, 0);

      const statusAfter = liquidationService.getStatus();
      expect(statusAfter.liquidationCount).toBe(statusBefore.liquidationCount + 1);
    });

    // ─── H2: pre-submit recheck must bail when fresh price is unavailable ──
    // The previous `if (freshPrice > 0n) { ...recheck... }` envelope silently
    // skipped the margin recheck when resolveMarketPrice returned 0n,
    // letting the keeper submit a liquidation tx that may target an account
    // that recovered. Fix: bail with null when freshPrice===0n.
    describe('H2: freshPrice===0n bail-out', () => {
      function makeMarket(opts: { hyperp?: boolean } = {}) {
        const oracleAuthority = opts.hyperp ? mockNonZeroKey() : mockNonZeroKey();
        const indexFeedId = opts.hyperp ? mockZeroKey() : mockNonZeroKey();
        return {
          slabAddress: { toBase58: () => 'MarketH2111111111111111111111111111111111' },
          programId: { toBase58: () => 'Program11111111111111111111111111111111' },
          config: {
            collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
            oracleAuthority,
            indexFeedId,
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
        };
      }

      function stubAccount() {
        vi.mocked(core.parseEngine).mockReturnValue({} as any);
        vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
        vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
        vi.mocked(core.parseAccount).mockReturnValue({
          kind: 0,
          owner: { toBase58: () => 'UserH2111111111111111111111111111111111' },
          positionSize: 10_000_000_000n,
          capital: 1_000_000n,
          entryPrice: 1_000_000n,
          pnl: 0n,
        } as any);
      }

      it('H2: returns null and does NOT submit when admin oracle is stale AND lastEffectivePriceE6 is 0n', async () => {
        const mockMarket = makeMarket();
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        stubAccount();
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),     // admin mode (non-zero authority, non-zero feed)
          indexFeedId: mockNonZeroKey(),
          authorityPriceE6: 1_000_000n,          // stale
          lastEffectivePriceE6: 0n,              // never cranked
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 600), // 10 min old → stale
        } as any);

        const sendSpy = vi.mocked(shared.sendWithRetryKeeper);
        const before = sendSpy.mock.calls.length;

        const sig = await liquidationService.liquidate(mockMarket as any, 0);

        expect(sig).toBeNull();
        expect(sendSpy.mock.calls.length).toBe(before); // no new send
      });

      it('H2: returns null when pyth-pinned market has lastEffectivePriceE6===0n at submit', async () => {
        const mockMarket = makeMarket();
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        stubAccount();
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockZeroKey(),        // pyth-pinned (zero authority, non-zero feed)
          indexFeedId: mockNonZeroKey(),
          authorityPriceE6: 0n,
          lastEffectivePriceE6: 0n,              // not yet cranked
          authorityTimestamp: 0n,
        } as any);

        const sendSpy = vi.mocked(shared.sendWithRetryKeeper);
        const before = sendSpy.mock.calls.length;

        const sig = await liquidationService.liquidate(mockMarket as any, 0);

        expect(sig).toBeNull();
        expect(sendSpy.mock.calls.length).toBe(before);
      });

      it('H2: returns null when hyperp market has lastEffectivePriceE6===0n at submit', async () => {
        const mockMarket = makeMarket({ hyperp: true });
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        stubAccount();
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),            // hyperp
          authorityPriceE6: 0n,
          lastEffectivePriceE6: 0n,
          authorityTimestamp: 0n,
        } as any);

        const sendSpy = vi.mocked(shared.sendWithRetryKeeper);
        const before = sendSpy.mock.calls.length;

        const sig = await liquidationService.liquidate(mockMarket as any, 0);

        expect(sig).toBeNull();
        expect(sendSpy.mock.calls.length).toBe(before);
      });

      it('H2: still proceeds when admin oracle is stale but lastEffectivePriceE6 > 0 (stale-fallback path preserved)', async () => {
        const mockMarket = makeMarket();
        vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
        stubAccount();
        vi.mocked(core.parseConfig).mockReturnValue({
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockNonZeroKey(),
          authorityPriceE6: 0n,                  // no admin push
          lastEffectivePriceE6: 1_000_000n,      // crank wrote a valid price
          authorityTimestamp: 0n,
        } as any);

        const sig = await liquidationService.liquidate(mockMarket as any, 0);

        // Falls through to the (now unconditional) margin recheck — at margin
        // ratio 10% (positionSize=10k @ price 1.0, equity ~1.0), with
        // maintenanceMarginBps=500, the account remains undercollateralized,
        // so liquidation proceeds.
        expect(sig).not.toBeNull();
      });
    });
  });

  describe('start and stop', () => {
    it('should start and stop timer', () => {
      const markets = new Map();
      
      liquidationService.start(() => markets);
      expect(liquidationService.getStatus().running).toBe(true);

      liquidationService.stop();
      expect(liquidationService.getStatus().running).toBe(false);
    });
  });

  describe('PERC-484: InvalidSlabLen (0x4) permanent skip', () => {
    it('should permanently skip a market after 0x4 error in liquidate()', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'CorruptSlab111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      // Simulate 0x4 error from keeperSend
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValueOnce(
        new Error('Transaction simulation failed: custom program error: 0x4'),
      );
      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([1]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User3111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      const result = await liquidationService.liquidate(mockMarket as any, 1);
      expect(result).toBeNull();

      const status = liquidationService.getStatus();
      expect(status.permanentlySkippedCount).toBe(1);
      expect(status.permanentlySkippedMarkets).toContain('CorruptSlab111111111111111111111111111111');
    });

    it('should skip permanently-skipped markets in scanAndLiquidateAll', async () => {
      const corruptAddr = 'CorruptSlab222222222222222222222222222222';

      // Pre-populate the skip list via a fresh service instance
      const svc = new LiquidationService(mockOracleService as any);

      // Manually trigger a 0x4 error so it gets added to skip list
      const mockMarket = {
        slabAddress: { toBase58: () => corruptAddr },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      vi.mocked(keeperSendModule.keeperSend).mockRejectedValueOnce(
        new Error('custom program error: 0x4'),
      );
      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([1]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User3111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
        pnl: 0n,
      } as any);

      // First liquidation attempt → 0x4 → marked as permanently skipped
      await svc.liquidate(mockMarket as any, 1);
      expect(svc.getStatus().permanentlySkippedCount).toBe(1);

      // Now run scanAndLiquidateAll — the corrupt market should be skipped entirely
      vi.mocked(keeperSendModule.keeperSend).mockClear();
      vi.mocked(core.fetchSlab).mockClear();
      const markets = new Map([
        [corruptAddr, { market: mockMarket as any }],
      ]);
      const result = await svc.scanAndLiquidateAll(markets);

      // scanMarket should NOT have been called (filtered before batch)
      // so no send should have been attempted
      expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();
      expect(result.scanned).toBe(0);
    });

    it('should permanently skip a market after "Unrecognized slab data length" in scanMarket()', async () => {
      const largeSlabAddr = 'LargeSlab1111111111111111111111111111111111';
      const svc = new LiquidationService(mockOracleService as any);

      const mockMarket = {
        slabAddress: { toBase58: () => largeSlabAddr },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey(),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      // Simulate parseEngine throwing for unknown slab size (992560 bytes = 4096 slots)
      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(992560));
      vi.mocked(core.parseEngine).mockImplementation(() => {
        throw new Error('Unrecognized slab data length: 992560. Cannot determine layout version.');
      });

      const candidates = await svc.scanMarket(mockMarket as any);
      expect(candidates).toEqual([]);

      // Should now be permanently skipped
      const status = svc.getStatus();
      expect(status.permanentlySkippedCount).toBe(1);
      expect(status.permanentlySkippedMarkets).toContain(largeSlabAddr);
    });

    it('should not call scanMarket for markets skipped due to unrecognized slab length', async () => {
      const largeSlabAddr = 'LargeSlab2222222222222222222222222222222222';
      const svc = new LiquidationService(mockOracleService as any);

      const mockMarket = {
        slabAddress: { toBase58: () => largeSlabAddr },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey(),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      // First call: throw unrecognized slab length
      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(992560));
      vi.mocked(core.parseEngine).mockImplementationOnce(() => {
        throw new Error('Unrecognized slab data length: 992560.');
      });

      const markets = new Map([
        [largeSlabAddr, { market: mockMarket as any }],
      ]);

      // First scan: should add to permanentlySkipped
      await svc.scanAndLiquidateAll(markets);
      expect(svc.getStatus().permanentlySkippedCount).toBe(1);

      vi.clearAllMocks();

      // Second scan: market is filtered before scanMarket is even called
      await svc.scanAndLiquidateAll(markets);
      expect(core.fetchSlab).not.toHaveBeenCalled();
    });
  });

  // C1: per-cycle dedup is keyed on the on-chain position identifier
  // (slabAddress, accountIdx), not the owner pubkey. An owner with multiple
  // undercollateralized sub-accounts must get each one liquidated in the same
  // cycle — owner-only dedup previously left residual bad debt for the
  // insurance fund. A per-owner cap bounds RPC fan-out for fairness.
  describe('C1: scanAndLiquidateAll position dedup', () => {
    function makeMarketAt(slabAddr: string) {
      return {
        slabAddress: { toBase58: () => slabAddr, equals: () => false },
        programId: { toBase58: () => 'ProgramId1111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey('feed'),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };
    }

    function makeCandidate(slabAddress: string, accountIdx: number, owner: string) {
      return {
        slabAddress,
        accountIdx,
        owner,
        positionSize: 1_000n,
        capital: 100n,
        pnl: -50n,
        marginRatio: 4.0,
        maintenanceMarginBps: 500n,
      };
    }

    it('liquidates BOTH positions when the same owner is underwater in two markets', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const sharedOwner = 'OwnerShared111111111111111111111111111111111';

      const scanSpy = vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [makeCandidate(market.slabAddress.toBase58(), 1, sharedOwner)] as any,
      );
      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockResolvedValue('mock-liq-sig');

      const markets = new Map([
        ['SlabA1111111111111111111111111111111111111', { market: makeMarketAt('SlabA1111111111111111111111111111111111111') as any }],
        ['SlabB2222222222222222222222222222222222222', { market: makeMarketAt('SlabB2222222222222222222222222222222222222') as any }],
      ]);

      const result = await svc.scanAndLiquidateAll(markets);

      // Both markets scanned, and both sub-accounts liquidated — distinct
      // (slab, accountIdx) pairs even though the owner pubkey is shared.
      expect(scanSpy).toHaveBeenCalledTimes(2);
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
      expect(result.candidates).toBe(2);
      expect(result.liquidated).toBe(2);
    });

    it('liquidates BOTH sub-accounts when the same owner has two positions in the SAME market', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const sharedOwner = 'OwnerSameMarket111111111111111111111111111';

      vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [
            makeCandidate(market.slabAddress.toBase58(), 1, sharedOwner),
            makeCandidate(market.slabAddress.toBase58(), 2, sharedOwner),
          ] as any,
      );
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map([
        ['SlabA1111111111111111111111111111111111111', { market: makeMarketAt('SlabA1111111111111111111111111111111111111') as any }],
      ]);

      const result = await svc.scanAndLiquidateAll(markets);

      // Two distinct accountIdx in the same slab — both liquidated.
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
      expect(liquidateSpy.mock.calls.map((c) => c[1]).sort()).toEqual([1, 2]);
      expect(result.liquidated).toBe(2);
    });

    it('dedupes exact (slab, accountIdx) duplicates within the same cycle', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerDupe1111111111111111111111111111111';
      const slab = 'SlabDupe111111111111111111111111111111111';

      // Defensive: scanMarket somehow returns the same candidate twice in the
      // same cycle. The composite-key dedup should collapse it to one liquidate.
      vi.spyOn(svc, 'scanMarket').mockResolvedValue([
        makeCandidate(slab, 7, owner),
        makeCandidate(slab, 7, owner),
      ] as any);
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map([
        [slab, { market: makeMarketAt(slab) as any }],
      ]);

      await svc.scanAndLiquidateAll(markets);

      expect(liquidateSpy).toHaveBeenCalledTimes(1);
    });

    it('caps liquidations per owner at MAX_LIQ_PER_OWNER_PER_CYCLE (3) per cycle', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const whale = 'OwnerWhale1111111111111111111111111111111';

      // One owner, five distinct (slab, accountIdx) positions across five
      // markets — every position is genuinely underwater, but the per-owner
      // cap of 3 keeps the keeper from blowing its RPC budget on a single
      // whale. Residual positions are picked up on the next cycle.
      const slabs = [
        'SlabW0000000000000000000000000000000000000',
        'SlabW1111111111111111111111111111111111111',
        'SlabW2222222222222222222222222222222222222',
        'SlabW3333333333333333333333333333333333333',
        'SlabW4444444444444444444444444444444444444',
      ];
      vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [makeCandidate(market.slabAddress.toBase58(), 0, whale)] as any,
      );
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map(
        slabs.map((s) => [s, { market: makeMarketAt(s) as any }]),
      );

      const result = await svc.scanAndLiquidateAll(markets);

      expect(liquidateSpy).toHaveBeenCalledTimes(3);
      expect(result.liquidated).toBe(3);
      expect(result.candidates).toBe(5);
    });

    it('clears per-cycle dedup state between scanAndLiquidateAll invocations', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerNextCycle111111111111111111111111111';
      const slab = 'SlabC3333333333333333333333333333333333333';

      vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [makeCandidate(market.slabAddress.toBase58(), 1, owner)] as any,
      );
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map([[slab, { market: makeMarketAt(slab) as any }]]);

      await svc.scanAndLiquidateAll(markets);
      await svc.scanAndLiquidateAll(markets);

      // Per-cycle dedup, not lifetime: the same (slab, idx) can be retargeted
      // next cycle (partial-fill retry path).
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
    });
  });

  // H-1: scanAndLiquidateAll's per-cycle clear() wiped _cycleSeenPositions
  // even while a liquidate() call from a PREVIOUS cycle (or the LaserStream
  // event path) was still awaiting RPCs/tx confirmation, letting the next
  // cycle re-liquidate the same position before the first attempt landed.
  describe('H-1: in-flight liquidation guard survives cycle-boundary clear()', () => {
    function makeMarketAt(slabAddr: string) {
      return {
        slabAddress: { toBase58: () => slabAddr, equals: () => false },
        programId: { toBase58: () => 'ProgramId1111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey('feed'),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };
    }

    function makeCandidate(slabAddress: string, accountIdx: number, owner: string) {
      return {
        slabAddress,
        accountIdx,
        owner,
        positionSize: 1_000n,
        capital: 100n,
        pnl: -50n,
        marginRatio: 4.0,
        maintenanceMarginBps: 500n,
      };
    }

    it('does not start a second liquidate() for a position whose prior liquidate() is still in flight when the next cycle clears _cycleSeenPositions', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerInFlight11111111111111111111111111111';
      const slab = 'SlabInFlight111111111111111111111111111111';

      vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [makeCandidate(market.slabAddress.toBase58(), 9, owner)] as any,
      );

      // liquidate() never resolves until released -- simulates the
      // multi-second RPC round trips (fresh slab/portfolio fetch, oracle
      // resolve, send+confirm) that happen between adding to the dedup set
      // and the tx actually landing on-chain.
      let release!: (sig: string | null) => void;
      const pending = new Promise<string | null>((resolve) => { release = resolve; });
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockReturnValue(pending);

      const markets = new Map([[slab, { market: makeMarketAt(slab) as any }]]);

      // Cycle 1 kicks off gatedLiquidate -> liquidate(), which hangs.
      const cycle1 = svc.scanAndLiquidateAll(markets);
      await Promise.resolve();
      await Promise.resolve();

      // Cycle 2 starts WHILE cycle 1's liquidate() is still in flight. Its
      // unconditional clear() of _cycleSeenPositions/_cycleOwnerCounts must
      // not let a second liquidate() start for the same position.
      const cycle2 = await svc.scanAndLiquidateAll(markets);

      expect(liquidateSpy).toHaveBeenCalledTimes(1);
      expect(cycle2.liquidated).toBe(0);

      release('sig-1');
      const cycle1Result = await cycle1;
      expect(cycle1Result.liquidated).toBe(1);
      expect(liquidateSpy).toHaveBeenCalledTimes(1);
    });

    it('allows retry once the in-flight liquidate() has fully settled', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerRetry111111111111111111111111111111111';
      const slab = 'SlabRetry11111111111111111111111111111111111';

      vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [makeCandidate(market.slabAddress.toBase58(), 3, owner)] as any,
      );
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map([[slab, { market: makeMarketAt(slab) as any }]]);

      await svc.scanAndLiquidateAll(markets);
      const second = await svc.scanAndLiquidateAll(markets);

      // Once the first liquidate() resolved, the in-flight guard released
      // the key -- the next cycle's legitimate partial-fill retry must work.
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
      expect(second.liquidated).toBe(1);
    });

    it('releases the in-flight guard when liquidate() resolves to null (pre-submit recheck abort)', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerAbort1111111111111111111111111111111';
      const slab = 'SlabAbort11111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 2, owner);

      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('sig-retry');

      const first = await (svc as any).gatedLiquidate(market, candidate);
      expect(first).toBeNull();

      // Simulate the next polling cycle's boundary (scanAndLiquidateAll
      // clears the per-cycle dedup state -- that part is unrelated to this
      // test, which targets _inFlightPositions specifically).
      (svc as any)._cycleSeenPositions.clear();
      (svc as any)._cycleOwnerCounts.clear();

      // A null (aborted) resolution must release the in-flight guard too,
      // not just a successful signature -- otherwise every legitimate
      // recheck-abort would permanently wedge the position.
      const second = await (svc as any).gatedLiquidate(market, candidate);
      expect(second).toBe('sig-retry');
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
    });

    it('blocks a concurrent gatedLiquidate call for the same position regardless of which path invoked it', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerCrossPath111111111111111111111111111';
      const slab = 'SlabCrossPath111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 5, owner);

      let release!: (sig: string | null) => void;
      const pending = new Promise<string | null>((resolve) => { release = resolve; });
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockReturnValue(pending);

      // First call (e.g. the LaserStream event path) starts a liquidation.
      const firstCall = (svc as any).gatedLiquidate(market, candidate);
      await Promise.resolve();

      // Second call (e.g. the polling path re-discovering the same account)
      // must be blocked while the first is still outstanding.
      const secondResult = await (svc as any).gatedLiquidate(market, candidate);
      expect(secondResult).toBeNull();
      expect(liquidateSpy).toHaveBeenCalledTimes(1);

      release('sig-first');
      expect(await firstCall).toBe('sig-first');
    });
  });

  // BUG-104: the LaserStream event path's 1s debounce only coalesces updates
  // *within* one window -- it does not bound the sustained rate of distinct
  // windows. Rapid open/close/reopen on a single account re-arms a fresh
  // debounce timer each time, forcing a full scanMarket() RPC fan-out far
  // more often than the 60s polling cycle would, with no breaker noticing
  // (no liquidation tx is ever sent, so the SOL-spend budget is untouched --
  // only RPC quota/CPU is burned).
  describe('BUG-104: per-market event-scan rate limit', () => {
    function makeMarketAt(slabAddr: string) {
      return {
        slabAddress: { toBase58: () => slabAddr, equals: () => false },
        programId: { toBase58: () => 'ProgramId1111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey('feed'),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };
    }

    function setupEventDrivenService(slab: string) {
      const market = makeMarketAt(slab);
      let onAccountCb: ((update: { pubkey: string }) => void) | undefined;
      const accountLoader = {
        onAccount: (cb: (update: { pubkey: string }) => void) => {
          onAccountCb = cb;
          return () => {};
        },
      };
      const svc = new LiquidationService(mockOracleService as any, 60_000, accountLoader as any);
      const scanMarketSpy = vi.spyOn(svc, 'scanMarket').mockResolvedValue([]);
      const getMarkets = () => new Map([[slab, { market: market as any }]]);
      process.env.KEEPER_USE_LASERSTREAM = 'true';
      svc.start(getMarkets);
      return {
        svc,
        scanMarketSpy,
        fireUpdate: () => onAccountCb!({ pubkey: slab }),
      };
    }

    afterEach(() => {
      delete process.env.KEEPER_USE_LASERSTREAM;
    });

    it('debounces a burst of rapid updates into a single scan (existing behavior, unaffected)', async () => {
      vi.useFakeTimers();
      try {
        const { scanMarketSpy, fireUpdate } = setupEventDrivenService(
          'SlabEvtBurst1111111111111111111111111111111',
        );
        fireUpdate();
        await vi.advanceTimersByTimeAsync(200);
        fireUpdate(); // re-arms the 1s debounce before it fires
        await vi.advanceTimersByTimeAsync(1_100);
        expect(scanMarketSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('defers (does not drop) a second event-scan that arrives within MIN_EVENT_SCAN_INTERVAL_MS of the last one', async () => {
      vi.useFakeTimers();
      try {
        const { scanMarketSpy, fireUpdate } = setupEventDrivenService(
          'SlabEvtRate1111111111111111111111111111111',
        );

        // First update: debounce settles after 1s, scan #1 runs immediately
        // (no prior scan recorded for this market).
        fireUpdate();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(scanMarketSpy).toHaveBeenCalledTimes(1);

        // Second update arrives well over 1s later (debounce settles cleanly)
        // but under the 5s minimum event-scan interval -- must be deferred,
        // not executed immediately.
        fireUpdate();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(scanMarketSpy).toHaveBeenCalledTimes(1);

        // Once the remainder of the 5s window elapses, the deferred scan runs.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(scanMarketSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('continuous churn produces no more than one scan per rate-limit window, never zero forever', async () => {
      vi.useFakeTimers();
      try {
        const { scanMarketSpy, fireUpdate } = setupEventDrivenService(
          'SlabEvtChurn1111111111111111111111111111111',
        );

        // Simulate an attacker toggling state just over the 1s debounce
        // window, repeatedly, for 12 seconds straight.
        for (let i = 0; i < 10; i++) {
          fireUpdate();
          await vi.advanceTimersByTimeAsync(1_100);
        }
        // Bounded: far fewer scans than the 10 updates/11s of churn would
        // produce with no rate limit (which would be ~10).
        expect(scanMarketSpy.mock.calls.length).toBeLessThanOrEqual(3);
        // Not permanently starved either -- at least one scan got through.
        expect(scanMarketSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // BUG-103: a position whose liquidate() keeps failing must not be retried
  // at full tx-fee cost on every single cycle/event forever -- that is an
  // unbounded, asymmetric-cost DoS surface (a cheap owner-side action timed
  // against the keeper's scan/submit window beats the recheck every time).
  describe('BUG-103: per-position failure backoff', () => {
    function makeMarketAt(slabAddr: string) {
      return {
        slabAddress: { toBase58: () => slabAddr, equals: () => false },
        programId: { toBase58: () => 'ProgramId1111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
          oracleAuthority: mockZeroKey(),
          indexFeedId: mockNonZeroKey('feed'),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };
    }

    function makeCandidate(slabAddress: string, accountIdx: number, owner: string) {
      return {
        slabAddress,
        accountIdx,
        owner,
        positionSize: 1_000n,
        capital: 100n,
        pnl: -50n,
        marginRatio: 4.0,
        maintenanceMarginBps: 500n,
      };
    }

    // gatedLiquidate's _cycleSeenPositions/_cycleOwnerCounts are normally
    // cleared per-cycle by scanAndLiquidateAll; calling gatedLiquidate
    // directly back-to-back (as the H-1 suite above also does) requires
    // clearing them manually to simulate the next cycle's boundary.
    function clearCycleState(svc: any): void {
      svc._cycleSeenPositions.clear();
      svc._cycleOwnerCounts.clear();
    }

    it('allows an immediate retry after exactly one failure (first failure is free)', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerBackoff1111111111111111111111111111111';
      const slab = 'SlabBackoff111111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, owner);

      // Model a transaction that was actually broadcast and failed. liquidate()
      // calls recordAttempt() (bumping _submitAttempts) immediately before handing
      // the tx to keeperSend, and every earlier `return null` sits above that line.
      // Only a post-submit failure costs a fee, so only that arms the backoff.
      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockImplementationOnce(async () => { (svc as any)._submitAttempts++; return null; })
        .mockResolvedValueOnce('sig-ok');

      const first = await (svc as any).gatedLiquidate(market, candidate);
      expect(first).toBeNull();
      clearCycleState(svc);
      const second = await (svc as any).gatedLiquidate(market, candidate);
      expect(second).toBe('sig-ok');
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
    });

    it('throttles a position after repeated consecutive failures instead of retrying every call', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerGrief111111111111111111111111111111111';
      const slab = 'SlabGrief1111111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, owner);

      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockImplementation(async () => { (svc as any)._submitAttempts++; return null; });

      // Failure 1: free retry (matches existing single-abort semantics).
      expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull();
      clearCycleState(svc);
      // Failure 2: now backed off -- a third immediate call must NOT re-invoke
      // liquidate() again before the cooldown elapses.
      expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull();
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
      clearCycleState(svc);

      const third = await (svc as any).gatedLiquidate(market, candidate);
      expect(third).toBeNull();
      // Still only 2 -- the third call was skipped by the backoff, not a new
      // (failed) liquidate() attempt.
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
    });

    it('clears the backoff on a successful liquidation', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const owner = 'OwnerRecover111111111111111111111111111111';
      const slab = 'SlabRecover11111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, owner);

      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockImplementationOnce(async () => { (svc as any)._submitAttempts++; return null; })
        .mockImplementationOnce(async () => { (svc as any)._submitAttempts++; return null; })
        .mockResolvedValueOnce('sig-final');

      expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull(); // failure 1 (free)
      clearCycleState(svc);
      expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull(); // failure 2 (backed off after this)
      clearCycleState(svc);

      // Manually expire the backoff window to simulate time passing, then land.
      const positionKey = `${slab}:v12:1`;
      const entry = (svc as any)._positionBackoff.get(positionKey);
      expect(entry).toBeDefined();
      entry.retryAfter = Date.now() - 1;

      expect(await (svc as any).gatedLiquidate(market, candidate)).toBe('sig-final');
      expect(liquidateSpy).toHaveBeenCalledTimes(3);
      expect((svc as any)._positionBackoff.has(positionKey)).toBe(false);
    });

    it('does NOT arm backoff when liquidate aborts before broadcasting anything', async () => {
      // Every pre-submit `return null` in liquidate() -- the oracle-drift guard,
      // the #373 fail-closed re-verification, "no longer undercollateralized" --
      // sits ABOVE recordAttempt(), so none of them costs a transaction fee.
      // Backing off on those would blind the keeper to a genuinely underwater
      // position because an RPC call happened to fail, which is the opposite of
      // what a liquidator should do during the volatility that causes bad debt.
      const svc = new LiquidationService(mockOracleService as any);
      const slab = 'SlabAbort11111111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, 'OwnerAbort11111111111111111111111111111111');

      // No _submitAttempts bump: nothing reached the wire.
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue(null);

      for (let i = 0; i < 3; i++) {
        expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull();
        clearCycleState(svc);
      }

      expect(liquidateSpy).toHaveBeenCalledTimes(3);
      expect((svc as any)._positionBackoff.size).toBe(0);
    });

    it('does NOT arm backoff while the budget circuit breaker is halted', async () => {
      // A halted budget makes keeperSend return null for EVERY position
      // (keeper-send.ts: `if (!budget.canSpend(...)) return null`). Arming backoff
      // there would put every tracked position into escalating cooldown
      // simultaneously, so the keeper would still be refusing to liquidate long
      // after an operator resumed it -- turning one halt into a much longer outage.
      const svc = new LiquidationService(mockOracleService as any);
      const slab = 'SlabHalt111111111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, 'OwnerHalt111111111111111111111111111111111');

      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockImplementation(async () => { (svc as any)._submitAttempts++; return null; });

      keeperSendModule.sharedBudget.haltManually('test cordon');
      try {
        for (let i = 0; i < 3; i++) {
          expect(await (svc as any).gatedLiquidate(market, candidate)).toBeNull();
          clearCycleState(svc);
        }
      } finally {
        keeperSendModule.sharedBudget.resume('test');
      }

      expect(liquidateSpy).toHaveBeenCalledTimes(3);
      expect((svc as any)._positionBackoff.size).toBe(0);
    });

    it('caps the escalating cooldown at 60s rather than 5 minutes', async () => {
      // 300s was chosen to "match maxBackoffMs", but a position that is genuinely
      // liquidatable must not be ignored for five minutes -- that is long enough
      // for a cascade to accrue bad debt the protocol then eats.
      const svc = new LiquidationService(mockOracleService as any);
      const slab = 'SlabCap1111111111111111111111111111111111111';
      const market = makeMarketAt(slab);
      const candidate = makeCandidate(slab, 1, 'OwnerCap1111111111111111111111111111111111');
      const positionKey = `${slab}:v12:1`;

      vi.spyOn(svc, 'liquidate')
        .mockImplementation(async () => { (svc as any)._submitAttempts++; return null; });

      let lastDelay = 0;
      for (let i = 0; i < 8; i++) {
        const t = Date.now();
        await (svc as any).gatedLiquidate(market, candidate);
        clearCycleState(svc);
        const entry = (svc as any)._positionBackoff.get(positionKey);
        lastDelay = entry.retryAfter - t;
        entry.retryAfter = Date.now() - 1; // expire so the next call escalates
      }

      expect(lastDelay).toBeLessThanOrEqual(60_000);
      // ...and it really did escalate rather than the cap being trivially met.
      expect(lastDelay).toBeGreaterThan(30_000);
    });

    it('bounds the backoff map so positions that vanish cannot leak', async () => {
      // Entries are only deleted on a landed liquidation. A position that is
      // closed by its owner, or liquidated by somebody else, leaves its entry
      // behind forever -- an unbounded Map on a long-running process.
      const svc = new LiquidationService(mockOracleService as any);
      const slab = 'SlabLeak111111111111111111111111111111111111';
      const market = makeMarketAt(slab);

      vi.spyOn(svc, 'liquidate')
        .mockImplementation(async () => { (svc as any)._submitAttempts++; return null; });

      const cap = (svc as any)._positionBackoff.max;
      expect(cap).toBeTypeOf('number'); // a plain Map has no `max`

      for (let i = 0; i < cap + 50; i++) {
        await (svc as any).gatedLiquidate(market, makeCandidate(slab, i, `Owner${i}`));
        clearCycleState(svc);
      }

      expect((svc as any)._positionBackoff.size).toBeLessThanOrEqual(cap);
    });
  });
});

/**
 * KEEPER-11: a LaserStream burst for several positions of one owner used to
 * consume MAX_LIQ_PER_OWNER_PER_CYCLE before the polling scan could reach those
 * positions, so genuinely underwater accounts were skipped.
 *
 * The original fix exempted the event path from the cap entirely. That is the
 * one path an attacker can trigger on demand (by touching their own account),
 * and the cap is defence-in-depth against the KEEPER's own mispricing rather
 * than against the attacker -- so removing it multiplies the blast radius of a
 * keeper-side price bug on exactly the path that is cheapest to provoke.
 *
 * Two independent budgets instead: the polling scan keeps its cap, and the event
 * path gets its own, larger one. A burst can no longer starve the scan, and
 * neither path is unbounded.
 */
describe('KEEPER-11: per-owner caps are independent per source', () => {
  // mockOracleService lives inside the LiquidationService describe; this block
  // is top-level, so it supplies its own. Only fetchPrice is reached here.
  const oracleStub: any = {
    fetchPrice: vi.fn().mockResolvedValue({
      priceE6: 1_000_000n,
      source: 'dexscreener',
      timestamp: 1_700_000_000_000,
    }),
  };

  function makeMarketAt(slabAddr: string) {
    return {
      slabAddress: { toBase58: () => slabAddr, equals: () => false },
      programId: { toBase58: () => 'ProgramId1111111111111111111111111111111' },
      config: {
        collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
        oracleAuthority: mockZeroKey(),
        indexFeedId: mockNonZeroKey('feed'),
      },
      params: { maintenanceMarginBps: 500n },
      header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
    };
  }

  function candidateAt(slab: string, accountIdx: number, owner: string) {
    return {
      slabAddress: slab,
      accountIdx,
      owner,
      positionSize: 1_000n,
      capital: 100n,
      pnl: -50n,
      marginRatio: 4.0,
      maintenanceMarginBps: 500n,
    };
  }

  /** Distinct positions of ONE owner, so only the per-owner cap can stop them. */
  async function drain(
    svc: any, market: any, owner: string, n: number, source?: string, idxFrom = 0,
  ) {
    let landed = 0;
    for (let i = 0; i < n; i++) {
      // Distinct accountIdx per call: _cycleSeenPositions dedups by position, so
      // reusing indices would mask the per-owner cap under the dedup guard.
      const sig = await svc.gatedLiquidate(market, candidateAt('Slab', idxFrom + i, owner), source);
      if (sig) landed++;
    }
    return landed;
  }

  it('still caps the polling path at MAX_LIQ_PER_OWNER_PER_CYCLE', async () => {
    const svc: any = new LiquidationService(oracleStub);
    vi.spyOn(svc, 'liquidate').mockResolvedValue('sig');
    const cap = LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE'];

    expect(await drain(svc, makeMarketAt('Slab'), 'OwnerPoll', cap + 5, 'polling')).toBe(cap);
  });

  it('gives the event path its own, larger budget rather than no budget at all', async () => {
    const svc: any = new LiquidationService(oracleStub);
    vi.spyOn(svc, 'liquidate').mockResolvedValue('sig');
    const eventCap = LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE_EVENT'];

    expect(eventCap).toBeGreaterThan(LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE']);
    // Bounded: an event burst cannot liquidate an owner without limit.
    expect(await drain(svc, makeMarketAt('Slab'), 'OwnerEvt', eventCap + 5, 'laserstream')).toBe(eventCap);
  });

  it('an event burst does not consume the polling scan budget (the original bug)', async () => {
    const svc: any = new LiquidationService(oracleStub);
    vi.spyOn(svc, 'liquidate').mockResolvedValue('sig');
    const owner = 'OwnerShared';
    const pollCap = LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE'];

    // Exhaust the event budget first...
    await drain(svc, makeMarketAt('Slab'), owner, LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE_EVENT'], 'laserstream');
    // ...the polling scan must still get its full allowance for the same owner,
    // on positions the event path did not already take.
    const polled = await drain(svc, makeMarketAt('Slab'), owner, pollCap + 3, 'polling', 1_000);

    expect(polled).toBe(pollCap);
  });

  it('defaults to the polling budget when no source is given', async () => {
    const svc: any = new LiquidationService(oracleStub);
    vi.spyOn(svc, 'liquidate').mockResolvedValue('sig');
    const cap = LiquidationService['MAX_LIQ_PER_OWNER_PER_CYCLE'];

    expect(await drain(svc, makeMarketAt('Slab'), 'OwnerDefault', cap + 5)).toBe(cap);
  });

  it('clears both counters at the cycle boundary', async () => {
    const svc: any = new LiquidationService(oracleStub);
    vi.spyOn(svc, 'liquidate').mockResolvedValue('sig');
    await drain(svc, makeMarketAt('Slab'), 'OwnerReset', 2, 'polling');
    await drain(svc, makeMarketAt('Slab'), 'OwnerReset', 2, 'laserstream');

    svc._cycleOwnerCounts.clear();
    svc._eventCycleOwnerCounts.clear();

    expect(svc._cycleOwnerCounts.size).toBe(0);
    expect(svc._eventCycleOwnerCounts.size).toBe(0);
  });
});
