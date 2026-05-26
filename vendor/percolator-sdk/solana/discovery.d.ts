import { Connection, PublicKey } from "@solana/web3.js";
import { type SlabHeader, type MarketConfig, type EngineState, type RiskParams } from "./slab.js";
import { type StaticMarketEntry } from "./static-markets.js";
import { type Network } from "../config/program-ids.js";
/**
 * A discovered Percolator market from on-chain program accounts.
 */
export interface DiscoveredMarket {
    slabAddress: PublicKey;
    /** The program that owns this slab account */
    programId: PublicKey;
    header: SlabHeader;
    config: MarketConfig;
    engine: EngineState;
    params: RiskParams;
}
/**
 * Slab tier definitions — V1 layout (all tiers upgraded as of 2026-03-13).
 * IMPORTANT: dataSize must match the compiled program's SLAB_LEN for that MAX_ACCOUNTS.
 * The on-chain program has a hardcoded SLAB_LEN — slab account data.len() must equal it exactly.
 *
 * Layout: HEADER(104) + CONFIG(536) + RiskEngine(variable by tier)
 *   ENGINE_OFF = 640  (HEADER=104 + CONFIG=536, padded to 8-byte align on SBF)
 *   RiskEngine = fixed(656) + bitmap(BW*8) + post_bitmap(18) + next_free(N*2) + pad + accounts(N*248)
 *
 * Values are empirically verified against on-chain initialized accounts (GH #1109):
 *   small  = 65,352  (256-acct program, verified on-chain post-V1 upgrade)
 *   medium = 257,448 (1024-acct program g9msRSV3, verified on-chain)
 *   large  = 1,025,832 (4096-acct program FxfD37s1, pre-PERC-118, matches slabDataSizeV1(4096) formula)
 *
 * NOTE: small program (FwfBKZXb) redeployed with --features small,devnet (2026-03-13).
 *       Large program FxfD37s1 is pre-PERC-118 — SLAB_LEN=1,025,832, matching formula.
 *       See GH #1109, GH #1112.
 *
 * History: Small was V0 (62_808) until 2026-03-13 program upgrade. V0 values preserved
 *          in SLAB_TIERS_V0 for discovery of legacy on-chain accounts.
 */
export declare const SLAB_TIERS: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65352;
        readonly label: "Small";
        readonly description: "256 slots · ~0.45 SOL";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257448;
        readonly label: "Medium";
        readonly description: "1,024 slots · ~1.79 SOL";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025832;
        readonly label: "Large";
        readonly description: "4,096 slots · ~7.14 SOL";
    };
};
/** @deprecated V0 slab sizes — kept for backward compatibility with old on-chain slabs */
export declare const SLAB_TIERS_V0: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 62808;
        readonly label: "Small";
        readonly description: "256 slots · ~0.44 SOL";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 248760;
        readonly label: "Medium";
        readonly description: "1,024 slots · ~1.73 SOL";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 992568;
        readonly label: "Large";
        readonly description: "4,096 slots · ~6.90 SOL";
    };
};
/**
 * V1D slab sizes — actually-deployed devnet V1 program (ENGINE_OFF=424, BITMAP_OFF=624).
 * PR #1200 added V1D layout detection in slab.ts but discovery.ts ALL_TIERS was missing
 * these sizes, causing V1D slabs to fall through to the memcmp fallback with wrong dataSize
 * hints → detectSlabLayout returning null → parse failure (GH#1205).
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=2):
 *   The V1D deployed program uses postBitmap=2 (free_head u16 only — no num_used/pad/next_account_id).
 *   This is 16 bytes smaller per tier than the SDK default (postBitmap=18). GH#1234.
 *   micro  =  17,064  (64 slots)
 *   small  =  65,088  (256 slots)
 *   medium = 257,184  (1,024 slots)
 *   large  = 1,025,568 (4,096 slots)
 */
export declare const SLAB_TIERS_V1D: {
    readonly micro: {
        readonly maxAccounts: 64;
        readonly dataSize: 17064;
        readonly label: "Micro";
        readonly description: "64 slots (V1D devnet)";
    };
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65088;
        readonly label: "Small";
        readonly description: "256 slots (V1D devnet)";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257184;
        readonly label: "Medium";
        readonly description: "1,024 slots (V1D devnet)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025568;
        readonly label: "Large";
        readonly description: "4,096 slots (V1D devnet)";
    };
};
/**
 * V1D legacy slab sizes — on-chain V1D slabs created before GH#1234 when the SDK assumed
 * postBitmap=18. These are 16 bytes larger per tier than SLAB_TIERS_V1D.
 * PR #1236 fixed postBitmap for new slabs (→2) but caused slab 6ZytbpV4 (65104 bytes,
 * top active market ~$15k 24h vol) to be unrecognized → "Failed to load market". GH#1237.
 *
 * Sizes computed via computeSlabSize(ENGINE_OFF=424, BITMAP_OFF=624, ACCOUNT_SIZE=248, N, postBitmap=18):
 *   micro  =  17,080  (64 slots)
 *   small  =  65,104  (256 slots)  ← slab 6ZytbpV4 TEST/USD
 *   medium = 257,200  (1,024 slots)
 *   large  = 1,025,584 (4,096 slots)
 */
