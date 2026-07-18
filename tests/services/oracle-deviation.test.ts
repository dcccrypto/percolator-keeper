/**
 * oracle-deviation.test.ts
 *
 * Comprehensive HYPERP vs Pyth price deviation test suite.
 *
 * Tests four layers:
 *   1. Cross-source deviation (DexScreener vs Jupiter) — actual boundary per integer BigInt math
 *   2. Historical deviation (price jump guard)
 *   3. Admin-oracle / pumpswap price computation (GH#1376 regression)
 *   4. HYPERP vs Pyth end-to-end scenario table
 *
 * Key implementation detail:
 *   The divergence check uses basis-point precision (10_000n multiplier)
 *   to avoid integer truncation:
 *     divergenceBps = Number((larger - smaller) * 10_000n / smaller)
 *   So:
 *     10.00% divergence → 1000 bps → NOT > 1000 → ACCEPTED
 *     10.01% divergence → 1001 bps → IS > 1000 → REJECTED
 *     11.00% divergence → 1100 bps → IS > 1000 → REJECTED
 *   Effective rejection threshold is >10.00%.
 *
 * All tests use mocked fetch — no live network required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

global.fetch = vi.fn();

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
  getConnection: vi.fn(() => ({ getAccountInfo: vi.fn() })),
  loadKeypair: vi.fn(() => ({
    publicKey: new PublicKey('11111111111111111111111111111111'),
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => 'mock-sig'),
  eventBus: { publish: vi.fn() },
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

import { OracleService } from '../../src/services/oracle.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a unique mint name per test to avoid module-level dexScreenerCache pollution. */
let mintCounter = 0;
function freshMint(): string {
  return `MINT_${++mintCounter}_${Date.now()}`;
}

function freshSlab(): string {
  return `SLAB_${++mintCounter}_${Date.now()}`;
}

function mockBothSources(dexUsd: number | null, jupUsd: number | null, mint?: string) {
  const jupKey = mint ?? `MINT_${mintCounter}`;
  const dexResp = dexUsd !== null && dexUsd > 0
    ? { pairs: [{ priceUsd: String(dexUsd), liquidity: { usd: 500_000 }, baseToken: { address: jupKey } }] }
    : { pairs: [] };

  const jupResp = jupUsd !== null && jupUsd > 0
    ? { data: { [jupKey]: { price: String(jupUsd) } } }
    : { data: {} };

  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: true, json: async () => dexResp } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => jupResp } as Response);
}

function toE6(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

// ─── 1. Cross-source deviation boundary tests ─────────────────────────────────
//
// Deviation is computed in basis points (10_000n multiplier) for precise comparison.
// Effective rejection point: divergenceBps > 1000 (i.e. >10.00%).

describe('Cross-source deviation — actual boundary conditions', () => {
  let svc: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });

  it('0% divergence — accepted', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.00, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.priceE6).toBe(toE6(1.00));
  });

  it('5% divergence — accepted', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.05, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('dexscreener');
  });

  it('10% divergence — ACCEPTED (exactly 1000 bps, not > 1000)', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.10, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
  });

  it('10.5% divergence — REJECTED (1050 bps > 1000)', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.105, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull();
  });

  it('11% divergence — REJECTED (1100 bps > 1000)', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.11, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull();
  });

  it('50% divergence (flash crash simulation) — REJECTED', async () => {
    const mint = freshMint();
    mockBothSources(0.60, 0.90, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull();
  });

  it('raw reserve bug magnitude (GH#1376): 454074x divergence — REJECTED', async () => {
    // Simulates keeper sending SOL pool reserve as price vs correct USD price
    // 454_074 vs 0.000919 is astronomically large
    const mint = freshMint();
    mockBothSources(0.000919, 454_074.93, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull(); // cross-source check catches this if both sources run
  });

  it('inverted: Jupiter higher than DexScreener by 15% — REJECTED', async () => {
    const mint = freshMint();
    mockBothSources(0.89, 1.00, mint); // 12.4% divergence → integer 12 > 10
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull();
  });

  it('DexScreener null → falls back to Jupiter, no cross-check', async () => {
    const mint = freshMint();
    mockBothSources(null, 0.000919, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('jupiter');
    expect(r!.priceE6).toBe(919n);
  });

  it('Jupiter null → uses DexScreener only', async () => {
    const mint = freshMint();
    mockBothSources(150.00, null, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('dexscreener');
  });

  it('both null → returns null', async () => {
    const mint = freshMint();
    mockBothSources(null, null, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).toBeNull();
  });

  it('DexScreener preferred over Jupiter when both valid and within threshold', async () => {
    const mint = freshMint();
    mockBothSources(1.00, 1.05, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('dexscreener');
    expect(r!.priceE6).toBe(toE6(1.00));
  });

  it('zero/negative priceUsd from DexScreener treated as null', async () => {
    const mint = freshMint();
    // priceUsd='0' → parseFloat=0 → fails >0 check → treated as null → fallback to Jupiter
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pairs: [{ priceUsd: '0', liquidity: { usd: 500_000 }, baseToken: { address: mint } }] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { [mint]: { price: '1.00' } } }) } as Response);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.source).toBe('jupiter');
  });
});

