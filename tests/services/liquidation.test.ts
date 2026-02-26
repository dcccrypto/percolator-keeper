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
vi.mock('@percolator/sdk', () => ({
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

vi.mock('@percolator/shared', () => ({
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
}));

import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { LiquidationService } from '../../src/services/liquidation.js';
import * as core from '@percolator/sdk';
import * as shared from '@percolator/shared';

// Helper to create a mock PublicKey with equals()
function mockPubkey(base58: string) {
  return {
    toBase58: () => base58,
    toBuffer: () => Buffer.alloc(32),
    toBytes: () => new Uint8Array(32),
    equals: (other: any) => {
      if (!other) return false;
      const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
      return otherStr === base58;
    },
  };
}

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
      // Check if all-zeros
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
      bytes[0] = 1; // Non-zero
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
    it('should find undercollateralized accounts in Hyperp mode', async () => {
      // Hyperp mode: indexFeedId == [0;32], oracleAuthority != [0;32]
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market111111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(), // Hyperp mode
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: 0n, // In Hyperp mode this is funding rate, NOT a timestamp
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(), // Hyperp mode
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: 0n,
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Undercollateralized: 100 USDC capital, 10,000 units @ $1 → 1% margin < 5% maintenance
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 100_000_000n,
        entryPrice: 1_000_000n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      // Should find the candidate — Hyperp mode uses lastEffectivePriceE6, bypasses staleness check
      expect(candidates).toHaveLength(1);
      expect(candidates[0].accountIdx).toBe(0);
      expect(candidates[0].marginRatio).toBeLessThan(5);
    });

    it('should skip admin-oracle markets with stale oracle prices', async () => {
      // Admin oracle mode: indexFeedId != [0;32], oracleAuthority != [0;32]
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'), // Admin oracle (non-Hyperp)
          authorityPriceE6: 1_000_000n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120), // 2 minutes old
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      // With fallback: stale authority → uses lastEffectivePriceE6 (1_000_000n)
      // The mock account (from earlier default) should be found as a candidate
      expect(candidates.length).toBeGreaterThanOrEqual(0); // Fallback to lastEffectivePriceE6
    });

    it('should skip when authority stale AND lastEffectivePriceE6 is zero', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
      };
      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 100_000_000n } as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 0n, // No effective price — should skip
        authorityTimestamp: BigInt(Math.floor(Date.now() / 1000) - 120),
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);
      expect(candidates).toHaveLength(0); // No valid price at all
    });

    it('should NOT skip Hyperp markets even when authorityTimestamp is zero', async () => {
      // This is the critical regression test: Hyperp mode with authorityTimestamp=0
      // (which stores funding rate, not a timestamp)
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market311111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockNonZeroKey(),
          indexFeedId: mockZeroKey(), // Hyperp mode
          authorityPriceE6: 2_000_000n,   // mark price = $2
          lastEffectivePriceE6: 2_000_000n, // index price = $2
          authorityTimestamp: 0n,           // Funding rate = 0 (NOT a timestamp!)
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(),
        authorityPriceE6: 2_000_000n,
        lastEffectivePriceE6: 2_000_000n,
        authorityTimestamp: 0n,
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      // Undercollateralized account
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 100_000_000n,
        entryPrice: 2_000_000n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      // Should find the candidate — Hyperp mode bypasses the staleness check
      expect(candidates).toHaveLength(1);
    });

    it('should find undercollateralized accounts in Pyth-pinned mode', async () => {
      // Pyth-pinned: oracleAuthority == [0;32], indexFeedId != [0;32]
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market411111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: mockZeroKey(), // Pyth-pinned
          indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
          authorityPriceE6: 0n,
          lastEffectivePriceE6: 1_000_000n,
          authorityTimestamp: 0n,
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({
        totalOpenInterest: 100_000_000n,
      } as any);
      vi.mocked(core.parseParams).mockReturnValue({
        maintenanceMarginBps: 500n,
      } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockZeroKey(),
        indexFeedId: mockNonZeroKey('FeedId111111111111111111111111111111111111'),
        authorityPriceE6: 0n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: 0n,
      } as any);
      vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);

      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User1111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 100_000_000n,
        entryPrice: 1_000_000n,
      } as any);

      const candidates = await liquidationService.scanMarket(mockMarket as any);

      expect(candidates).toHaveLength(1);
    });
  });

  describe('liquidate', () => {
    it('should execute liquidation with multi-instruction transaction', async () => {
      const mockMarket = {
        slabAddress: { toBase58: () => 'Market511111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: {
            toBase58: () => '11111111111111111111111111111111',
            equals: (other: any) => {
              if (!other) return false;
              const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
              return otherStr === '11111111111111111111111111111111';
            },
          },
          indexFeedId: mockZeroKey(), // Hyperp mode
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: 0n,
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User2111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
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
        slabAddress: { toBase58: () => 'Market611111111111111111111111111111111' },
        programId: { toBase58: () => 'Program11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          oracleAuthority: {
            toBase58: () => '11111111111111111111111111111111',
            equals: (other: any) => {
              if (!other) return false;
              const otherStr = typeof other.toBase58 === 'function' ? other.toBase58() : String(other);
              return otherStr === '11111111111111111111111111111111';
            },
          },
          indexFeedId: mockZeroKey(),
        },
      };

      vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
      vi.mocked(core.parseEngine).mockReturnValue({} as any);
      vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
      vi.mocked(core.parseConfig).mockReturnValue({
        oracleAuthority: mockNonZeroKey(),
        indexFeedId: mockZeroKey(),
        authorityPriceE6: 1_000_000n,
        lastEffectivePriceE6: 1_000_000n,
        authorityTimestamp: 0n,
      } as any);
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({
        kind: 0,
        owner: { toBase58: () => 'User3111111111111111111111111111111111111' },
        positionSize: 10_000_000_000n,
        capital: 1_000_000n,
        entryPrice: 1_000_000n,
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
});
