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
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({ keys: [], programId: { toBase58: () => '11111111111111111111111111111111' }, data: Buffer.from([]) })),
  encodeLiquidateAtOracle: vi.fn(() => Buffer.from([1])),
  encodeKeeperCrank: vi.fn(() => Buffer.from([2])),
  encodePushOraclePrice: vi.fn(() => Buffer.from([3])),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => 'Oracle11111111111111111111111111111111' }, 0]),
  ACCOUNTS_LIQUIDATE_AT_ORACLE: {},
  ACCOUNTS_KEEPER_CRANK: {},
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
  IX_TAG: { TradeNoCpi: 1, TradeCpi: 2 },
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
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 1000000,
    })),
    sendRawTransaction: vi.fn(async () => 'mock-tx-signature'),
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
  });

  describe('liquidate', () => {
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

  // A.14 (MED): per-cycle owner dedup — same underwater owner across N markets
  // produces ONE liquidate call per cycle, not N. The set resets between
  // cycles so a residual undercollateralization can be retargeted next time.
  describe('A.14: scanAndLiquidateAll owner dedup', () => {
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

    it('liquidates the same owner ONCE when present in two markets in the same cycle', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const sharedOwner = 'OwnerShared111111111111111111111111111111111';

      // Stub scanMarket directly so we can return identical candidates for
      // both markets without wrestling with parser mocks.
      const scanSpy = vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [
            {
              slabAddress: market.slabAddress.toBase58(),
              accountIdx: 1,
              owner: sharedOwner,
              positionSize: 1_000n,
              capital: 100n,
              pnl: -50n,
              marginRatio: 4.0,
              maintenanceMarginBps: 500n,
            },
          ] as any,
      );

      // Stub liquidate so it just counts calls without exercising the send path.
      const liquidateSpy = vi
        .spyOn(svc, 'liquidate')
        .mockResolvedValue('mock-liq-sig');

      const markets = new Map([
        ['SlabA1111111111111111111111111111111111111', { market: makeMarketAt('SlabA1111111111111111111111111111111111111') as any }],
        ['SlabB2222222222222222222222222222222222222', { market: makeMarketAt('SlabB2222222222222222222222222222222222222') as any }],
      ]);

      const result = await svc.scanAndLiquidateAll(markets);

      // Both markets scanned…
      expect(scanSpy).toHaveBeenCalledTimes(2);
      // …but liquidate fired only once thanks to the dedup set.
      expect(liquidateSpy).toHaveBeenCalledTimes(1);
      expect(result.candidates).toBe(2);
      expect(result.liquidated).toBe(1);
    });

    it('permits the same owner to be liquidated again on the NEXT cycle', async () => {
      const svc = new LiquidationService(mockOracleService as any);
      const sharedOwner = 'OwnerShared222222222222222222222222222222222';

      const scanSpy = vi.spyOn(svc, 'scanMarket').mockImplementation(
        async (market: any) =>
          [
            {
              slabAddress: market.slabAddress.toBase58(),
              accountIdx: 1,
              owner: sharedOwner,
              positionSize: 1_000n,
              capital: 100n,
              pnl: -50n,
              marginRatio: 4.0,
              maintenanceMarginBps: 500n,
            },
          ] as any,
      );
      const liquidateSpy = vi.spyOn(svc, 'liquidate').mockResolvedValue('mock-liq-sig');

      const markets = new Map([
        ['SlabC3333333333333333333333333333333333333', { market: makeMarketAt('SlabC3333333333333333333333333333333333333') as any }],
      ]);

      await svc.scanAndLiquidateAll(markets);
      await svc.scanAndLiquidateAll(markets);

      // Two cycles, two liquidates — the dedup set is per-cycle, not lifetime.
      expect(liquidateSpy).toHaveBeenCalledTimes(2);
      // sanity: scanMarket also called twice (once per cycle)
      expect(scanSpy).toHaveBeenCalledTimes(2);
    });
  });
});