export declare const SLAB_TIERS_V1D_LEGACY: {
    readonly micro: {
        readonly maxAccounts: 64;
        readonly dataSize: 17080;
        readonly label: "Micro";
        readonly description: "64 slots (V1D legacy, postBitmap=18)";
    };
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65104;
        readonly label: "Small";
        readonly description: "256 slots (V1D legacy, postBitmap=18)";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257200;
        readonly label: "Medium";
        readonly description: "1,024 slots (V1D legacy, postBitmap=18)";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025584;
        readonly label: "Large";
        readonly description: "4,096 slots (V1D legacy, postBitmap=18)";
    };
};
/** @deprecated Alias — use SLAB_TIERS (already V1) */
export declare const SLAB_TIERS_V1: {
    readonly small: {
        readonly maxAccounts: 256;
        readonly dataSize: 65352;
        readonly label: "Small";
        readonly description: "256 slots · ~0.45 SOL";
    };
    readonly medium: {
        readonly maxAccounts: 1024;
        readonly dataSize: 257448;
        readonly label: "Medium";
        readonly description: "1,024 slots · ~1.79 SOL";
    };
    readonly large: {
        readonly maxAccounts: 4096;
        readonly dataSize: 1025832;
        readonly label: "Large";
        readonly description: "4,096 slots · ~7.14 SOL";
    };
};
/**
 * V_ADL slab tier sizes — PERC-8270/8271 ADL-upgraded program.
 * ENGINE_OFF=624, BITMAP_OFF=1006, ACCOUNT_SIZE=312, postBitmap=18.
 * New account layout adds ADL tracking fields (+64 bytes/account).
 * BPF SLAB_LEN verified by cargo build-sbf in PERC-8271: large (4096) = 1288304 bytes.
 */
export declare const SLAB_TIERS_V_ADL_DISCOVERY: Record<string, {
    maxAccounts: number;
    dataSize: number;
    label: string;
    description: string;
}>;
export type SlabTierKey = keyof typeof SLAB_TIERS;
/** Calculate slab data size for arbitrary account count.
 *
 * Layout (SBF, u128 align = 8):
 *   HEADER(104) + CONFIG(536) → ENGINE_OFF = 640
 *   RiskEngine fixed scalars: 656 bytes (PERC-299: +24 emergency OI, +32 long/short OI)
 *   + bitmap: ceil(N/64)*8
 *   + num_used_accounts(u16) + pad(6) + next_account_id(u64) + free_head(u16) = 18
 *   + next_free: N*2
 *   + pad to 8-byte alignment for Account array
 *   + accounts: N*248
 *
 * Must match the on-chain program's SLAB_LEN exactly.
 */
export declare function slabDataSize(maxAccounts: number): number;
/**
 * Calculate slab data size for V1 layout (ENGINE_OFF=640).
 *
 * NOTE: This formula is accurate for small (256) and medium (1024) tiers but
 * underestimates large (4096) by 16 bytes — likely due to a padding/alignment
 * difference at high account counts or a post-PERC-118 struct addition in the
 * deployed binary. Always prefer the hardcoded SLAB_TIERS values (empirically
 * verified on-chain) over this formula for production use.
 */
export declare function slabDataSizeV1(maxAccounts: number): number;
/**
 * Validate that a slab data size matches one of the known tier sizes.
 * Use this to catch tier↔program mismatches early (PERC-277).
 *
 * @param dataSize - The expected slab data size (from SLAB_TIERS[tier].dataSize)
 * @param programSlabLen - The program's compiled SLAB_LEN (from on-chain error logs or program introspection)
 * @returns true if sizes match, false if there's a mismatch
 */
