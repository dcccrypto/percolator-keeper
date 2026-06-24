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
vi.mock('@percolatorct/sdk', () => ({
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
  };
});

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { LiquidationService } from '../../src/services/liquidation.js';
import * as core from '@percolatorct/sdk';
import * as shared from '@percolatorct/shared';
import * as keeperSendModule from '../../src/lib/keeper-send.js';

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
        vi.mocked(shared.getConnection).mockReturnValue({
          getProgramAccounts: vi.fn(async () => [makeRawPortfolio('Mismatched')]),
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
        vi.mocked(shared.getConnection).mockReturnValue({
          getProgramAccounts: vi.fn(async () => [makeRawPortfolio('Matching')]),
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
        vi.mocked(shared.getConnection).mockReturnValue({
          getProgramAccounts: vi.fn(async () => [
            makeRawPortfolio('Mismatched'),
            makeRawPortfolio('Matching'),
          ]),
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
    });
  });

  describe('liquidate', () => {
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
        oracleTargetPublishTime: 0n,
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
});
