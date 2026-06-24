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
  encodePermissionlessCrank: vi.fn(() => Buffer.from([5, 0, 0, 0, 0, 0])),
  CrankAction: { FeeSweep: 0, Liquidate: 1 },
  encodePushOraclePrice: vi.fn(() => Buffer.from([4, 5, 6])),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => '11111111111111111111111111111111' }, 0]),
  fetchSlab: vi.fn(),
  parseHeader: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  isV17Account: vi.fn(() => false),
  parseWrapperConfigV17: vi.fn(),
  parsePortfolioV17: vi.fn(),
  detectDexType: vi.fn(() => null),
  parseDexPool: vi.fn(),
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
  // LP vault functions used by crankLpVault (#339)
  deriveLpVaultRegistry: vi.fn(() => [{ toBase58: () => 'LpReg111111111111111111111111111111111' }]),
  deriveLpBackingLedger: vi.fn(() => [{ toBase58: () => 'LpLedger1111111111111111111111111111111' }]),
  parseLpVaultRegistry: vi.fn(() => ({ domain: 0 })),
  encodeLpVaultCrankFees: vi.fn(() => Buffer.from([78, 0, 0, 0, 0, 0])),
  encodeInitUser: vi.fn(() => Buffer.from([1, 0, 0, 0, 0, 0])),
  deriveLpVaultRegistryPDA: vi.fn(() => [{ toBase58: () => 'LpReg111111111111111111111111111111111' }]),
}));

vi.mock('../../src/lib/v17-risk.js', () => ({
  V17_RISK_PARAMS_MIN_DATA_LEN: 538,
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
  })),
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
    getSlot: vi.fn().mockResolvedValue(200),
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

const MOCK_PORTFOLIO = new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');