export declare function validateSlabTierMatch(dataSize: number, programSlabLen: number): boolean;
/** Options for `discoverMarkets`. */
export interface DiscoverMarketsOptions {
    /**
     * Run tier queries sequentially with per-tier retry on HTTP 429 instead of
     * firing all in parallel.  Reduces RPC rate-limit pressure at the cost of
     * slightly slower discovery (~14 round-trips instead of 1 concurrent batch).
     * Default: false (preserves original parallel behaviour).
     *
     * PERC-1650: keeper uses this flag to avoid 429 storms on its fallback RPC
     * (Helius starter tier).  Pass `sequential: true` from CrankService.discover().
     */
    sequential?: boolean;
    /**
     * Delay in ms between sequential tier queries (only used when sequential=true).
     * Default: 200 ms.
     */
    interTierDelayMs?: number;
    /**
     * Per-tier retry backoff delays on 429 (ms).  Jitter of up to +25% is applied.
     * Only used when sequential=true.  Default: [1_000, 3_000, 9_000, 27_000].
     */
    rateLimitBackoffMs?: number[];
    /**
     * In parallel mode (the default), cap how many tier RPC requests are in-flight
     * at once to avoid accidental RPC storms from client code.
     *
     * Default: 6
     */
    maxParallelTiers?: number;
    /**
     * Hard cap on how many tier dataSize queries are attempted.
     * Default: all known tiers.
     */
    maxTierQueries?: number;
    /**
     * Base URL of the Percolator REST API (e.g. `"https://percolatorlaunch.com/api"`).
     *
     * When set, `discoverMarkets` will fall back to the REST API's `GET /markets`
     * endpoint if `getProgramAccounts` fails or returns 0 results (common on public
     * mainnet RPCs that reject `getProgramAccounts`).
     *
     * The API returns slab addresses which are then fetched on-chain via
     * `getMarketsByAddress` (uses `getMultipleAccounts`, works on all RPCs).
     *
     * GH#59 / PERC-8424: Unblocks mainnet users without a Helius API key.
     *
     * @example
     * ```ts
     * const markets = await discoverMarkets(connection, programId, {
     *   apiBaseUrl: "https://percolatorlaunch.com/api",
     * });
     * ```
     */
    apiBaseUrl?: string;
    /**
     * Timeout in ms for the API fallback HTTP request.
     * Only used when `apiBaseUrl` is set.
     * Default: 10_000 (10 seconds).
     */
    apiTimeoutMs?: number;
    /**
     * Network hint for tier-3 static bundle fallback (`"mainnet"` or `"devnet"`).
     *
     * When both `getProgramAccounts` (tier 1) and the REST API (tier 2) fail,
     * `discoverMarkets` will fall back to a bundled static list of known slab
     * addresses for the specified network.  The addresses are fetched on-chain
     * via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
     *
     * If not set, tier-3 fallback is disabled.
     *
     * The static list can be extended at runtime via `registerStaticMarkets()`.
     *
     * @see {@link registerStaticMarkets} to add addresses at runtime
     * @see {@link getStaticMarkets} to inspect the current static list
     *
     * @example
     * ```ts
     * const markets = await discoverMarkets(connection, programId, {
     *   apiBaseUrl: "https://percolatorlaunch.com/api",
     *   network: "mainnet",  // enables tier-3 static fallback
     * });
     * ```
     */
    network?: Network;
}
/**
 * Discover all Percolator markets owned by the given program.
 * Uses getProgramAccounts with dataSize filter + dataSlice to download only ~1400 bytes per slab.
 *
 * @param options.sequential - Run tier queries sequentially with 429 retry (PERC-1650).
 */
export declare function discoverMarkets(connection: Connection, programId: PublicKey, options?: DiscoverMarketsOptions): Promise<DiscoveredMarket[]>;
/**
 * Options for `getMarketsByAddress`.
 */
export interface GetMarketsByAddressOptions {
    /**
     * Maximum number of addresses per `getMultipleAccounts` RPC call.
     * Solana limits a single call to 100 accounts; callers may lower this
     * to reduce per-request payload size or avoid 429s.
     *
     * Default: 100 (Solana maximum).
     */
    batchSize?: number;
    /**
     * Delay in ms between batches when the address list exceeds `batchSize`.
     * Helps avoid rate-limiting on public RPCs.
     *
     * Default: 0 (no delay).
     */
    interBatchDelayMs?: number;
}
/**
 * Fetch and parse Percolator markets by their known slab addresses.
 *
 * Unlike `discoverMarkets()` — which uses `getProgramAccounts` and is blocked
 * on public mainnet RPCs — this function uses `getMultipleAccounts`, which works
 * on any RPC endpoint (including `api.mainnet-beta.solana.com`).
 *
 * Callers must already know the market slab addresses (e.g. from an indexer,
 * a hardcoded registry, or a previous `discoverMarkets` call on a permissive RPC).
 *
 * @param connection - Solana RPC connection
 * @param programId - The Percolator program that owns these slabs
 * @param addresses - Array of slab account public keys to fetch
 * @param options   - Optional batching/delay configuration
 * @returns Parsed markets for all valid slab accounts; invalid/missing accounts are silently skipped.
 *
 * @example
 * ```ts
 * import { getMarketsByAddress, getProgramId } from "@percolator/sdk";
 * import { Connection, PublicKey } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const slabs = [
 *   new PublicKey("So11111111111111111111111111111111111111112"),
 *   // ... more known slab addresses
 * ];
 *
 * const markets = await getMarketsByAddress(connection, programId, slabs);
 * console.log(`Found ${markets.length} markets`);
 * ```
 */
