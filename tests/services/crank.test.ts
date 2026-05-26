import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @solana/web3.js first, before importing it
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual('@solana/web3.js');
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => 'SysvarC1ock11111111111111111111111111111111',
      equals: () => false,
    },
  };
});

// Mock all external dependencies
vi.mock('@percolatorct/sdk', () => ({
  discoverMarkets: vi.fn(),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1, 2, 3])),
  encodeUpdateHyperpMark: vi.fn(() => Buffer.from([7, 8, 9])),
  encodePushOraclePrice: vi.fn(() => Buffer.from([4, 5, 6])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => '11111111111111111111111111111111' }, 0]),
  detectDexType: vi.fn(() => 'raydium-clmm'),
  parseDexPool: vi.fn(),
  ACCOUNTS_KEEPER_CRANK: {},
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock('@percolatorct/shared', () => ({
  config: {
    crankIntervalMs: 30000,
    crankInactiveIntervalMs: 120000,
    discoveryIntervalMs: 300000,
    allProgramIds: ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    crankKeypair: 'mock-keypair-path',
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({
    getAccountInfo: vi.fn(),
  })),
  getFallbackConnection: vi.fn(() => ({
    getProgramAccounts: vi.fn(),
  })),
  loadKeypair: vi.fn(() => ({
    publicKey: {
      toBase58: () => '11111111111111111111111111111111',
      // Use string-based equality so foreign oracle authorities correctly return false.
      equals: (other: any) => other?.toBase58?.() === '11111111111111111111111111111111',
    },
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => 'mock-signature-' + Date.now()),
  sendWithRetryKeeper: vi.fn(async () => 'mock-keeper-sig-' + Date.now()),
  rateLimitedCall: vi.fn((fn) => fn()),
  sendCriticalAlert: vi.fn(),
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(() => ({ data: [], error: null })),
      })),
    })),
  })),
  eventBus: {
    publish: vi.fn(),
  },
}));

vi.mock('../../src/lib/keeper-send.js', async () => {
  const { KeeperBudget } = await vi.importActual<typeof import('../../src/lib/budget.js')>('../../src/lib/budget.js');
  return {
    keeperSend: vi.fn(async () => ({ signature: 'mock-keeper-sig-' + Date.now(), estimatedCost: 5000 })),
    sharedBudget: new KeeperBudget(),
  };
});

import { PublicKey } from '@solana/web3.js';
import { CrankService } from '../../src/services/crank.js';
import * as core from '@percolatorct/sdk';
import * as shared from '@percolatorct/shared';
import * as keeperSendModule from '../../src/lib/keeper-send.js';

