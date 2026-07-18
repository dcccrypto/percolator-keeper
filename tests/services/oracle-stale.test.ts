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

vi.mock('@percolatorct/shared', () => ({
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
  sendWarningAlert: vi.fn(() => Promise.resolve()),
}));

import { OracleService } from '../../src/services/oracle.js';

/**
 * Staleness is now measured from the last successful EXTERNAL price fetch
 * (lastExternalPriceMs), set by fetchPrice(). These tests use an injected clock
 * so "becomes stale after N minutes" is deterministic, and assert the corrected
 * behavior: a freshly-fetched market is NOT stale; a market with no fresh fetch
 * for longer than the threshold IS stale.
 */
describe('OracleService.getStaleMarkets', () => {
  let clock: number;
  let oracle: OracleService;

  // URL-based fetch mock: both sources return $1.00 for any mint. Routing on the
  // URL (rather than a mockResolvedValueOnce queue) keeps the mock robust against
  // the module-level DexScreener cache, which can serve a repeated mint without a
  // fetch call and would otherwise desync an ordered once-queue.
  beforeEach(() => {
    vi.clearAllMocks();
    clock = 1_700_000_000_000;
    oracle = new OracleService({ now: () => clock });
    vi.mocked(fetch).mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes('dexscreener')) {
        // Thread the queried mint out of the request URL so the fixture's
        // baseToken always matches whichever mint is being fetched (MINT_A,
        // MINT_C, MINT_E, MINT_X, MINT_Y, ...).
        const dexMint = decodeURIComponent(url.split('/tokens/')[1] ?? '');
        return { ok: true, json: async () => ({ pairs: [{ priceUsd: '1.00', liquidity: { usd: 100000 }, baseToken: { address: dexMint } }] }) } as any;
      }
      const mint = decodeURIComponent(url.split('ids=')[1] ?? '');
      return { ok: true, json: async () => ({ data: { [mint]: { price: '1.00' } } }) } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Seed a fresh, cross-validated external price for `slab` via fetchPrice. */
  async function seedFreshPrice(mint: string, slab: string) {
    await oracle.fetchPrice(mint, slab);
  }

  it('should return empty array when no markets are tracked', () => {
    expect(oracle.getStaleMarkets(5 * 60 * 1000)).toEqual([]);
  });

  it('does NOT flag a market whose price was just fetched', async () => {
    await seedFreshPrice('MINT_A', 'SLAB_A');
    expect(oracle.getStaleMarkets(10 * 60 * 1000)).not.toContain('SLAB_A');
    expect(oracle.getStaleMarkets(5 * 60 * 1000)).not.toContain('SLAB_A');
  });

  it('flags a market once its last fresh fetch is older than the threshold', async () => {
    await seedFreshPrice('MINT_A', 'SLAB_A'); // fresh at t0
    clock += 11 * 60 * 1000; // 11 minutes later
    expect(oracle.getStaleMarkets(10 * 60 * 1000)).toContain('SLAB_A');
  });

  it('distinguishes the 5-min alert threshold from the 10-min pause threshold', async () => {
    await seedFreshPrice('MINT_C', 'SLAB_C'); // fresh at t0
    clock += 6 * 60 * 1000; // 6 minutes later

    // Older than the 5-min alert threshold...
    expect(oracle.getStaleMarkets(5 * 60 * 1000)).toContain('SLAB_C');
    // ...but younger than the 10-min pause threshold.
    expect(oracle.getStaleMarkets(10 * 60 * 1000)).not.toContain('SLAB_C');
  });

  it('recovers a market on a fresh fetch (unpause path)', async () => {
    await seedFreshPrice('MINT_E', 'SLAB_E');
    clock += 11 * 60 * 1000;
    expect(oracle.getStaleMarkets(10 * 60 * 1000)).toContain('SLAB_E'); // stale

    await seedFreshPrice('MINT_E', 'SLAB_E'); // fresh again at the advanced clock
    expect(oracle.getStaleMarkets(10 * 60 * 1000)).not.toContain('SLAB_E'); // recovered
  });

  it('reports multiple stale markets and only the stale ones', async () => {
    await seedFreshPrice('MINT_X', 'SLAB_X');
    await seedFreshPrice('MINT_Y', 'SLAB_Y');
    clock += 11 * 60 * 1000; // both stale now

    const allStale = oracle.getStaleMarkets(10 * 60 * 1000);
    expect(allStale).toContain('SLAB_X');
    expect(allStale).toContain('SLAB_Y');
    expect(allStale.length).toBe(2);

    // Refresh only X — Y stays stale.
    await seedFreshPrice('MINT_X', 'SLAB_X');
    const stillStale = oracle.getStaleMarkets(10 * 60 * 1000);
    expect(stillStale).not.toContain('SLAB_X');
    expect(stillStale).toContain('SLAB_Y');
    expect(stillStale.length).toBe(1);
  });
});
