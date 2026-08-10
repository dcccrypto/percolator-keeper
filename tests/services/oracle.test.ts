import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

// Mock fetch globally
global.fetch = vi.fn();

// Mock external dependencies
vi.mock('@percolatorct/sdk', () => ({
  encodePushOraclePrice: vi.fn(() => Buffer.from([1, 2, 3])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock('@percolatorct/shared', () => {
  const makeMonitor = () => ({
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    getErrorRate: vi.fn(() => 0),
    getStatus: vi.fn(() => ({ healthy: true, consecutiveFailures: 0, errorRate: 0, timeSinceSuccessMs: 0, alertActive: false })),
  });
  return {
    config: {
      programId: '11111111111111111111111111111111',
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
    loadKeypair: vi.fn(() => ({
      publicKey: new PublicKey('11111111111111111111111111111111'),
      secretKey: new Uint8Array(64),
    })),
    sendWithRetry: vi.fn(async () => 'mock-signature'),
    eventBus: {
      publish: vi.fn(),
    },
    getErrorMessage: vi.fn((err: unknown) => {
      if (err instanceof Error) return err.message;
      return String(err);
    }),
    sendWarningAlert: vi.fn(),
    sendCriticalAlert: vi.fn(),
    // BUG-110: src/lib/service-monitors.ts calls this at import time.
    createServiceMonitors: vi.fn(() => ({
      rpc: makeMonitor(),
      scan: makeMonitor(),
      oracle: makeMonitor(),
      db: makeMonitor(),
    })),
  };
});

import { OracleService } from '../../src/services/oracle.js';
import * as shared from '@percolatorct/shared';
import { monitors } from '../../src/lib/service-monitors.js';

describe('OracleService', () => {
  let oracleService: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    oracleService = new OracleService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchDexScreenerPrice', () => {
    it('should fetch and parse DexScreener price', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: '1.23',
            liquidity: { usd: 100000 },
            baseToken: { address: 'MINT_UNIQUE_1' },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchDexScreenerPrice('MINT_UNIQUE_1');

      expect(price).toBe(1_230_000n); // 1.23 * 1_000_000
      expect(fetch).toHaveBeenCalledWith(
        'https://api.dexscreener.com/latest/dex/tokens/MINT_UNIQUE_1',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return null on fetch error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      const price = await oracleService.fetchDexScreenerPrice('MINT_ERROR');

      expect(price).toBeNull();
    });

    it('should return null for invalid price data', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: 'invalid',
            liquidity: { usd: 100000 },
            baseToken: { address: 'MINT_INVALID' },
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchDexScreenerPrice('MINT_INVALID');

      expect(price).toBeNull();
    });

    it('should handle timeout with AbortController', async () => {
      vi.mocked(fetch).mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

      const price = await oracleService.fetchDexScreenerPrice('MINT_TIMEOUT');

      expect(price).toBeNull();
    });

    // BUG-110: monitors.oracle was never wired to a real outcome -- /health's
    // monitors.oracle sub-object was permanently-green placeholder data.
    it('BUG-110: records monitors.oracle success on a reachable fetch', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pairs: [{ priceUsd: '1.23', liquidity: { usd: 100000 } }] }),
      } as any);

      await oracleService.fetchDexScreenerPrice('MINT_MONITOR_OK');

      expect(monitors.oracle.recordSuccess).toHaveBeenCalledTimes(1);
      expect(monitors.oracle.recordFailure).not.toHaveBeenCalled();
    });

    it('BUG-110: records monitors.oracle failure on a network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      await oracleService.fetchDexScreenerPrice('MINT_MONITOR_FAIL');

      expect(monitors.oracle.recordFailure).toHaveBeenCalledTimes(1);
      expect(monitors.oracle.recordSuccess).not.toHaveBeenCalled();
    });

    it('BUG-110: records monitors.oracle failure on a non-ok HTTP response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as any);

      await oracleService.fetchDexScreenerPrice('MINT_MONITOR_429');

      expect(monitors.oracle.recordFailure).toHaveBeenCalledWith('DexScreener HTTP 429');
      expect(monitors.oracle.recordSuccess).not.toHaveBeenCalled();
    });
  });

  describe('DexScreener cache', () => {
    it('should cache responses and return cached value within TTL', async () => {
      const mockResponse = {
        pairs: [
          {
            priceUsd: '2.50',
            liquidity: { usd: 200000 },
            baseToken: { address: 'MINT_CACHE_TEST' },
          },
        ],
      };

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        return { ok: true, json: async () => mockResponse } as any;
      });

      // First call - should fetch
      const price1 = await oracleService.fetchDexScreenerPrice('MINT_CACHE_TEST');
      
      // Second call within TTL - should use cache
      const price2 = await oracleService.fetchDexScreenerPrice('MINT_CACHE_TEST');
      
      expect(callCount).toBe(1); // Should only fetch once
      expect(price1).toBe(price2);
    });

    it('should refetch after cache TTL expires', async () => {
      const mockResponse1 = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 }, baseToken: { address: 'MINT_TTL_TEST' } }],
      };
      const mockResponse2 = {
        pairs: [{ priceUsd: '2.00', liquidity: { usd: 200000 }, baseToken: { address: 'MINT_TTL_TEST' } }],
      };

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => mockResponse1 } as any;
        }
        return { ok: true, json: async () => mockResponse2 } as any;
      });

      // First call
      const price1 = await oracleService.fetchDexScreenerPrice('MINT_TTL_TEST');
      expect(price1).toBe(1_000_000n);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 11_000));

      // Second call - should refetch
      const price2 = await oracleService.fetchDexScreenerPrice('MINT_TTL_TEST');
      expect(price2).toBe(2_000_000n);
      expect(callCount).toBe(2);
    }, 15000);
  });

  describe('fetchJupiterPrice', () => {
    it('should fetch and parse Jupiter price', async () => {
      const mintId = 'MINT_JUP_TEST';
      const mockResponse = {
        data: {
          [mintId]: { price: '5.67' },
        },
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const price = await oracleService.fetchJupiterPrice(mintId);

      expect(price).toBe(5_670_000n); // 5.67 * 1_000_000
      expect(fetch).toHaveBeenCalledWith(
        `https://api.jup.ag/price/v2?ids=${mintId}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return null on fetch error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('API error'));

      const price = await oracleService.fetchJupiterPrice('MINT_JUP_ERROR');

      expect(price).toBeNull();
    });
  });

  describe('cross-source deviation check', () => {
    it('should reject prices with >10% divergence between sources', async () => {
      // DexScreener: $1.00
      const dexResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 }, baseToken: { address: 'MINT999' } }],
      };

      // Jupiter: $1.50 (50% divergence)
      const jupResponse = {
        data: {
          MINT999: { price: '1.50' },
        },
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, json: async () => dexResponse } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => jupResponse } as any);

      const priceEntry = await oracleService.peekPrice('MINT999');

      expect(priceEntry).toBeNull(); // Rejected due to divergence
    });

    it('should accept prices with <10% divergence', async () => {
      // DexScreener: $1.00
      const dexResponse = {
        pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 }, baseToken: { address: 'MINT888' } }],
      };

      // Jupiter: $1.05 (5% divergence)
      const jupResponse = {
        data: {
          MINT888: { price: '1.05' },
        },
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, json: async () => dexResponse } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => jupResponse } as any);

      const priceEntry = await oracleService.peekPrice('MINT888');

      expect(priceEntry).not.toBeNull();
      expect(priceEntry?.priceE6).toBe(1_000_000n); // Uses DexScreener (preferred)
    });
  });

  // Rate-limiting tests for pushPrice were removed after Phase G — admin-push
  // oracle is no longer a keeper responsibility. Pyth/Chainlink handle their
  // own rate limits upstream and Hyperp reads the DEX directly.

  // M6: dual-source outage circuit breaker.
  describe('in-flight request deduplication', () => {
    it('should deduplicate concurrent DexScreener requests', async () => {
      const mockResponse = {
        pairs: [{ priceUsd: '3.14', liquidity: { usd: 100000 }, baseToken: { address: 'MINT_DEDUP' } }],
      };

      let fetchCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        fetchCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { ok: true, json: async () => mockResponse } as any;
      });

      // Make concurrent requests
      const promises = [
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
        oracleService.fetchDexScreenerPrice('MINT_DEDUP'),
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // But fetch should only be called once
      expect(fetchCount).toBe(1);
    });

    it('should deduplicate concurrent Jupiter requests', async () => {
      const mockResponse = {
        data: { MINT_JUP_DEDUP: { price: '2.71' } },
      };

      let fetchCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        fetchCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { ok: true, json: async () => mockResponse } as any;
      });

      // Make concurrent requests
      const promises = [
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
        oracleService.fetchJupiterPrice('MINT_JUP_DEDUP'),
      ];

      const results = await Promise.all(promises);

      // All should get the same result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // But fetch should only be called once
      expect(fetchCount).toBe(1);
    });
  });

});