describe('CrankService', () => {
  let crankService: CrankService;
  let mockOracleService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockOracleService = {
      pushPrice: vi.fn().mockResolvedValue(true),
      recordPushTime: vi.fn(),
    };

    crankService = new CrankService(mockOracleService);
  });

  afterEach(() => {
    crankService.stop();
  });

  describe('constructor', () => {
    it('should set intervals from config', () => {
      const customInterval = 15000;
      const service = new CrankService(mockOracleService, customInterval);
      
      expect(service.isRunning).toBe(false);
    });
  });

  describe('discover', () => {
    it('should discover markets across multiple program IDs', async () => {
      const mockMarkets = [
        {
          slabAddress: { toBase58: () => 'Market111111111111111111111111111111111' },
          programId: { toBase58: () => '11111111111111111111111111111111' },
          config: {
            collateralMint: { toBase58: () => 'Mint1111111111111111111111111111111111' },
            oracleAuthority: { toBase58: () => 'Oracle11111111111111111111111111111111', equals: () => false },
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: {
            maintenanceMarginBps: 500n,
            initialMarginBps: 1000n,
          },
          header: {
            admin: { toBase58: () => 'Admin111111111111111111111111111111111' },
          },
        },
      ];

      vi.mocked(core.discoverMarkets).mockResolvedValue(mockMarkets as any);

      const result = await crankService.discover();

      // discoverMarkets returns same market for each program ID, so 2 total
      expect(result).toHaveLength(mockMarkets.length * 2);
      expect(core.discoverMarkets).toHaveBeenCalledTimes(2); // Two program IDs
      // Same slab address from both programs → stored once in map
      expect(crankService.getMarkets().size).toBe(1);
    });

    it('should handle discovery errors per program without crashing', async () => {
      vi.mocked(core.discoverMarkets)
        .mockRejectedValueOnce(new Error('Program 1 failed'))
        .mockResolvedValueOnce([{
          slabAddress: { toBase58: () => 'Market211111111111111111111111111111111' },
          programId: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          config: {
            collateralMint: { toBase58: () => 'Mint2111111111111111111111111111111111' },
            oracleAuthority: { toBase58: () => 'Oracle21111111111111111111111111111111', equals: () => false },
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: { toBase58: () => 'Admin211111111111111111111111111111111' } },
        }] as any);

      const result = await crankService.discover();

      expect(result).toHaveLength(1);
      expect(crankService.getMarkets().size).toBe(1);
    });

    it('should track and remove markets missing from 3 consecutive discoveries', async () => {
      // First discovery: add market
      const market1 = {
        slabAddress: { toBase58: () => 'Market311111111111111111111111111111111' },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint3111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => 'Oracle31111111111111111111111111111111', equals: () => false },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin311111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([market1] as any);
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Second discovery: market missing (count = 1)
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Third discovery: market missing (count = 2)
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(1);

      // Fourth discovery: market missing (count = 3, should be removed)
      await crankService.discover();
      expect(crankService.getMarkets().size).toBe(0);
    }, 20000);
  });

  describe('crankMarket', () => {
    it('should successfully crank a market and update state', async () => {
      const slabAddress = 'Market411111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint4111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin411111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(true);
      expect(keeperSendModule.keeperSend).toHaveBeenCalled();
      
      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.successCount).toBe(1);
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.isActive).toBe(true);
    });

    it('should increment failure count on crank failure', async () => {
      const slabAddress = 'Market511111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint5111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin511111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('Transaction failed'));

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(false);
      
      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.failureCount).toBe(1);
      expect(state?.consecutiveFailures).toBe(1);
    });

    it('should use longer inactive interval (60s) after 10 consecutive failures', async () => {
      // After 10 failures the market is demoted to inactive (isActive=false).
      // The isDue logic switches from crankIntervalMs (30s) to crankInactiveIntervalMs (60s).
      // Verify that within 60s of the last successful crank, isDue returns false.
      const slabAddress = 'MarketInactive11111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintInactive1111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminInact1111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Set a known baseline time via fake timers
      const startTime = 1_700_000_000_000; // fixed epoch ms
      vi.setSystemTime(startTime);

      // One successful crank to set lastCrankTime
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'initial-success', estimatedCost: 5000 } as any);
      await crankService.crankMarket(slabAddress);
      const stateAfterSuccess = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterSuccess.isActive).toBe(true);
      expect(stateAfterSuccess.lastCrankTime).toBeCloseTo(startTime, -2);

      // Now fail 10 consecutive times → market becomes inactive
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('Transaction failed'));
      for (let i = 0; i < 10; i++) {
        await crankService.crankMarket(slabAddress);
      }

      const stateAfterFailures = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterFailures.isActive).toBe(false);
      expect(stateAfterFailures.consecutiveFailures).toBe(10);

      // --- Verify isDue logic using inactive interval (60s) ---
      // The inactive interval from config mock is 120_000ms.
      // Active interval is 30_000ms.
      // Since market is now inactive, the effective interval is 120s (crankInactiveIntervalMs).

      // At t+30s: 30s < 120s → isDue should be false
      vi.setSystemTime(startTime + 30_000);
      const isDueAt30s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt30s).toBe(false);

      // At t+60s: 60s < 120s → still false
      vi.setSystemTime(startTime + 60_000);
      const isDueAt60s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt60s).toBe(false);

      // At t+121s: 121s >= 120s → isDue becomes true (inactive interval elapsed)
      vi.setSystemTime(startTime + 121_000);
      const isDueAt121s = Date.now() - stateAfterFailures.lastCrankTime >= 120_000;
      expect(isDueAt121s).toBe(true);
    });

    it('should mark market inactive after 10 consecutive failures', async () => {
      const slabAddress = 'Market611111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint6111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin611111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('Transaction failed'));

      // Fail 10 times
      for (let i = 0; i < 10; i++) {
        await crankService.crankMarket(slabAddress);
      }

      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.consecutiveFailures).toBe(10);
      expect(state?.isActive).toBe(false);
    });

    it('should cache HYPERP Raydium pool metadata and skip per-crank CU simulation', async () => {
      const slabAddress = '6ka35xxxfLE5GttGNX7ZDZZz3d1VM2spSWSjArMKxe8o';
      const poolAddress = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';
      const connection = {
        getAccountInfo: vi.fn(async () => ({
          owner: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
          data: Buffer.alloc(1544),
        })),
      };
      vi.mocked(shared.getConnection).mockReturnValue(connection as any);

      const mockMarket = {
        slabAddress: new PublicKey(slabAddress),
        programId: new PublicKey('ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv'),
        config: {
          collateralMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          oracleAuthority: PublicKey.default,
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          dexPool: new PublicKey(poolAddress),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: new PublicKey('7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G') },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-raydium', estimatedCost: 5000 } as any);
      await crankService.discover();

      expect(await crankService.crankMarket(slabAddress)).toBe(true);
      expect(await crankService.crankMarket(slabAddress)).toBe(true);

      expect(connection.getAccountInfo).toHaveBeenCalledTimes(1);
      expect(core.detectDexType).toHaveBeenCalledTimes(1);
      expect(keeperSendModule.keeperSend).toHaveBeenCalledTimes(2);
      expect(keeperSendModule.keeperSend).toHaveBeenLastCalledWith(
        connection,
        expect.any(Array),
        expect.any(Array),
        'crank',
        expect.anything(),
        3,
        expect.objectContaining({
          skipPreflight: true,
          multiRpcBroadcast: true,
          simulateForCU: false,
        }),
      );
    });
  });

  describe('PERC-381: permanent skip cooldown', () => {
    it('should NOT re-enable 0x4-skipped markets on immediate rediscovery', async () => {
      const slabAddress = 'MarketSkip111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintSkip1111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminSkip111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate 0x4 error → permanently skipped
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(
        new Error('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const stateAfterSkip = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterSkip.permanentlySkipped).toBe(true);
      expect(stateAfterSkip.permanentlySkippedAt).toBeDefined();
      expect(stateAfterSkip.skipCount).toBe(1);

      // Immediately rediscover — should NOT re-enable (cooldown not elapsed)
      await crankService.discover();

      const stateAfterRediscovery = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterRediscovery.permanentlySkipped).toBe(true);
    });

    it('should re-enable 0x4-skipped markets after cooldown expires', async () => {
      const slabAddress = 'MarketCool111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintCool1111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminCool111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate 0x4 error
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(
        new Error('custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.permanentlySkipped).toBe(true);

      // Fast-forward past the 1-hour cooldown (skipCount=1 → 1h)
      state.permanentlySkippedAt = Date.now() - 3_700_000; // 1h + 100s ago

      // Rediscover — should now re-enable
      await crankService.discover();

      const stateAfterCooldown = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterCooldown.permanentlySkipped).toBe(false);
      expect(stateAfterCooldown.consecutiveFailures).toBe(0);
    });

    it('should increase cooldown with each skip (exponential backoff)', { timeout: 30000 }, async () => {
      const slabAddress = 'MarketExp1111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintExp11111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminExp1111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Simulate multiple 0x4 errors
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(
        new Error('custom program error: 0x4')
      );
      await crankService.crankMarket(slabAddress);

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.skipCount).toBe(1);

      // Re-enable after cooldown, then fail again → skipCount=2
      state.permanentlySkippedAt = Date.now() - 3_700_000; // past 1h cooldown
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(false);

      await crankService.crankMarket(slabAddress);
      expect(state.permanentlySkipped).toBe(true);
      expect(state.skipCount).toBe(2);

      // After 1h (skipCount=2 → 2h cooldown) → should NOT re-enable yet
      state.permanentlySkippedAt = Date.now() - 3_700_000; // 1h ago, but need 2h
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(true); // Still in cooldown

      // After 2h → should re-enable
      state.permanentlySkippedAt = Date.now() - 7_300_000; // 2h+ ago
      await crankService.discover();
      expect(state.permanentlySkipped).toBe(false);
    });
  });

  describe('GH#1508: foreign oracle skip (OracleInvalid 0xc prevention)', () => {
    // Post-Phase-G note: crankMarket() no longer sets foreignOracleSkipped
    // because admin-push oracle mode was removed from the program. The flag
    // is retained as state for the live authority-check path in crankAll().
    // The three tests that exercised the deleted crankMarket() setter have
    // been removed; the remaining tests cover the crankAll() side.

    it.skip('should skip admin-oracle market where keeper is not the oracle authority and set foreignOracleSkipped', async () => {
      const slabAddress = 'MarketFO1111111111111111111111111111111';
      const FOREIGN_AUTHORITY = 'ForeignAuth111111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintFO11111111111111111111111111111111' },
          // Non-default oracleAuthority (admin oracle), but NOT equal to keeper key.
          // isAdminOracle() checks !oracleAuthority.equals(PublicKey.default) → oracleAuthority.equals(default)=false → !false=true → isAdminOracle
          // crankMarket() checks keypair.publicKey.equals(oracleAuthority) → we override loadKeypair below to return equals: () => false
          oracleAuthority: {
            toBase58: () => FOREIGN_AUTHORITY,
            equals: (other: any) => false, // not equal to PublicKey.default OR keeper key
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminFO11111111111111111111111111111111' } },
      };

      // Override loadKeypair so keypair.publicKey.equals(oracleAuthority) returns false (foreign key)
      vi.mocked(shared.loadKeypair).mockReturnValueOnce({
        publicKey: {
          toBase58: () => 'KeeperKey111111111111111111111111111111',
          equals: (other: any) => false, // keeper key does NOT match the foreign oracle authority
        },
        secretKey: new Uint8Array(64),
      } as any);

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(false);
      // Should NOT have submitted a transaction
      expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.foreignOracleSkipped).toBe(true);
      // Should not increment failure counters — this is an intentional skip, not a failure
      expect(state.failureCount).toBe(0);
      expect(state.consecutiveFailures).toBe(0);
    });

    it.skip('should reset foreignOracleSkipped on rediscovery so oracle authority changes are picked up', async () => {
      const slabAddress = 'MarketFO2111111111111111111111111111111';
      const FOREIGN_AUTHORITY = 'ForeignAuth211111111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintFO21111111111111111111111111111111' },
          oracleAuthority: {
            toBase58: () => FOREIGN_AUTHORITY,
            equals: (other: any) => false,
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminFO21111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      // Override loadKeypair so keeper is NOT the oracle authority → foreignOracleSkipped set
      vi.mocked(shared.loadKeypair).mockReturnValueOnce({
        publicKey: { toBase58: () => 'KeeperKey211111111111111111111111111111', equals: () => false },
        secretKey: new Uint8Array(64),
      } as any);

      await crankService.crankMarket(slabAddress);

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.foreignOracleSkipped).toBe(true);

      // Rediscovery should reset the flag so the next crankMarket call re-evaluates
      await crankService.discover();
      expect(state.foreignOracleSkipped).toBe(false);
    });

    it('should NOT skip admin-oracle market where keeper IS the oracle authority', async () => {
      const slabAddress = 'MarketOwnOracle1111111111111111111111111';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintOwn1111111111111111111111111111111' },
          // Non-default oracleAuthority (admin oracle), equals keeper key
          oracleAuthority: {
            toBase58: () => '11111111111111111111111111111111',
            equals: () => true, // keeper IS the oracle authority
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminOwn1111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-own-oracle', estimatedCost: 5000 } as any);
      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe(true);
      expect(keeperSendModule.keeperSend).toHaveBeenCalled();

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.foreignOracleSkipped).toBeUndefined();
      expect(state.successCount).toBe(1);
    });

    it.skip('should call recordPushTime after successful bundled price push', async () => {
      const slabAddress = 'MarketPushTime111111111111111111111111';
      const KEEPER_KEY = '11111111111111111111111111111111';
      const KEEPER_AUTH = 'KeeperAuth11111111111111111111111111111';

      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: {
          toBase58: () => KEEPER_AUTH,
          equals: (other: any) => other?.toBase58?.() === KEEPER_AUTH,
        },
        secretKey: new Uint8Array(64),
      } as any);

      const localCrank = new CrankService(mockOracleService);

      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => KEEPER_KEY },
        config: {
          collateralMint: { toBase58: () => 'MintPush1111111111111111111111111111111' },
          oracleAuthority: {
            toBase58: () => KEEPER_AUTH,
            equals: (other: any) => other?.toBase58?.() === KEEPER_AUTH,
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: BigInt(1_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminPush111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await localCrank.discover();

      mockOracleService.fetchPrice = vi.fn().mockResolvedValue({ priceE6: BigInt(50_000_000), source: 'dexscreener', timestamp: Date.now() });
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-push-time', estimatedCost: 5000 } as any);

      try {
        const result = await localCrank.crankMarket(slabAddress);
        expect(result).toBe(true);
        expect(mockOracleService.recordPushTime).toHaveBeenCalledWith(slabAddress);
      } finally {
        localCrank.stop();
      }
    });

    it('crankAll should count foreignOracleSkipped markets in skipped total', async () => {
      const slabForeign = 'MarketFO3111111111111111111111111111111';
      const slabNormal = 'MarketNorm111111111111111111111111111111';
      const FOREIGN_AUTH = 'ForeignAuth31111111111111111111111111111';
      const mockForeignMarket = {
        slabAddress: { toBase58: () => slabForeign },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintFO31111111111111111111111111111111' },
          // Non-default, non-keeper oracle authority → isAdminOracle=true, keeper≠authority
          oracleAuthority: {
            toBase58: () => FOREIGN_AUTH,
            equals: (_other: any) => false, // not PublicKey.default AND not keeper key
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminFO31111111111111111111111111111111' } },
      };
      const mockNormalMarket = {
        slabAddress: { toBase58: () => slabNormal },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintNorm1111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminNorm111111111111111111111111111111' } },
      };

      // GH#1251: crankAll now calls loadKeypair() for a live authority check.
      // Keeper key must NOT match oracleAuthority so the foreign market is skipped.
      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: {
          toBase58: () => 'KeeperKey311111111111111111111111111111',
          equals: (_other: any) => false, // keeper ≠ foreign oracle authority
        },
        secretKey: new Uint8Array(64),
      } as any);

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockForeignMarket, mockNormalMarket] as any);
      await crankService.discover();

      // Pre-mark the foreign oracle market as skipped (as crankMarket would do in steady state)
      const foreignState = crankService.getMarkets().get(slabForeign)!;
      foreignState.foreignOracleSkipped = true;

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-normal', estimatedCost: 5000 } as any);
      const result = await crankService.crankAll();

      // Normal market cranked; foreign oracle market skipped → skipped >= 1
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(1);
    });

    it('GH#1251: crankAll should count foreign-oracle market as skipped (not failed) even after discover() resets the flag', async () => {
      // Regression test: after discover() resets foreignOracleSkipped=false, crankAll used to
      // enqueue the market, call crankMarket() which returned false → failed++ instead of skipped++.
      // Fix: live authority check in crankAll before enqueue.
      const slabForeign = 'MarketFO4111111111111111111111111111111';
      const slabNormal  = 'MarketNorm2111111111111111111111111111111';

      const FOREIGN_AUTHORITY = 'ForeignAuth41111111111111111111111111111';

      const mockForeignMarket = {
        slabAddress: { toBase58: () => slabForeign },
        programId:   { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintFO41111111111111111111111111111111' },
          // Non-default, non-keeper oracle authority
          oracleAuthority: {
            toBase58: () => FOREIGN_AUTHORITY,
            equals: (_other: any) => false, // not PublicKey.default → isAdminOracle=true; not keeper → should skip
          },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminFO41111111111111111111111111111111' } },
      };
      const mockNormalMarket = {
        slabAddress: { toBase58: () => slabNormal },
        programId:   { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintNorm2111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminNorm2111111111111111111111111111111' } },
      };

      // Keeper key does NOT match FOREIGN_AUTHORITY
      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: {
          toBase58: () => 'KeeperKey411111111111111111111111111111',
          equals: (_other: any) => false,
        },
        secretKey: new Uint8Array(64),
      } as any);

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockForeignMarket, mockNormalMarket] as any);
      await crankService.discover();

      // Simulate what crankMarket() does: set foreignOracleSkipped=true
      const foreignState = crankService.getMarkets().get(slabForeign)!;
      foreignState.foreignOracleSkipped = true;

      // Now simulate discover() resetting the flag (as it does on each cycle)
      foreignState.foreignOracleSkipped = false;

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-norm2', estimatedCost: 5000 } as any);
      const result = await crankService.crankAll();

      // The foreign oracle market should be SKIPPED, not failed
      expect(result.failed).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(1);

      // Confirm the flag was re-set by crankAll's live check
      const stateAfter = crankService.getMarkets().get(slabForeign)!;
      expect(stateAfter.foreignOracleSkipped).toBe(true);
    });
  });

  describe('PERC-1254: Hyperp-mode markets with zero oracle price', () => {
    it('should skip Hyperp market with authorityPriceE6=0 and no fetchPrice result (not count as failed)', async () => {
      // Regression: Small/256-slot Hyperp markets (indexFeedId=all-zeros, authorityPriceE6=0)
      // where fetchPrice returns null cause OracleInvalid (0xc) if cranked.
      // They must be skipped, not failed.
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'mock-sig', estimatedCost: 5000 } as any);

      const slabHyperp = 'HyperpZero1111111111111111111111111111111';
      const slabNormal = 'Normal111111111111111111111111111111111';

      // Use valid 32-byte all-zeros key (SystemProgram) for ZERO_KEY
      const ZERO_BYTES = new Uint8Array(32); // all zeros
      const KEEPER_PUBKEY_STR = '11111111111111111111111111111112'; // valid base58 non-default

      // Set the mock BEFORE creating CrankService so _keypair cache picks up this key.
      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: {
          toBase58: () => KEEPER_PUBKEY_STR,
          equals: (other: any) => other?.toBase58?.() === KEEPER_PUBKEY_STR,
        },
        secretKey: new Uint8Array(64),
      } as any);

      // Create a fresh CrankService AFTER the mock is set so _keypair is KEEPER_PUBKEY_STR.
      const localCrank = new CrankService(mockOracleService);

      // Mock oracleAuthority that matches keeper key
      const keeperOracleAuth = {
        toBase58: () => KEEPER_PUBKEY_STR,
        equals: (other: any) => {
          // equals(PublicKey.default) → false (isAdminOracle = true)
          // equals(keeperPublicKey) → true
          if (other?.toBase58) return other.toBase58() === KEEPER_PUBKEY_STR;
          return false;
        },
      };

      const hyperpMarket = {
        slabAddress: { toBase58: () => slabHyperp, equals: (o: any) => false },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint1111111111111111111111111111111111' },
          // indexFeedId all-zeros → isHyperpMode = true (via toBytes() check)
          indexFeedId: { toBytes: () => ZERO_BYTES, equals: (o: any) => false },
          oracleAuthority: keeperOracleAuth, // keeper is the authority
          authorityPriceE6: BigInt(0), // never pushed → OracleInvalid if cranked
          lastEffectivePriceE6: BigInt(1_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      const normalMarket = {
        slabAddress: { toBase58: () => slabNormal, equals: (o: any) => false },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint2111111111111111111111111111111111' },
          // indexFeedId all-zeros → isHyperpMode = true BUT authorityPriceE6 > 0 → safe to crank
          indexFeedId: { toBytes: () => ZERO_BYTES, equals: (o: any) => false },
          oracleAuthority: keeperOracleAuth, // keeper is authority, has a price on-chain
          authorityPriceE6: BigInt(50_000_000), // already set on-chain
          lastEffectivePriceE6: BigInt(50_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin211111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([hyperpMarket as any, normalMarket as any]);

      // fetchPrice returns null (no DEX data for either market)
      mockOracleService.fetchPrice = vi.fn().mockResolvedValue(null);

      try {
        await localCrank.discover();

        const result = await localCrank.crankAll();

        // Hyperp no-price market → skipped (not failed)
        expect(result.failed).toBe(0);
        // Normal market with existing on-chain price (authorityPriceE6 > 0) should crank successfully
        expect(result.success).toBeGreaterThanOrEqual(1);

        // Flag should be set on hyperp zero-price market
        const hyperpState = localCrank.getMarkets().get(slabHyperp)!;
        expect(hyperpState.hyperpNoPriceSkipped).toBe(true);
      } finally {
        localCrank.stop();
      }
    });

    it('PERC-1254: should crank Hyperp market once fetchPrice returns a valid price', async () => {
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'mock-sig', estimatedCost: 5000 } as any);

      const slabHyperp = 'HyperpWithPrice111111111111111111111111';
      const ZERO_BYTES = new Uint8Array(32);
      const KEEPER_PUBKEY_STR2 = '11111111111111111111111111111112';

      const keeperOracleAuth2 = {
        toBase58: () => KEEPER_PUBKEY_STR2,
        equals: (other: any) => {
          if (other?.toBase58) return other.toBase58() === KEEPER_PUBKEY_STR2;
          return false;
        },
      };

      // Set mock BEFORE constructing the local service so _keypair cache picks it up.
      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: {
          toBase58: () => KEEPER_PUBKEY_STR2,
          equals: (other: any) => other?.toBase58?.() === KEEPER_PUBKEY_STR2,
        },
        secretKey: new Uint8Array(64),
      } as any);

      // Fresh CrankService so _keypair is KEEPER_PUBKEY_STR2.
      const localCrank = new CrankService(mockOracleService);

      const hyperpMarket = {
        slabAddress: { toBase58: () => slabHyperp, equals: (o: any) => false },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint3111111111111111111111111111111111' },
          indexFeedId: { toBytes: () => ZERO_BYTES, equals: (o: any) => false },
          oracleAuthority: keeperOracleAuth2,
          authorityPriceE6: BigInt(0),
          lastEffectivePriceE6: BigInt(1_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin311111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([hyperpMarket as any]);

      try {
        // First cycle: no price
        mockOracleService.fetchPrice = vi.fn().mockResolvedValue(null);
        await localCrank.discover();
        const result1 = await localCrank.crankAll();
        expect(result1.failed).toBe(0);
        const stateAfterSkip = localCrank.getMarkets().get(slabHyperp)!;
        expect(stateAfterSkip.hyperpNoPriceSkipped).toBe(true);

        // Second cycle: price available — should clear flag and crank
        mockOracleService.fetchPrice = vi.fn().mockResolvedValue({ priceE6: BigInt(75_000_000) });
        // Simulate discovery reset (as discover() does)
        stateAfterSkip.hyperpNoPriceSkipped = false;

        const result2 = await localCrank.crankMarket(slabHyperp);
        expect(result2).toBe(true);
        const stateAfterCrank = localCrank.getMarkets().get(slabHyperp)!;
        expect(stateAfterCrank.hyperpNoPriceSkipped).toBeFalsy();
      } finally {
        localCrank.stop();
      }
    });

    it('PERC-1254: should reset hyperpNoPriceSkipped flag on rediscovery', async () => {
      const slabHyperp = 'HyperpReset1111111111111111111111111111';
      const ZERO_BYTES3 = new Uint8Array(32);

      const hyperpMarket = {
        slabAddress: { toBase58: () => slabHyperp, equals: (o: any) => false },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint4111111111111111111111111111111111' },
          indexFeedId: { toBytes: () => ZERO_BYTES3, equals: (o: any) => false },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => false },
          authorityPriceE6: BigInt(0),
          lastEffectivePriceE6: BigInt(1_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin411111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([hyperpMarket as any]);
      await crankService.discover();

      // Manually set the skip flag (simulating previous crankMarket() cycle)
      const state = crankService.getMarkets().get(slabHyperp)!;
      state.hyperpNoPriceSkipped = true;

      // Re-run discovery — flag should be reset
      await crankService.discover();
      const stateAfter = crankService.getMarkets().get(slabHyperp)!;
      expect(stateAfter.hyperpNoPriceSkipped).toBe(false);
    });
  });

  describe('start and stop', () => {
    it('should start timer and perform initial discovery', async () => {
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);

      // B11: start() is now async — await it so we can verify initial discovery synchronously
      await crankService.start();

      expect(crankService.isRunning).toBe(true);
      expect(core.discoverMarkets).toHaveBeenCalled();
    });

    it('should stop timer', async () => {
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);
      await crankService.start();
      expect(crankService.isRunning).toBe(true);

      crankService.stop();
      expect(crankService.isRunning).toBe(false);
    });
  });

  // PERC-1650: Keeper RPC 429 retry + sequential mode
  describe('PERC-1650: discover() 429 retry', () => {
    it('calls discoverMarkets with connection and program id', async () => {
      vi.mocked(core.discoverMarkets).mockResolvedValue([]);
      await crankService.discover();
      expect(core.discoverMarkets).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('retries on 429 at the program level and succeeds on second attempt', async () => {
      const market = {
        slabAddress: { toBase58: () => 'Slab429111111111111111111111111111111111', equals: () => false },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'Mint111111111111111111111111111111111111' },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(1), equals: () => false },
          oracleAuthority: { toBase58: () => 'Auth1111111111111111111111111111111111', equals: () => false },
          authorityPriceE6: BigInt(0),
          lastEffectivePriceE6: BigInt(0),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };

      let callCount = 0;
      vi.mocked(core.discoverMarkets).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('429 Too Many Requests');
        return [market as any];
      });

      await crankService.discover();

      // Should have retried: callCount >= 2
      expect(callCount).toBeGreaterThanOrEqual(2);
      // Market should be registered after retry success
      expect(crankService.getMarkets().size).toBeGreaterThanOrEqual(1);
    });

    it('skips program after exhausting 429 retries and continues to next program', async () => {
      // Use fake timers so the exponential backoff delays don't actually wait.
      vi.useFakeTimers();

      // 2 programs configured in mock; first always 429s, second succeeds
      let firstProgramCalls = 0;
      const market = {
        slabAddress: { toBase58: () => 'SlabGood111111111111111111111111111111111', equals: () => false },
        programId: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        config: {
          collateralMint: { toBase58: () => 'Mint222222222222222222222222222222222222' },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(2), equals: () => false },
          oracleAuthority: { toBase58: () => 'Auth222222222222222222222222222222222222', equals: () => false },
          authorityPriceE6: BigInt(0),
          lastEffectivePriceE6: BigInt(0),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin222222222222222222222222222222222222' } },
      };

      vi.mocked(core.discoverMarkets).mockImplementation(async (_conn, programId: any) => {
        const id = typeof programId.toBase58 === 'function' ? programId.toBase58() : String(programId);
        if (id === '11111111111111111111111111111111') {
          firstProgramCalls++;
          throw new Error('429 Too Many Requests');
        }
        return [market as any];
      });

      // Run discover() concurrently and advance fake timers to skip all backoff delays.
      const discoverPromise = crankService.discover();
      // Advance past all possible backoff delays (sum of DISCOVER_429_BACKOFF_MS * 1.25 jitter + inter-program delay)
      await vi.runAllTimersAsync();
      await discoverPromise;

      vi.useRealTimers();

      // First program should have been attempted multiple times (retries)
      expect(firstProgramCalls).toBeGreaterThan(1);
      // Second program's market should still be found
      expect(crankService.getMarkets().has('SlabGood111111111111111111111111111111111')).toBe(true);
    }, 15_000);

    it('does not retry on non-429 errors', async () => {
      let callCount = 0;
      vi.mocked(core.discoverMarkets).mockImplementation(async () => {
        callCount++;
        throw new Error('Connection refused');
      });

      await crankService.discover();
      // Should only have been called once per program (2 programs × 1 attempt = 2)
      expect(callCount).toBe(2);
    });
  });
});
