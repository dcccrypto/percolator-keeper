/**
 * DevnetPriceResolver — Supabase-backed price fallback for devnet-only tokens.
 *
 * oracle-keeper's primary price sources (DexScreener + Jupiter) use the on-chain
 * collateralMint address. For devnet-only tokens this fails at two levels:
 *
 *   Level 1 — devnet mirror: token was mirrored from mainnet but DexScreener
 *     uses the mainnet CA. Fix: look up mainnet_ca in devnet_mints and retry.
 *
 *   Level 2 — pure devnet: token was created only on devnet, has no mainnet
 *     equivalent, and therefore no DexScreener/Jupiter listing. Fix: return a
 *     static price from devnet_price_overrides (admin-seeded table).
 *
 * Data is refreshed every REFRESH_INTERVAL_MS (default 5min) from Supabase.
 * The cache is safe to query synchronously between refreshes.
 */

import { getSupabase, createLogger } from "@percolator/shared";

const logger = createLogger("keeper:devnet-resolver");

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const PRICE_E6_MULTIPLIER = 1_000_000n;

export class DevnetPriceResolver {
  /** devnet_mint → mainnet_ca */
  private mainnetCaMap = new Map<string, string>();
  /** devnet_mint → priceE6 (from devnet_price_overrides) */
  private staticPriceMap = new Map<string, bigint>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private _initialized = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Load initial data synchronously (awaited) then schedule background refresh.
   * Call this before starting OracleService so the cache is warm on first push.
   */
  async start(): Promise<void> {
    await this._refresh();
    this._initialized = true;
    this.timer = setInterval(() => {
      this._refresh().catch((err) => {
        logger.error("DevnetPriceResolver background refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, REFRESH_INTERVAL_MS);
    logger.info("DevnetPriceResolver started", {
      mainnetCaEntries: this.mainnetCaMap.size,
      staticPriceEntries: this.staticPriceMap.size,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get initialized(): boolean {
    return this._initialized;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns the mainnet CA for a devnet mint, or null if not found.
   * Use this to retry DexScreener/Jupiter with the mainnet address.
   */
  getMainnetCa(devnetMint: string): string | null {
    return this.mainnetCaMap.get(devnetMint) ?? null;
  }

  /**
   * Returns the static priceE6 override for a devnet-only mint, or null.
   * Only reached when all external price sources fail.
   */
  getStaticPrice(devnetMint: string): bigint | null {
    return this.staticPriceMap.get(devnetMint) ?? null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _refresh(): Promise<void> {
    const supabase = getSupabase();

    // Load devnet_mints: devnet_mint → mainnet_ca
    const { data: mintRows, error: mintErr } = await supabase
      .from("devnet_mints")
      .select("devnet_mint, mainnet_ca");

    if (mintErr) {
      logger.warn("Failed to load devnet_mints", { error: mintErr.message });
    } else if (mintRows) {
      const newMap = new Map<string, string>();
      for (const row of mintRows) {
        if (row.devnet_mint && row.mainnet_ca) {
          newMap.set(row.devnet_mint as string, row.mainnet_ca as string);
        }
      }
      this.mainnetCaMap = newMap;
    }

    // Load devnet_price_overrides: devnet_mint → priceE6
    const { data: overrideRows, error: overrideErr } = await supabase
      .from("devnet_price_overrides")
      .select("devnet_mint, price_usd");

    if (overrideErr) {
      // Table may not exist yet in older deployments — log and continue
      logger.warn("Failed to load devnet_price_overrides (table may not exist yet)", {
        error: overrideErr.message,
      });
    } else if (overrideRows) {
      const newMap = new Map<string, bigint>();
      for (const row of overrideRows) {
        const priceUsd = Number(row.price_usd);
        if (row.devnet_mint && isFinite(priceUsd) && priceUsd > 0) {
          newMap.set(row.devnet_mint as string, BigInt(Math.round(priceUsd * Number(PRICE_E6_MULTIPLIER))));
        }
      }
      this.staticPriceMap = newMap;
    }

    logger.debug("DevnetPriceResolver refreshed", {
      mainnetCaEntries: this.mainnetCaMap.size,
      staticPriceEntries: this.staticPriceMap.size,
    });
  }
}
