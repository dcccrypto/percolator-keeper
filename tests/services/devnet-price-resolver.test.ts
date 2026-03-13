import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @percolator/shared ───────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

vi.mock('@percolator/shared', () => ({
  getSupabase: vi.fn(() => ({ from: mockFrom })),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { DevnetPriceResolver } from '../../src/services/devnet-price-resolver.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Helper: set up mockSelect to return devnet_mints then overrides. */
function mockSupabaseResponses(
  mintRows: Array<{ devnet_mint: string; mainnet_ca: string }>,
  overrideRows: Array<{ devnet_mint: string; price_usd: number }>,
): void {
  mockSelect
    .mockResolvedValueOnce({ data: mintRows, error: null })
    .mockResolvedValueOnce({ data: overrideRows, error: null });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DevnetPriceResolver', () => {
  let resolver: DevnetPriceResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new DevnetPriceResolver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resolver.stop();
    vi.useRealTimers();
  });

  describe('start() and initial load', () => {
    it('should load devnet_mints and overrides on start()', async () => {
      mockSupabaseResponses(
        [{ devnet_mint: 'DEVNET_MINT_1', mainnet_ca: 'MAINNET_CA_1' }],
        [{ devnet_mint: 'PURE_DEVNET_MINT', price_usd: 2.5 }],
      );

      await resolver.start();

      expect(resolver.getMainnetCa('DEVNET_MINT_1')).toBe('MAINNET_CA_1');
      expect(resolver.getStaticPrice('PURE_DEVNET_MINT')).toBe(2_500_000n);
      expect(resolver.initialized).toBe(true);
    });

    it('should return null for unknown mints after load', async () => {
      mockSupabaseResponses([], []);
      await resolver.start();

      expect(resolver.getMainnetCa('UNKNOWN_MINT')).toBeNull();
      expect(resolver.getStaticPrice('UNKNOWN_MINT')).toBeNull();
    });
  });

  describe('getMainnetCa()', () => {
    it('should return correct mainnet CA for a devnet mirror mint', async () => {
      mockSupabaseResponses(
        [
          { devnet_mint: 'DEVNET_A', mainnet_ca: 'MAINNET_A' },
          { devnet_mint: 'DEVNET_B', mainnet_ca: 'MAINNET_B' },
        ],
        [],
      );
      await resolver.start();

      expect(resolver.getMainnetCa('DEVNET_A')).toBe('MAINNET_A');
      expect(resolver.getMainnetCa('DEVNET_B')).toBe('MAINNET_B');
      expect(resolver.getMainnetCa('DEVNET_C')).toBeNull();
    });
  });

  describe('getStaticPrice()', () => {
    it('should return priceE6 for devnet-only token with $1 override', async () => {
      mockSupabaseResponses(
        [],
        [{ devnet_mint: 'PURE_TOKEN', price_usd: 1.0 }],
      );
      await resolver.start();

      expect(resolver.getStaticPrice('PURE_TOKEN')).toBe(1_000_000n);
    });

    it('should return priceE6 correctly for fractional USD prices', async () => {
      mockSupabaseResponses(
        [],
        [{ devnet_mint: 'FRAC_TOKEN', price_usd: 0.000123 }],
      );
      await resolver.start();

      // 0.000123 * 1_000_000 = 123
      expect(resolver.getStaticPrice('FRAC_TOKEN')).toBe(123n);
    });

    it('should ignore entries with price_usd = 0 or negative', async () => {
      mockSupabaseResponses(
        [],
        [
          { devnet_mint: 'ZERO_TOKEN', price_usd: 0 },
          { devnet_mint: 'NEG_TOKEN', price_usd: -1 },
        ],
      );
      await resolver.start();

      expect(resolver.getStaticPrice('ZERO_TOKEN')).toBeNull();
      expect(resolver.getStaticPrice('NEG_TOKEN')).toBeNull();
    });
  });

  describe('background refresh', () => {
    it('should refresh data after REFRESH_INTERVAL_MS (5min)', async () => {
      // Initial load: DEVNET_A → MAINNET_A
      mockSupabaseResponses(
        [{ devnet_mint: 'DEVNET_A', mainnet_ca: 'MAINNET_A' }],
        [],
      );
      await resolver.start();
      expect(resolver.getMainnetCa('DEVNET_A')).toBe('MAINNET_A');

      // Second load (refresh): DEVNET_A → MAINNET_A_V2
      mockSupabaseResponses(
        [{ devnet_mint: 'DEVNET_A', mainnet_ca: 'MAINNET_A_V2' }],
        [],
      );

      // Advance timer by 5 minutes to trigger refresh
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(resolver.getMainnetCa('DEVNET_A')).toBe('MAINNET_A_V2');
    });
  });

  describe('Supabase error handling', () => {
    it('should keep stale data when devnet_mints query fails', async () => {
      // First load OK
      mockSupabaseResponses(
        [{ devnet_mint: 'DEVNET_A', mainnet_ca: 'MAINNET_A' }],
        [],
      );
      await resolver.start();

      // Second load: devnet_mints errors, overrides OK
      mockSelect
        .mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })
        .mockResolvedValueOnce({ data: [], error: null });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      // Stale data retained — still resolves
      expect(resolver.getMainnetCa('DEVNET_A')).toBe('MAINNET_A');
    });

    it('should handle missing devnet_price_overrides table gracefully', async () => {
      mockSelect
        .mockResolvedValueOnce({ data: [], error: null }) // mints OK
        .mockResolvedValueOnce({                          // overrides table missing
          data: null,
          error: { message: 'relation "devnet_price_overrides" does not exist' },
        });

      // Should not throw
      await expect(resolver.start()).resolves.not.toThrow();
      expect(resolver.initialized).toBe(true);
    });
  });

  describe('stop()', () => {
    it('should stop background refresh timer', async () => {
      mockSupabaseResponses([], []);
      await resolver.start();

      resolver.stop();

      // Advance past refresh interval — no new Supabase calls expected
      mockSelect.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(mockSelect).not.toHaveBeenCalled();
    });
  });
});