// ─── 2. Historical deviation boundary tests ────────────────────────────────────

describe('Historical deviation — boundary conditions', () => {
  let svc: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });

  async function seedPrice(slab: string, usd: number): Promise<bigint> {
    const mint = freshMint();
    mockBothSources(usd, usd, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).not.toBeNull();
    return r!.priceE6;
  }

  it('29% increase — accepted', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 1.00);
    const mint = freshMint();
    mockBothSources(1.29, 1.29, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).not.toBeNull();
    expect(r!.priceE6).toBe(toE6(1.29));
  });

  it('30% increase — ACCEPTED (exactly 3000 bps, not > 3000)', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 1.00);
    const mint = freshMint();
    mockBothSources(1.30, 1.30, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).not.toBeNull();
  });

  it('31% increase — REJECTED', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 1.00);
    const mint = freshMint();
    mockBothSources(1.31, 1.31, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).toBeNull();
  });

  it('50% drop — REJECTED', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 2.00);
    const mint = freshMint();
    mockBothSources(1.00, 1.00, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).toBeNull();
  });

  it('29% drop — accepted', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 1.00);
    const mint = freshMint();
    mockBothSources(0.71, 0.71, mint);
    const r = await svc.fetchPrice(mint, slab);
    expect(r).not.toBeNull();
  });

  it('fresh slab (no history) — any price accepted including wild values', async () => {
    const mint = freshMint();
    mockBothSources(99_999.00, 99_999.00, mint);
    const r = await svc.fetchPrice(mint, freshSlab());
    expect(r).not.toBeNull();
    expect(r!.priceE6).toBe(toE6(99_999.00));
  });

  it('sub-cent price ($0.000919): 20% increase accepted', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 0.000919);
    const mint = freshMint();
    mockBothSources(0.001103, 0.001103, mint); // ~20% up
    const r = await svc.fetchPrice(mint, slab);
    expect(r).not.toBeNull();
  });

  it('sub-cent price ($0.000919): 35% spike rejected', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 0.000919);
    const mint = freshMint();
    mockBothSources(0.001241, 0.001241, mint); // ~35% up
    const r = await svc.fetchPrice(mint, slab);
    expect(r).toBeNull();
  });

  it('consecutive cranks: step-up within 30% each time accumulates correctly', async () => {
    const slab = freshSlab();
    // Crank 1: $1.00
    await seedPrice(slab, 1.00);
    // Crank 2: $1.25 (25% up from $1.00 — ok)
    const mint2 = freshMint();
    mockBothSources(1.25, 1.25, mint2);
    const r2 = await svc.fetchPrice(mint2, slab);
    expect(r2).not.toBeNull();
    // Crank 3: $1.62 (29.6% up from $1.25 — ok)
    const mint3 = freshMint();
    mockBothSources(1.62, 1.62, mint3);
    const r3 = await svc.fetchPrice(mint3, slab);
    expect(r3).not.toBeNull();
    // Crank 4: $2.13 (31.5% up from $1.62 — REJECTED)
    const mint4 = freshMint();
    mockBothSources(2.13, 2.13, mint4);
    const r4 = await svc.fetchPrice(mint4, slab);
    expect(r4).toBeNull();
  });

  it('H1: accepts deviated price after 5 consecutive rejections (no permanent brick)', async () => {
    const slab = freshSlab();
    // Seed at $1.00
    await seedPrice(slab, 1.00);

    // Price jumps to $2.00 (100% deviation) — should be rejected 4 times, accepted on 5th
    for (let i = 0; i < 4; i++) {
      const mint = freshMint();
      mockBothSources(2.00, 2.00, mint);
      const r = await svc.fetchPrice(mint, slab);
      expect(r).toBeNull();
    }

    // 5th consecutive rejection — should be accepted
    const mintAccept = freshMint();
    mockBothSources(2.00, 2.00, mintAccept);
    const rAccept = await svc.fetchPrice(mintAccept, slab);
    expect(rAccept).not.toBeNull();
    expect(rAccept!.priceE6).toBe(toE6(2.00));
  });

  it('H1: resets rejection counter when a normal price is accepted', async () => {
    const slab = freshSlab();
    await seedPrice(slab, 1.00);

    // 2 consecutive rejections at $2.00
    for (let i = 0; i < 2; i++) {
      const mint = freshMint();
      mockBothSources(2.00, 2.00, mint);
      expect(await svc.fetchPrice(mint, slab)).toBeNull();
    }

    // Normal price accepted ($1.10, within 30%)
    const mintNormal = freshMint();
    mockBothSources(1.10, 1.10, mintNormal);
    const rNormal = await svc.fetchPrice(mintNormal, slab);
    expect(rNormal).not.toBeNull();

    // Counter should be reset — 4 more rejections at $2.00 should NOT accept
    for (let i = 0; i < 4; i++) {
      const mint = freshMint();
      mockBothSources(2.00, 2.00, mint);
      expect(await svc.fetchPrice(mint, slab)).toBeNull();
    }

    // 5th consecutive from fresh counter — NOW accepted
    const mintFinal = freshMint();
    mockBothSources(2.00, 2.00, mintFinal);
    const rFinal = await svc.fetchPrice(mintFinal, slab);
    expect(rFinal).not.toBeNull();
  });
});