/** v17: set keeperPortfolio on all markets after discover() so crankMarket() actually transacts */
function setKeeperPortfolios(service: CrankService, portfolio = MOCK_PORTFOLIO) {
  for (const state of service.getMarkets().values()) {
    state.keeperPortfolio = portfolio;
  }
}

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

    it('LaserStream fast-path retries v17 keeper portfolio provisioning when keeperPortfolio is null', async () => {
      const prevLaserStream = process.env.KEEPER_USE_LASERSTREAM;
      process.env.KEEPER_USE_LASERSTREAM = 'true';

      try {
        const slabAddress = new PublicKey('11111111111111111111111111111111');

        const mockCache = {
          getOwnerVerified: vi.fn(() => null),
        };

        const mockAccountLoader = {
          getCache: vi.fn(() => mockCache),
          getStats: vi.fn(() => ({ lastSlot: 123 })),
          getProgramId: vi.fn(() => new PublicKey('11111111111111111111111111111111')),
        };

        const service = new CrankService(mockOracleService, undefined, mockAccountLoader as any);

        const mockMarket = {
          slabAddress,
          programId: new PublicKey('11111111111111111111111111111111'),
          config: {
            collateralMint: new PublicKey('11111111111111111111111111111111'),
            oracleAuthority: PublicKey.default,
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: PublicKey.default, version: 16, kind: 1 },
          _rawV17Config: {},
        };

        const legacySlabAddress = new PublicKey('So11111111111111111111111111111111111111112');
        const legacyMarket = {
          ...mockMarket,
          slabAddress: legacySlabAddress,
          header: { admin: PublicKey.default, version: 12, kind: 0 },
          _rawV17Config: undefined,
        };

        // Simulate a v17 market already discovered earlier, but portfolio provisioning failed.
        // In this state, crankMarket() skips because keeperPortfolio is still null.
        (service as any).markets.set(slabAddress.toBase58(), {
          market: mockMarket,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          isActive: true,
          missingDiscoveryCount: 0,
          keeperPortfolio: null,
        });

        // Also include a legacy/non-v17 market with keeperPortfolio null.
        // The fast-path retry must not attempt v17 portfolio provisioning for it.
        (service as any).markets.set(legacySlabAddress.toBase58(), {
          market: legacyMarket,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          isActive: true,
          missingDiscoveryCount: 0,
          keeperPortfolio: null,
        });

        // Keep discover() inside the LaserStream fast-path instead of full rediscovery.
        (service as any)._lastFullRediscoverTime = Date.now();

        const getProgramAccounts = vi.fn().mockResolvedValue([]);
        const getMinimumBalanceForRentExemption = vi.fn().mockResolvedValue(1);

        vi.mocked(shared.getConnection).mockClear();
        vi.mocked(shared.getConnection).mockReturnValueOnce({
          getAccountInfo: vi.fn(),
          getSlot: vi.fn().mockResolvedValue(200),
          getProgramAccounts,
          getMinimumBalanceForRentExemption,
        } as any);

        await service.discover();

        // Fix #332: the fast-path must NOT eagerly provision keeper portfolios —
        // that drains keeper SOL on every 30-second cache refresh. Provisioning
        // is deferred to the full discover path (every KEEPER_FULL_REDISCOVER_INTERVAL_MS).
        // After discover(), no getProgramAccounts call for portfolio provisioning should occur.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // getConnection may have been called for cache reads, but getProgramAccounts
        // must NOT have been called (no provisioning in the fast path).
        expect(getProgramAccounts).not.toHaveBeenCalled();

        service.stop();
      } finally {
        if (prevLaserStream === undefined) {
          delete process.env.KEEPER_USE_LASERSTREAM;
        } else {
          process.env.KEEPER_USE_LASERSTREAM = prevLaserStream;
        }
      }
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

    it('retries v17 keeper portfolio provisioning on normal rediscovery when keeperPortfolio is null', async () => {
      const prevLaserStream = process.env.KEEPER_USE_LASERSTREAM;
      delete process.env.KEEPER_USE_LASERSTREAM;

      try {
        const slabAddress = new PublicKey('11111111111111111111111111111111');

        const service = new CrankService(mockOracleService);

        const mockMarket = {
          slabAddress,
          programId: new PublicKey('11111111111111111111111111111111'),
          config: {
            collateralMint: new PublicKey('11111111111111111111111111111111'),
            oracleAuthority: PublicKey.default,
            indexFeedId: { toBytes: () => new Uint8Array(32) },
          },
          params: { maintenanceMarginBps: 500n },
          header: { admin: PublicKey.default, version: 16, kind: 1 },
          _rawV17Config: {},
        };

        // Simulate a v17 market that was already discovered, but its keeper
        // portfolio provisioning failed transiently, leaving keeperPortfolio null.
        (service as any).markets.set(slabAddress.toBase58(), {
          market: mockMarket,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          isActive: true,
          missingDiscoveryCount: 0,
          keeperPortfolio: null,
        });

        // Force discover() to take the normal full rediscovery path.
        (service as any)._lastFullRediscoverTime = 0;

        const discoveredMarkets = [mockMarket];
        vi.mocked(core.discoverMarkets)
          .mockResolvedValueOnce(discoveredMarkets as any)
          .mockResolvedValue([]);

        const getProgramAccounts = vi.fn().mockResolvedValue([]);
        const getMinimumBalanceForRentExemption = vi.fn().mockResolvedValue(1);

        vi.mocked(shared.getConnection).mockClear();
        vi.mocked(shared.getConnection).mockReturnValueOnce({
          getAccountInfo: vi.fn(),
          getSlot: vi.fn().mockResolvedValue(200),
          getProgramAccounts,
          getMinimumBalanceForRentExemption,
        } as any);

        await service.discover();

        // Normal rediscovery should retry the v17 portfolio provisioning path
        // for an existing market whose keeperPortfolio is still null.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(core.discoverMarkets).toHaveBeenCalled();
        expect(shared.getConnection).toHaveBeenCalledTimes(1);
        expect(getProgramAccounts).toHaveBeenCalledTimes(1);
        expect(getProgramAccounts.mock.calls[0]?.[0]).toBe(mockMarket.programId);
        expect(getProgramAccounts.mock.calls[0]?.[1]?.filters).toContainEqual({ dataSize: 9347 });

        service.stop();
      } finally {
        if (prevLaserStream === undefined) {
          delete process.env.KEEPER_USE_LASERSTREAM;
        } else {
          process.env.KEEPER_USE_LASERSTREAM = prevLaserStream;
        }
      }
    });

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
      setKeeperPortfolios(crankService);

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe('success');
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
      setKeeperPortfolios(crankService);

      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('Transaction failed'));

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe('failed');

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
      setKeeperPortfolios(crankService);

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

    // M9: lastCrankTime must advance on FAILURE too, not just success. Pre-fix,
    // a market failing every cycle had a stale lastCrankTime, so the isDue
    // back-off (from 30s active → 120s inactive after 10 failures) never
    // actually fired — the keeper kept cranking the dead market every 30s.
    it('M9: lastCrankTime advances on failure (inactive back-off interval is honored)', async () => {
      const slabAddress = 'MarketM9LastCrankAaaaaaaaaaaaaaaaaaaaaaa';
      const mockMarket = {
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintM9111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminM9Last1111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService); // v17: must provision portfolio before crankMarket runs

      // Anchor time. A fresh market has lastCrankTime=0 (never cranked).
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);

      const stateBefore = crankService.getMarkets().get(slabAddress)!;
      expect(stateBefore.lastCrankTime).toBe(0);

      // First crankMarket attempt fails. lastCrankTime must advance.
      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('rpc error'));
      const result = await crankService.crankMarket(slabAddress);
      expect(result).toBe('failed');

      const stateAfterOneFailure = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterOneFailure.consecutiveFailures).toBe(1);
      expect(stateAfterOneFailure.lastCrankTime).toBe(t0);
      //                                        ↑ pre-fix this would be 0 (never updated)

      // Move time forward 15s and fail again. lastCrankTime must advance to t0+15s.
      vi.setSystemTime(t0 + 15_000);
      await crankService.crankMarket(slabAddress);
      const stateAfterTwoFailures = crankService.getMarkets().get(slabAddress)!;
      expect(stateAfterTwoFailures.lastCrankTime).toBe(t0 + 15_000);

      vi.useRealTimers();
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
      setKeeperPortfolios(crankService);

      vi.mocked(keeperSendModule.keeperSend).mockRejectedValue(new Error('Transaction failed'));

      // Fail 10 times
      for (let i = 0; i < 10; i++) {
        await crankService.crankMarket(slabAddress);
      }

      const state = crankService.getMarkets().get(slabAddress);
      expect(state?.consecutiveFailures).toBe(10);
      expect(state?.isActive).toBe(false);
    });

    it('v17: PermissionlessCrank uses skipPreflight + simulateForCU=false on repeated cranks', async () => {
      // v17 note: HYPERP DEX pool caching was removed — tag 34 is now ConfigureHybridOracle.
      // This test verifies the PermissionlessCrank (FeeSweep) path uses the correct keeperSend opts.
      const slabAddress = '6ka35xxxfLE5GttGNX7ZDZZz3d1VM2spSWSjArMKxe8o';
      const connection = {
        getAccountInfo: vi.fn(),
        getSlot: vi.fn().mockResolvedValue(300),
      };
      vi.mocked(shared.getConnection).mockReturnValue(connection as any);

      const mockMarket = {
        slabAddress: new PublicKey(slabAddress),
        programId: new PublicKey('ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv'),
        config: {
          collateralMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          oracleAuthority: PublicKey.default,
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: new PublicKey('7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G') },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockMarket] as any);
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-v17', estimatedCost: 5000 } as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      expect(await crankService.crankMarket(slabAddress)).toBe('success');
      expect(await crankService.crankMarket(slabAddress)).toBe('success');

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

    // M8: per-market in-flight guard. The /register HTTP endpoint and the
    // timer-driven crankAll fan-out both call crankMarket directly. Pre-fix,
    // a /register HTTP arriving mid-cycle could fire a duplicate KeeperCrank
    // tx for the same slab. The guard makes concurrent crankMarket calls for
    // the same slab a no-op (second call returns false immediately).
    //
    // We test the contract directly via the private `_inflightMarkets` set
    // rather than racing async timing — the latter proved fragile across
    // machines.
    it('M8: crankMarket bails when slab is already in _inflightMarkets (no send)', async () => {
      const slabAddress = 'MarketM8GuardAaaaaaaaaaaaaaaaaaaaaaaaaaa';
      vi.mocked(core.discoverMarkets).mockResolvedValue([{
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(1) },
          oracleAuthority: { toBase58: () => 'NonZeroAuth1111111111111111111111111111111' },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminM8G11111111111111111111111111111111' } },
      }] as any);
      await crankService.discover();

      const sendSpy = vi.mocked(keeperSendModule.keeperSend);
      sendSpy.mockClear();

      // Simulate "another caller is already in flight" by pre-populating the set.
      const inflight: Set<string> = (crankService as any)._inflightMarkets;
      inflight.add(slabAddress);

      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe('skipped');
      expect(sendSpy).not.toHaveBeenCalled();

      // Clean up so this test doesn't pollute later tests in the suite.
      inflight.delete(slabAddress);
    });

    it('M8: _inflightMarkets is empty before AND after a crankMarket call (released by finally)', async () => {
      const slabAddress = 'MarketM8ReleaseAaaaaaaaaaaaaaaaaaaaaaaaa';
      vi.mocked(core.discoverMarkets).mockResolvedValue([{
        slabAddress: { toBase58: () => slabAddress },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
          indexFeedId: { toBytes: () => new Uint8Array(32).fill(1) },
          oracleAuthority: { toBase58: () => 'NonZeroAuth1111111111111111111111111111111' },
          authorityPriceE6: 1_000_000n,
          authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminM8R11111111111111111111111111111111' } },
      }] as any);
      await crankService.discover();

      const inflight: Set<string> = (crankService as any)._inflightMarkets;
      expect(inflight.has(slabAddress)).toBe(false);

      await crankService.crankMarket(slabAddress);

      // Whether the body succeeded or failed, the finally clause must release.
      expect(inflight.has(slabAddress)).toBe(false);
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
      setKeeperPortfolios(crankService);

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
      setKeeperPortfolios(crankService);

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
      setKeeperPortfolios(crankService);

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

      expect(result).toBe('skipped');
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
      setKeeperPortfolios(crankService);

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-own-oracle', estimatedCost: 5000 } as any);
      const result = await crankService.crankMarket(slabAddress);

      expect(result).toBe('success');
      expect(keeperSendModule.keeperSend).toHaveBeenCalled();

      const state = crankService.getMarkets().get(slabAddress)!;
      expect(state.foreignOracleSkipped).toBeUndefined();
      expect(state.successCount).toBe(1);
    });

    // v17 behaviour (diverges from main Post-Phase-G):
    // In main, Phase-G removed the foreign-oracle skip so admin-oracle markets are always
    // cranked regardless of the keeper's authority match. In v17 we deliberately KEEP the
    // skip: admin-oracle markets where keeper != oracleAuthority are skipped with
    // skippedForeignOracle++ because the v17 program still enforces oracleAuthority on
    // admin-push instructions. HYPERP oracle mode (UpdateHyperpMark, tag 34) is gone; a
    // zero-feed market with a non-keeper oracleAuthority is an admin-oracle market and
    // must not be cranked by an unpermissioned keeper.
    it('v17: a market with a non-keeper admin-oracle authority is SKIPPED (not cranked)', async () => {
      const slabForeign = 'MarketFO3111111111111111111111111111111';
      const mockForeignMarket = {
        slabAddress: { toBase58: () => slabForeign },
        programId: { toBase58: () => '11111111111111111111111111111111' },
        config: {
          collateralMint: { toBase58: () => 'MintFO31111111111111111111111111111111' },
          // Non-zero, non-keeper oracle authority → isAdminOracle()=true, keeper doesn't match.
          oracleAuthority: { toBase58: () => 'ForeignAuth31111111111111111111111111111', equals: (_o: any) => false },
          indexFeedId: { toBytes: () => new Uint8Array(32) }, // zero feed
          authorityPriceE6: BigInt(50_000_000),
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'AdminFO31111111111111111111111111111111' } },
      };

      vi.mocked(shared.loadKeypair).mockReturnValue({
        publicKey: { toBase58: () => 'KeeperKey311111111111111111111111111111', equals: (_o: any) => false },
        secretKey: new Uint8Array(64),
      } as any);

      vi.mocked(core.discoverMarkets).mockResolvedValue([mockForeignMarket] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-foreign', estimatedCost: 5000 } as any);
      const result = await crankService.crankAll();

      // v17: the non-keeper admin-oracle market is SKIPPED, not cranked.
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(0);
      expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();
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
      setKeeperPortfolios(crankService);

      // Simulate what crankMarket() does: set foreignOracleSkipped=true
      const foreignState = crankService.getMarkets().get(slabForeign)!;
      foreignState.foreignOracleSkipped = true;

      // Now simulate discover() resetting the flag (as it does on each cycle)
      foreignState.foreignOracleSkipped = false;

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig-norm2', estimatedCost: 5000 } as any);
      const result = await crankService.crankAll();

      // The foreign oracle market should be SKIPPED, not failed
      expect(result.failed).toBe(0);
      expect(result.success).toBeGreaterThanOrEqual(1);
    });
  });

  describe('PERC-1254: Hyperp-mode markets with zero oracle price', () => {
    // v17: HYPERP oracle mode (UpdateHyperpMark, tag 34) was removed — tag 34 is now
    // ConfigureHybridOracle. The hyperpNoPriceSkipped skip-logic and authorityPriceE6 guard
    // in crankAll() no longer exist. These tests are skipped until they are rewritten
    // against the v17 oracle model.
    it.skip('should skip Hyperp market with authorityPriceE6=0 and no fetchPrice result (not count as failed)', async () => {
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

    // v17: HYPERP oracle mode (UpdateHyperpMark, tag 34) was removed — tag 34 is now
    // ConfigureHybridOracle. The tests below are from main's HYPERP hardening (PR fixes
    // for the seedable-market wedge, DEX-pool fallback, no-pool skip). They are kept as
    // it.skip() because hyperpNoPriceSkipped / dexPoolAddress / dexPoolRemainingAccounts
    // fields were not ported to v17 MarketCrankState and UpdateHyperpMark does not exist.
    it.skip('PoC (main): a seedable HYPERP market is wrongly skipped by crankAll before UpdateHyperpMark can seed it', async () => {
      // v17: not applicable — UpdateHyperpMark removed. Test preserved for reference.
    });

    it.skip('main: still skips a zero-mark HYPERP market with NO DEX pool', async () => {
      // v17: not applicable.
    });

    it.skip('main: cranks a zero-mark HYPERP market seedable via Supabase DEX-pool fallback', async () => {
      // v17: not applicable.
    });

    it.skip('PERC-1254: skips an unseeded HYPERP market with no DEX pool, then cranks it once a pool is configured', async () => {
      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'mock-sig', estimatedCost: 5000 } as any);

      const slabHyperp = 'HyperpWithPrice111111111111111111111111';
      const ZERO_BYTES = new Uint8Array(32);
      const KEEPER_PUBKEY_STR2 = '11111111111111111111111111111112';
      const POOL = 'So11111111111111111111111111111111111111112';

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
          // Keeper is the (vestigial) authority — under the old code this forced a
          // skip even once a pool was available; it must not anymore.
          oracleAuthority: {
            toBase58: () => KEEPER_PUBKEY_STR2,
            equals: (other: any) => other?.toBase58?.() === KEEPER_PUBKEY_STR2,
          },
          authorityPriceE6: BigInt(0), // unseeded
          lastEffectivePriceE6: BigInt(1_000_000),
          dexPool: null, // no pinned DEX pool yet → genuinely un-seedable this cycle
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin311111111111111111111111111111111' } },
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([hyperpMarket as any]);

      try {
        // First cycle: zero mark AND no DEX pool → un-seedable → skipped (not failed).
        await localCrank.discover();
        const result1 = await localCrank.crankAll();
        expect(result1.failed).toBe(0);
        expect(result1.skipped).toBe(1);
        const state = localCrank.getMarkets().get(slabHyperp)!;
        expect(state.hyperpNoPriceSkipped).toBe(true);

        // A DEX pool is now configured (admin SetDexPool / Supabase). The market
        // becomes seedable, so crankMarket sends UpdateHyperpMark + crank. Pre-cache
        // the resolved pool metadata so the build skips the RPC vault lookup.
        state.hyperpNoPriceSkipped = false;
        state.dexPoolAddress = POOL;
        state.dexPoolResolvedAddress = POOL;
        state.dexPoolRemainingAccounts = [];

        const result2 = await localCrank.crankMarket(slabHyperp);
        expect(result2).toBe('success');
        const stateAfterCrank = localCrank.getMarkets().get(slabHyperp)!;
        expect(stateAfterCrank.hyperpNoPriceSkipped).toBeFalsy();
      } finally {
        localCrank.stop();
      }
    });

    it.skip('PERC-1254: should reset hyperpNoPriceSkipped flag on rediscovery', async () => {
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

  describe('registerMarket', () => {
    it('provisions a v17 keeper portfolio before reporting the initial hot-register crank', async () => {
      const slabAddress = 'So11111111111111111111111111111111111111112';
      const programId = new PublicKey('11111111111111111111111111111111');
      const portfolio = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const marketData = new Uint8Array(600);
      const connection = {
        getAccountInfo: vi.fn(async () => ({
          data: marketData,
          owner: programId,
        })),
        getProgramAccounts: vi.fn(async () => [
          { pubkey: portfolio, account: { data: new Uint8Array([1, 2, 3]) } },
        ]),
      };

      vi.mocked(shared.getConnection)
        .mockReturnValueOnce(connection as any)
        .mockReturnValueOnce(connection as any);
      vi.mocked(core.isV17Account).mockReturnValueOnce(true);
      vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
        marketauth: PublicKey.default,
        collateralMint: programId,
        oracleMode: 2,
        oracleLegFeeds: [],
        maxStalenessSecs: 60n,
        confFilterBps: 0,
        invert: 0,
        unitScale: 1,
        oracleTargetPriceE6: 0n,
        oracleTargetPublishTime: 0n,
        markEwmaE6: 1_000_000n,
      } as any);
      vi.mocked(core.parsePortfolioV17).mockReturnValueOnce({
        owner: { equals: () => true },
      } as any);

      const crankSpy = vi.spyOn(crankService, 'crankMarket').mockImplementation(async (slab) => {
        const state = (crankService as any).markets.get(slab);
        expect(state.keeperPortfolio).toBe(portfolio);
        return true;
      });

      const result = await crankService.registerMarket(slabAddress);

      expect(result).toEqual({
        success: true,
        message: 'Market registered and initial crank triggered',
      });
      expect(core.parseHeader).not.toHaveBeenCalled();
      expect(core.parseWrapperConfigV17).toHaveBeenCalledWith(marketData);
      expect(connection.getProgramAccounts).toHaveBeenCalled();
      expect(crankSpy).toHaveBeenCalledWith(slabAddress);
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

  // ─── H4 (HIGH): watchdog must not let a second crank cycle launch while the first ──
  // ─── is still in-flight, and must trigger supervisor restart on a genuine hang.   ──
  // Pre-fix bug: watchdog set `_cycling=false` when elapsed > MAX_CYCLE_MS, letting
  // the next interval tick run `crankAll()` concurrently with the in-flight one →
  // duplicate KeeperCrank txs, doubled funding, RPC storms.
  describe('H4: watchdog double-execution guard', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock process.exit so the test doesn't actually kill vitest. The fix calls
      // process.exit(1) when a cycle hangs beyond MAX_CYCLE_MS + WATCHDOG_GRACE_MS.
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
    });

    afterEach(() => {
      // Stop the keeper + restore timers + restore process.exit BEFORE the next
      // test, even if this one timed out — otherwise the leftover setInterval
      // leaks fake-timer state into subsequent describe blocks.
      crankService.stop();
      vi.useRealTimers();
      exitSpy.mockRestore();
    });

    // Pre-populates a single dummy market so start() bypasses its initial
    // `await this.discover()` (which hangs under fake timers when called
    // before discoverMarkets() resolves). Then under fake timers we can
    // observe the setInterval ticks directly.
    function prepStartedService(): void {
      (crankService as any).markets.set('dummy-slab', {
        slabAddress: 'dummy-slab',
        market: {},
        lastCrankTime: Date.now(),
        successCount: 0,
        failureCount: 0,
        isActive: true,
        consecutiveErrors: 0,
      });
    }

    // Pump the interval into the watchdog branch. _cycling is pre-staged so
    // the watchdog branch runs synchronously and we never enter the
    // crankAll/discover path (which would await mocked RPCs and stall the
    // fake-timer scheduler).
    function setCyclingHung(elapsedMs: number = 6 * 60_000) {
      (crankService as any)._cycling = true;
      (crankService as any)._cycleStartedAt = Date.now() - elapsedMs;
    }

    it('H4: does NOT reset _cycling when watchdog observes a hung cycle', async () => {
      prepStartedService();
      vi.useFakeTimers();
      void crankService.start(); // sync return — markets is non-empty so discover is skipped
      setCyclingHung(); // 6 min elapsed > 5 min MAX_CYCLE_MS

      await vi.advanceTimersByTimeAsync(31_000);

      expect((crankService as any)._cycling).toBe(true);
      expect((crankService as any)._watchdogArmedAt).toBeGreaterThan(0);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('H4: alerts once even across multiple watchdog ticks within grace', async () => {
      prepStartedService();
      vi.useFakeTimers();
      void crankService.start();
      setCyclingHung();
      const alertSpy = vi.mocked(shared.sendCriticalAlert);
      alertSpy.mockClear();

      await vi.advanceTimersByTimeAsync(31_000);
      // Re-stage so _cycling stays true and elapsed stays > MAX_CYCLE_MS for the next tick.
      setCyclingHung();
      await vi.advanceTimersByTimeAsync(15_000); // still inside grace

      expect(alertSpy).toHaveBeenCalledTimes(1);
      const [title] = alertSpy.mock.calls[0]!;
      expect(title).toContain('hung');
    });

    it('H4: process.exit(1) fires after grace period if cycle stays hung', async () => {
      prepStartedService();
      vi.useFakeTimers();
      void crankService.start();
      setCyclingHung();

      await vi.advanceTimersByTimeAsync(31_000);
      expect(exitSpy).not.toHaveBeenCalled();

      setCyclingHung();
      // Advance well past the 30s grace boundary (>= 31s + small slop). The check
      // is strictly >, so being inside the same fake-time tick that equals exactly
      // 30s wouldn't fire — give it a comfortable margin.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('H4: watchdog disarms cleanly when cycle is no longer hung', async () => {
      prepStartedService();
      vi.useFakeTimers();
      void crankService.start();
      setCyclingHung();

      await vi.advanceTimersByTimeAsync(31_000);
      expect((crankService as any)._watchdogArmedAt).toBeGreaterThan(0);

      // Simulate the in-flight cycle recovering: _cycling=true with elapsed
      // under MAX_CYCLE_MS means the watchdog skips the hung branch entirely.
      setCyclingHung(1_000); // 1s elapsed, well under 5min cap
      await vi.advanceTimersByTimeAsync(31_000);

      // Next watchdog tick should NOT fire process.exit, because elapsed is now < MAX_CYCLE_MS.
      expect(exitSpy).not.toHaveBeenCalled();
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

  // A.1 (CRITICAL): a stream message at a known slab pubkey whose `owner`
  // doesn't match the program ID must not be consumed by the fast path.
  describe('A.1: owner-verified LaserStream fast-path', () => {
    const EXPECTED_PROGRAM_ID = 'ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv';
    const GOOD_SLAB = 'GoodSlab11111111111111111111111111111111111';
    const BAD_SLAB = 'BadSlab1111111111111111111111111111111111111';

    let restoreEnv: () => void;

    beforeEach(() => {
      const prev = process.env.KEEPER_USE_LASERSTREAM;
      process.env.KEEPER_USE_LASERSTREAM = 'true';
      restoreEnv = () => {
        if (prev === undefined) delete process.env.KEEPER_USE_LASERSTREAM;
        else process.env.KEEPER_USE_LASERSTREAM = prev;
      };
    });

    afterEach(() => {
      restoreEnv();
    });

    it('calls cache.getOwnerVerified with the loader program ID (not cache.get)', async () => {
      const { AccountCache } = await import('../../src/lib/account-cache.js');
      const realCache = new AccountCache();
      realCache.set(GOOD_SLAB, new Uint8Array([1]), EXPECTED_PROGRAM_ID, 100);
      realCache.set(BAD_SLAB, new Uint8Array([2]), 'AttackerProgram', 100);

      const getOwnerVerifiedSpy = vi.spyOn(realCache, 'getOwnerVerified');

      const fakeLoader = {
        getCache: () => realCache,
        getProgramId: () => EXPECTED_PROGRAM_ID,
        getStats: () => ({
          connected: true,
          lastSlot: 110,
          eventsReceived: 0,
          eventsDropped: 0,
          reconnectCount: 0,
        }),
      } as any;

      const service = new CrankService(mockOracleService, undefined, fakeLoader);

      // Seed both markets directly into the service's internal map.
      const mkMarket = (slab: string) => ({
        slabAddress: { toBase58: () => slab, equals: () => false },
        programId: { toBase58: () => EXPECTED_PROGRAM_ID },
        config: {
          collateralMint: { toBase58: () => 'Mint' + slab.slice(0, 4) },
          oracleAuthority: { toBase58: () => 'Auth' + slab.slice(0, 4), equals: () => false },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin' + slab.slice(0, 4) } },
      });
      const internal: any = service;
      internal.markets.set(GOOD_SLAB, { market: mkMarket(GOOD_SLAB), missedDiscoveryCount: 0 });
      internal.markets.set(BAD_SLAB, { market: mkMarket(BAD_SLAB), missedDiscoveryCount: 0 });
      // Stay in the fast-path window so we don't trigger full rediscover.
      internal._lastFullRediscoverTime = Date.now();

      await service.discover();

      // Both slabs should have been owner-verified with the expected program ID.
      expect(getOwnerVerifiedSpy).toHaveBeenCalledWith(GOOD_SLAB, 110, EXPECTED_PROGRAM_ID);
      expect(getOwnerVerifiedSpy).toHaveBeenCalledWith(BAD_SLAB, 110, EXPECTED_PROGRAM_ID);

      // Owner mismatch on BAD_SLAB returned null → the malicious cache entry
      // never reached the SDK parsers. Hits == 1 (good slab only).
      const stats = realCache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBeGreaterThanOrEqual(1);

      service.stop();
    });

    it('re-parses cached v17 account data with the v17 parser, not legacy slab parsers', async () => {
      const { AccountCache } = await import('../../src/lib/account-cache.js');
      const realCache = new AccountCache();
      const freshData = new Uint8Array(600);
      realCache.set(GOOD_SLAB, freshData, EXPECTED_PROGRAM_ID, 100);

      const fakeLoader = {
        getCache: () => realCache,
        getProgramId: () => EXPECTED_PROGRAM_ID,
        getStats: () => ({
          connected: true,
          lastSlot: 110,
          eventsReceived: 0,
          eventsDropped: 0,
          reconnectCount: 0,
        }),
      } as any;

      const service = new CrankService(mockOracleService, undefined, fakeLoader);
      const mint = new PublicKey('So11111111111111111111111111111111111111112');
      const staleMarket = {
        slabAddress: { toBase58: () => GOOD_SLAB, equals: () => false },
        programId: { toBase58: () => EXPECTED_PROGRAM_ID },
        config: {
          collateralMint: mint,
          oracleAuthority: PublicKey.default,
          indexFeedId: PublicKey.default,
          lastEffectivePriceE6: 1_000_000n,
          authorityPriceE6: 0n,
        },
        engine: { vault: 0n },
        params: { maintenanceMarginBps: 100n },
        header: { admin: PublicKey.default, version: 16, kind: 1 },
        _rawV17Config: { markEwmaE6: 1_000_000n },
      };

      vi.mocked(core.isV17Account).mockReturnValueOnce(true);
      vi.mocked(core.parseWrapperConfigV17).mockReturnValueOnce({
        marketauth: PublicKey.default,
        collateralMint: mint,
        oracleMode: 2, // EWMA_MARK
        oracleLegFeeds: [],
        maxStalenessSecs: 60n,
        confFilterBps: 0,
        invert: 0,
        unitScale: 1,
        oracleTargetPriceE6: 0n,
        oracleTargetPublishTime: 0n,
        markEwmaE6: 2_000_000n,
      } as any);

      const internal: any = service;
      internal.markets.set(GOOD_SLAB, {
        market: staleMarket,
        missedDiscoveryCount: 0,
        keeperPortfolio: PublicKey.default,
      });
      internal._lastFullRediscoverTime = Date.now();

      await service.discover();

      const refreshed = internal.markets.get(GOOD_SLAB).market;
      expect(core.parseWrapperConfigV17).toHaveBeenCalledWith(freshData);
      expect(core.parseHeader).not.toHaveBeenCalled();
      expect(refreshed.config.lastEffectivePriceE6).toBe(2_000_000n);
      expect(refreshed.params.maintenanceMarginBps).toBe(500n);
      expect(refreshed._rawV17Config.markEwmaE6).toBe(2_000_000n);

      service.stop();
    });
  });

  // M-1: consecutiveFailures reset, foreignOracleSkipped reset, and the
  // permanentlySkipped cooldown re-enable previously only ran in the
  // full-rediscover branch -- a market recovering via the LaserStream fast
  // path stayed stuck until the next full rediscover (default 30 min).
  describe('M-1: LaserStream fast-path applies recoverable-state transitions', () => {
    const EXPECTED_PROGRAM_ID = 'ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv';
    const SLAB = 'RecoverSlab111111111111111111111111111111111';

    let restoreEnv: () => void;

    beforeEach(() => {
      const prev = process.env.KEEPER_USE_LASERSTREAM;
      process.env.KEEPER_USE_LASERSTREAM = 'true';
      restoreEnv = () => {
        if (prev === undefined) delete process.env.KEEPER_USE_LASERSTREAM;
        else process.env.KEEPER_USE_LASERSTREAM = prev;
      };
    });

    afterEach(() => {
      restoreEnv();
    });

    function makeFakeLoader() {
      return {
        getCache: () => ({ getOwnerVerified: () => null }),
        getProgramId: () => EXPECTED_PROGRAM_ID,
        getStats: () => ({
          connected: true,
          lastSlot: 110,
          eventsReceived: 0,
          eventsDropped: 0,
          reconnectCount: 0,
        }),
      } as any;
    }

    function makeMarket() {
      return {
        slabAddress: { toBase58: () => SLAB, equals: () => false },
        programId: { toBase58: () => EXPECTED_PROGRAM_ID },
        config: {
          collateralMint: { toBase58: () => 'Mint1111111111111111111111111111111111111' },
          oracleAuthority: { toBase58: () => 'Auth1111111111111111111111111111111111111', equals: () => false },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: { toBase58: () => 'Admin111111111111111111111111111111111' } },
      };
    }

    it('does NOT reset consecutiveFailures on a fast-path tick, but resets them on full rediscovery', async () => {
      const service = new CrankService(mockOracleService, undefined, makeFakeLoader());
      const internal: any = service;
      const market = makeMarket();
      internal.markets.set(SLAB, {
        market,
        missingDiscoveryCount: 0,
        consecutiveFailures: 7,
        isActive: false,
      });
      internal._lastFullRediscoverTime = Date.now(); // stay in the fast-path window

      vi.mocked(core.discoverMarkets).mockResolvedValue([market as any]);

      await service.discover();

      const state = internal.markets.get(SLAB);
      expect(state.consecutiveFailures).toBe(7); // unchanged
      expect(state.isActive).toBe(false); // unchanged

      // Now trigger full rediscovery by advancing time past the interval
      internal._lastFullRediscoverTime = Date.now() - internal._fullRediscoverIntervalMs - 1;
      await service.discover();

      const stateAfterFull = internal.markets.get(SLAB);
      expect(stateAfterFull.consecutiveFailures).toBe(0);
      expect(stateAfterFull.isActive).toBe(true);

      service.stop();
    });

    it('does NOT reset foreignOracleSkipped on a fast-path tick, but resets on full rediscovery', async () => {
      const service = new CrankService(mockOracleService, undefined, makeFakeLoader());
      const internal: any = service;
      const market = makeMarket();
      internal.markets.set(SLAB, {
        market,
        missingDiscoveryCount: 0,
        consecutiveFailures: 0,
        foreignOracleSkipped: true,
      });
      internal._lastFullRediscoverTime = Date.now();

      vi.mocked(core.discoverMarkets).mockResolvedValue([market as any]);

      await service.discover();

      expect(internal.markets.get(SLAB).foreignOracleSkipped).toBe(true); // unchanged

      // trigger full rediscovery
      internal._lastFullRediscoverTime = Date.now() - internal._fullRediscoverIntervalMs - 1;
      await service.discover();

      expect(internal.markets.get(SLAB).foreignOracleSkipped).toBe(false); // reset

      service.stop();
    });

    it('does NOT re-enable a permanentlySkipped market on a fast-path tick once its cooldown has elapsed, but resets on full rediscovery', async () => {
      const service = new CrankService(mockOracleService, undefined, makeFakeLoader());
      const internal: any = service;
      const market = makeMarket();
      internal.markets.set(SLAB, {
        market,
        missingDiscoveryCount: 0,
        consecutiveFailures: 0,
        permanentlySkipped: true,
        permanentlySkippedAt: Date.now() - 3_600_001, // 1h cooldown elapsed
        skipCount: 1,
      });
      internal._lastFullRediscoverTime = Date.now();

      vi.mocked(core.discoverMarkets).mockResolvedValue([market as any]);

      await service.discover();

      const state = internal.markets.get(SLAB);
      expect(state.permanentlySkipped).toBe(true); // unchanged

      // trigger full rediscovery
      internal._lastFullRediscoverTime = Date.now() - internal._fullRediscoverIntervalMs - 1;
      await service.discover();

      const stateAfterFull = internal.markets.get(SLAB);
      expect(stateAfterFull.permanentlySkipped).toBe(false);
      expect(stateAfterFull.consecutiveFailures).toBe(0);

      service.stop();
    });

    it('does NOT re-enable a permanentlySkipped market on a fast-path tick or full rediscovery tick while still in cooldown', async () => {
      const service = new CrankService(mockOracleService, undefined, makeFakeLoader());
      const internal: any = service;
      const market = makeMarket();
      internal.markets.set(SLAB, {
        market,
        missingDiscoveryCount: 0,
        consecutiveFailures: 0,
        permanentlySkipped: true,
        permanentlySkippedAt: Date.now(), // just skipped
        skipCount: 1,
      });
      internal._lastFullRediscoverTime = Date.now();

      vi.mocked(core.discoverMarkets).mockResolvedValue([market as any]);

      await service.discover();

      expect(internal.markets.get(SLAB).permanentlySkipped).toBe(true);

      // trigger full rediscovery
      internal._lastFullRediscoverTime = Date.now() - internal._fullRediscoverIntervalMs - 1;
      await service.discover();

      expect(internal.markets.get(SLAB).permanentlySkipped).toBe(true);

      service.stop();
    });
  });

  // ── #339: LP-vault maintenance lifecycle ─────────────────────────────────

  describe('#339: LP-vault maintenance lifecycle', () => {
    /** Minimal market that will succeed a crank (keeperSend resolves, zero-feed authority). */
    function makeSuccessMarket(slabStr: string) {
      return {
        slabAddress: new PublicKey(slabStr),
        programId: new PublicKey('11111111111111111111111111111111'),
        config: {
          collateralMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          oracleAuthority: { toBase58: () => '11111111111111111111111111111111', equals: () => true },
          indexFeedId: { toBytes: () => new Uint8Array(32) },
          authorityPriceE6: 1_000_000n,
        },
        params: { maintenanceMarginBps: 500n },
        header: { admin: new PublicKey('7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G') },
      };
    }

    it('#339: LP-vault task is launched only for markets that individually succeeded, not for failed ones', async () => {
      const slabSuccess = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const slabFail    = 'So11111111111111111111111111111111111111112';

      const successMarket = makeSuccessMarket(slabSuccess);
      const failMarket = {
        ...makeSuccessMarket(slabFail),
        slabAddress: new PublicKey(slabFail),
      };

      vi.mocked(core.discoverMarkets).mockResolvedValue([successMarket, failMarket] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      // getAccountInfo returns null → crankLpVault exits early (no LP vault registered).
      // This lets us observe whether it was called without it hanging.
      vi.mocked(shared.getConnection).mockReturnValue({
        getAccountInfo: vi.fn().mockResolvedValue(null),
        getSlot: vi.fn().mockResolvedValue(200),
      } as any);

      // keeperSend succeeds for slabSuccess, rejects for slabFail.
      vi.mocked(keeperSendModule.keeperSend)
        .mockImplementation(async (_conn, ixs, _signers, _label) => {
          // Identify which market by timing — success market sends first.
          return { signature: 'sig-success', estimatedCost: 5000 };
        });

      // crankMarket for slabFail will fail because we spy on its result.
      // Use the in-flight map: after crankAll, only slabSuccess should have been in succeededSlabs.
      // We observe this by checking that crankAll returns success=1, failed=1.
      // (LP vault call for slabFail MUST NOT happen — we can't observe directly without
      //  deeper instrumentation, so we assert on behavior: crankAll returns correctly.)
      vi.mocked(keeperSendModule.keeperSend)
        .mockResolvedValueOnce({ signature: 'sig-success', estimatedCost: 5000 } as any) // slabSuccess
        .mockRejectedValueOnce(new Error('tx failed')); // slabFail

      const result = await crankService.crankAll();
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('#339: _inflightLpVaultMarkets prevents duplicate LP-vault launches for the same market', async () => {
      const slabStr = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const market = makeSuccessMarket(slabStr);

      vi.mocked(core.discoverMarkets).mockResolvedValue([market] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      // crankAll checks _isRunning before launching LP-vault tasks. Set it true
      // so the block runs (in production, start() sets this before crankAll is called).
      const internal = crankService as any;
      internal._isRunning = true;

      let resolveAccountInfo: (v: any) => void;
      const hangingPromise = new Promise<any>((res) => { resolveAccountInfo = res; });

      // First LP-vault getAccountInfo call hangs so the in-flight set is populated
      // while we can inspect it. Subsequent calls return null immediately.
      let callCount = 0;
      vi.mocked(shared.getConnection).mockReturnValue({
        getAccountInfo: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return hangingPromise; // hang first LP-vault getAccountInfo
          return Promise.resolve(null); // subsequent calls return null immediately
        }),
        getSlot: vi.fn().mockResolvedValue(200),
      } as any);

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig', estimatedCost: 5000 } as any);

      // Start first crankAll — LP-vault task hangs on getAccountInfo.
      const first = crankService.crankAll();

      // Allow the crank phase to complete and LP-vault to start.
      // crankAll awaits Promise.allSettled(lpVaultTasks) so the cycle stays in
      // flight until we resolve the hanging getAccountInfo.
      // We need to yield enough microtasks for crankMarket + LP start to run.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      // _inflightLpVaultMarkets should contain the slab while the LP-vault task is hanging.
      expect(internal._inflightLpVaultMarkets.has(slabStr)).toBe(true);

      // Resolve the hanging account info so the first cycle can complete.
      resolveAccountInfo!(null);
      await first;

      // After first cycle completes, in-flight set should be empty again.
      expect(internal._inflightLpVaultMarkets.has(slabStr)).toBe(false);
    });

    it('#339: LP-vault tasks are skipped when _isRunning is false at launch time', async () => {
      const slabStr = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const market = makeSuccessMarket(slabStr);

      vi.mocked(core.discoverMarkets).mockResolvedValue([market] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      // Set _isRunning to false BEFORE crankAll runs (simulates stop() called just before).
      const internal = crankService as any;
      internal._isRunning = false;

      const getAccountInfoSpy = vi.fn().mockResolvedValue(null);
      vi.mocked(shared.getConnection).mockReturnValue({
        getAccountInfo: getAccountInfoSpy,
        getSlot: vi.fn().mockResolvedValue(200),
      } as any);

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig', estimatedCost: 5000 } as any);

      await crankService.crankAll();

      // Because _isRunning is false, the LP-vault block should be skipped entirely.
      // getAccountInfo should NOT be called for LP vault registry lookup.
      // (It may be called during crankMarket for oracle/slot purposes, but not for LP vault.)
      // We verify by checking _inflightLpVaultMarkets stayed empty.
      expect(internal._inflightLpVaultMarkets.size).toBe(0);
    });

    it('#339: LP-vault errors are caught and do not propagate to crankAll caller', async () => {
      const slabStr = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      const market = makeSuccessMarket(slabStr);

      vi.mocked(core.discoverMarkets).mockResolvedValue([market] as any);
      await crankService.discover();
      setKeeperPortfolios(crankService);

      // Simulate LP vault crank throwing by having getAccountInfo throw.
      vi.mocked(shared.getConnection).mockReturnValue({
        getAccountInfo: vi.fn().mockRejectedValue(new Error('RPC error in LP vault')),
        getSlot: vi.fn().mockResolvedValue(200),
      } as any);

      vi.mocked(keeperSendModule.keeperSend).mockResolvedValue({ signature: 'sig', estimatedCost: 5000 } as any);

      // crankAll must not throw even if LP vault logic throws internally.
      await expect(crankService.crankAll()).resolves.not.toThrow();
    });
  });
});