export declare function getMarketsByAddress(connection: Connection, programId: PublicKey, addresses: PublicKey[], options?: GetMarketsByAddressOptions): Promise<DiscoveredMarket[]>;
/**
 * Shape of a single market entry returned by the Percolator REST API
 * (`GET /markets`).  Only the fields needed for discovery are typed here;
 * the full API response may contain additional statistics fields.
 */
export interface ApiMarketEntry {
    slab_address: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    status?: string;
    [key: string]: unknown;
}
/** Options for {@link discoverMarketsViaApi}. */
export interface DiscoverMarketsViaApiOptions {
    /**
     * Timeout in ms for the HTTP request to the REST API.
     * Default: 10_000 (10 seconds).
     */
    timeoutMs?: number;
    /**
     * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
     * step (batch size, inter-batch delay).
     */
    onChainOptions?: GetMarketsByAddressOptions;
}
/**
 * Discover Percolator markets by first querying the REST API for slab addresses,
 * then fetching full on-chain data via `getMarketsByAddress` (which uses
 * `getMultipleAccounts` — works on all RPCs including public mainnet nodes).
 *
 * This is the recommended discovery path for mainnet users who do not have a
 * Helius API key, since `getProgramAccounts` is rejected by public RPCs.
 *
 * The REST API acts as an address directory only — all market data is verified
 * on-chain via `getMarketsByAddress`, so the caller gets the same
 * `DiscoveredMarket[]` result as `discoverMarkets()`.
 *
 * @param connection - Solana RPC connection (any endpoint, including public)
 * @param programId - The Percolator program that owns the slabs
 * @param apiBaseUrl - Base URL of the Percolator REST API
 *                     (e.g. `"https://percolatorlaunch.com/api"`)
 * @param options - Optional timeout and on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts discovered via the API
 *
 * @example
 * ```ts
 * import { discoverMarketsViaApi, getProgramId } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const markets = await discoverMarketsViaApi(
 *   connection,
 *   programId,
 *   "https://percolatorlaunch.com/api",
 * );
 * console.log(`Discovered ${markets.length} markets via API fallback`);
 * ```
 */
export declare function discoverMarketsViaApi(connection: Connection, programId: PublicKey, apiBaseUrl: string, options?: DiscoverMarketsViaApiOptions): Promise<DiscoveredMarket[]>;
/** Options for {@link discoverMarketsViaStaticBundle}. */
export interface DiscoverMarketsViaStaticBundleOptions {
    /**
     * Options forwarded to {@link getMarketsByAddress} for the on-chain fetch
     * step (batch size, inter-batch delay).
     */
    onChainOptions?: GetMarketsByAddressOptions;
}
/**
 * Discover Percolator markets from a static list of known slab addresses.
 *
 * This is the tier-3 (last-resort) fallback for `discoverMarkets()`.  It uses
 * a bundled list of known slab addresses and fetches their full account data
 * on-chain via `getMarketsByAddress` (`getMultipleAccounts` — works on all RPCs).
 *
 * The static list acts as an address directory only — all market data is verified
 * on-chain, so stale entries are silently skipped (the account won't have valid
 * magic bytes or will have been closed).
 *
 * @param connection - Solana RPC connection (any endpoint)
 * @param programId - The Percolator program that owns the slabs
 * @param entries   - Static market entries (typically from {@link getStaticMarkets})
 * @param options   - Optional on-chain fetch configuration
 * @returns Parsed markets for all valid slab accounts; stale/missing entries are skipped.
 *
 * @example
 * ```ts
 * import {
 *   discoverMarketsViaStaticBundle,
 *   getStaticMarkets,
 *   getProgramId,
 * } from "@percolator/sdk";
 * import { Connection } from "@solana/web3.js";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const programId = getProgramId("mainnet");
 * const entries = getStaticMarkets("mainnet");
 *
 * const markets = await discoverMarketsViaStaticBundle(
 *   connection,
 *   programId,
 *   entries,
 * );
 * console.log(`Recovered ${markets.length} markets from static bundle`);
 * ```
 */
export declare function discoverMarketsViaStaticBundle(connection: Connection, programId: PublicKey, entries: StaticMarketEntry[], options?: DiscoverMarketsViaStaticBundleOptions): Promise<DiscoveredMarket[]>;