// ─── 3. Admin-oracle / pumpswap price computation (GH#1376 regression) ─────────

describe('Admin-oracle pumpswap price computation — GH#1376 regression', () => {
  /**
   * GH#1376 root cause: keeper sent raw SOL pool reserve lamports (~454,074,932,992)
   * as the keeper_crank oracle_price argument. Correct value was ~919 (e6).
   *
   * Correct formula:
   *   price_e6 = (sol_reserve_lamports * sol_usd_e6) / (token_reserve_base_units * 1_000)
   *
   * For pump.fun tokens: token decimals = 6, so base_units = tokens × 10^6.
   * The ×1_000 factor converts from (lamports/base_units × e6) to e6 USD:
   *   lamports = SOL × 10^9
   *   base_units = tokens × 10^6
   *   ratio = 10^9 / 10^6 = 10^3 = 1_000 ✓
   */
  function computePumpswapPriceE6(
    solReserveLamports: bigint,
    tokenReserveBaseUnits: bigint,
    solUsdPriceE6: bigint
  ): bigint {
    if (tokenReserveBaseUnits === 0n || solReserveLamports === 0n) return 0n;
    return (solReserveLamports * solUsdPriceE6) / (tokenReserveBaseUnits * 1_000n);
  }

  it('produces ~919 for observed Percolator pool parameters', () => {
    // Back-calculated from known price $0.000919 at SOL=$150:
    // price_usd = sol_reserve_lamports / (token_reserve_base_units * 1e3) * sol_usd_e6 / 1e6
    // 0.000919 = sol_reserve / (token_reserve * 1000) * 150
    // sol_reserve / token_reserve = 0.000919/150 * 1000 = 0.006127
    // Using token_reserve = 1_000_000_000_000 → sol_reserve = 6_127_000_000 (~6.1 SOL)
    const solReserve = 6_127_000_000n;       // ~6.1 SOL in lamports (back-calculated)
    const tokenReserve = 1_000_000_000_000n; // 1M tokens in base units (6 dec)
    const solUsd = 150_000_000n;             // SOL = $150 in e6

    const price = computePumpswapPriceE6(solReserve, tokenReserve, solUsd);

    console.log('Computed price_e6:', price.toString(), '≈ $' + (Number(price) / 1e6).toFixed(7));
    expect(price).toBe(919n); // exactly $0.000919
  });

  it('GH#1376 buggy value (raw reserve) is 8+ orders of magnitude wrong', () => {
    const buggyValue = 454_074_932_992n;  // what the keeper was actually sending
    const correctValue = 919n;            // $0.000919 in e6
    expect(buggyValue / correctValue).toBeGreaterThan(400_000_000n);
  });

  it('cross-source check catches the raw-reserve bug when Jupiter is available', () => {
    // If Jupiter returns correct $0.000919 and keeper would send $454,074:
    const jupiterE6 = 919n;
    const buggyE6 = 454_074_932_992n;

    const larger = buggyE6 > jupiterE6 ? buggyE6 : jupiterE6;
    const smaller = buggyE6 > jupiterE6 ? jupiterE6 : buggyE6;
    const divergenceBps = Number((larger - smaller) * 10_000n / smaller);

    // Way over 1000 bps — cross-source check would block this
    expect(divergenceBps).toBeGreaterThan(1000);
  });

  it('price sanitizer alone does NOT catch the raw-reserve bug (documents gap)', () => {
    // MAX valid oracle price: $1B
    const MAX_PRICE_E6 = 1_000_000_000_000_000n;
    const buggyE6 = 454_074_932_992n; // ~$454,074 — below $1B, sanitizer passes it

    expect(buggyE6).toBeLessThan(MAX_PRICE_E6); // documents that sanitizer is insufficient
    // This is why cross-source validation is the critical defence layer
  });

  it('zero token reserve → returns 0 (no division by zero)', () => {
    expect(computePumpswapPriceE6(2_770_000_000n, 0n, 150_000_000n)).toBe(0n);
  });

  it('zero sol reserve → returns 0', () => {
    expect(computePumpswapPriceE6(0n, 2_994_460_000_000n, 150_000_000n)).toBe(0n);
  });

  it('doubling SOL price roughly doubles token price (within 1 unit — BigInt truncation)', () => {
    const solRes = 2_770_000_000n;
    const tokRes = 2_994_460_000_000n;
    const at150 = computePumpswapPriceE6(solRes, tokRes, 150_000_000n);
    const at300 = computePumpswapPriceE6(solRes, tokRes, 300_000_000n);
    // BigInt division truncates, so at300 may differ from at150*2 by ±1
    expect(at300).toBeGreaterThanOrEqual(at150 * 2n - 1n);
    expect(at300).toBeLessThanOrEqual(at150 * 2n + 1n);
  });

  it('quadrupling token reserve quarters the price (approximately)', () => {
    const solRes = 2_770_000_000n;
    const solUsd = 150_000_000n;
    const small = computePumpswapPriceE6(solRes, 1_000_000_000_000n, solUsd);
    const large = computePumpswapPriceE6(solRes, 4_000_000_000_000n, solUsd);
    const ratio = Number(small) / Number(large);
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('large SOL reserve → higher price (more SOL backing same tokens)', () => {
    const tokRes = 2_994_460_000_000n;
    const solUsd = 150_000_000n;
    const low = computePumpswapPriceE6(1_000_000_000n, tokRes, solUsd);
    const high = computePumpswapPriceE6(10_000_000_000n, tokRes, solUsd);
    expect(high).toBeGreaterThan(low);
  });
});

// ─── 4. HYPERP vs Pyth end-to-end scenario table ──────────────────────────────

describe('HYPERP vs Pyth scenario table', () => {
  /**
   * In Percolator production:
   *   DexScreener = HYPERP-derived price (DEX pool)
   *   Jupiter     = secondary reference (similar to Pyth index)
   *
   * These scenarios simulate realistic market conditions.
   * Threshold: divergenceBps > 1000 (>10.00%).
   */
  let svc: OracleService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new OracleService();
  });

  const scenarios: Array<{
    label: string;
    hyperp: number; // DexScreener price (0 = unavailable)
    pyth: number;   // Jupiter price (0 = unavailable)
    expectAccepted: boolean;
    note: string;
  }> = [
    { label: 'normal — both $150, 0% dev',          hyperp: 150.00,  pyth: 150.00, expectAccepted: true,  note: 'baseline' },
    { label: 'slight HYPERP premium, 5%',            hyperp: 157.50,  pyth: 150.00, expectAccepted: true,  note: 'normal spread' },
    { label: 'HYPERP at 9% premium',                 hyperp: 163.50,  pyth: 150.00, expectAccepted: true,  note: 'high but within limit' },
    { label: 'HYPERP at 10% premium (1000 bps)',      hyperp: 165.00,  pyth: 150.00, expectAccepted: true,  note: 'exactly 1000 bps — ACCEPTED (not > 1000)' },
    { label: 'HYPERP at 11% premium (1100 bps)',      hyperp: 166.50,  pyth: 150.00, expectAccepted: false, note: 'rejected' },
    { label: 'HYPERP at 15% premium',                hyperp: 172.50,  pyth: 150.00, expectAccepted: false, note: 'volatile pump' },
    { label: 'HYPERP at 20% discount',               hyperp: 120.00,  pyth: 150.00, expectAccepted: false, note: 'cascading sell' },
    { label: 'HYPERP at 50% discount (circuit break)',hyperp:  75.00, pyth: 150.00, expectAccepted: false, note: 'extreme crash' },
    { label: 'Pyth unavailable, HYPERP only',         hyperp: 150.00,  pyth: 0,     expectAccepted: true,  note: 'fallback to DexScreener' },
    { label: 'HYPERP unavailable, Pyth only',         hyperp: 0,       pyth: 150.00, expectAccepted: true, note: 'fallback to Jupiter' },
    { label: 'both unavailable',                      hyperp: 0,       pyth: 0,     expectAccepted: false, note: 'no price' },
    { label: 'micro-price $0.000919, 0% dev',         hyperp: 0.000919,pyth: 0.000919,expectAccepted: true, note: 'sub-cent token' },
    { label: 'micro-price: HYPERP 9% above Pyth',     hyperp: 0.001001,pyth: 0.000919,expectAccepted: true,  note: '8.9% divergence' },
    { label: 'micro-price: HYPERP 12% above Pyth',    hyperp: 0.001030,pyth: 0.000919,expectAccepted: false, note: '12.1% divergence' },
  ];

  for (const { label, hyperp, pyth, expectAccepted, note } of scenarios) {
    it(`${label} — ${expectAccepted ? 'accepted' : 'rejected'} (${note})`, async () => {
      const mint = freshMint();
      mockBothSources(hyperp || null, pyth || null, mint);
      const r = await svc.fetchPrice(mint, freshSlab());

      if (expectAccepted) {
        expect(r).not.toBeNull();
      } else {
        expect(r).toBeNull();
      }
    });
  }
});
