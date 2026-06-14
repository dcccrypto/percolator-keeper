import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { derivePythPushOraclePDA } from "@percolatorct/sdk";
import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:oracle-account");

/**
 * Chainlink OCR2 Store program id.
 *
 * The on-chain program (percolator-prog `read_engine_price_e6`) detects the
 * oracle type by the supplied oracle account's OWNER — PYTH_RECEIVER → Pyth,
 * CHAINLINK_OCR2 → Chainlink — and for a Chainlink market `index_feed_id` IS the
 * aggregator account pubkey (the program checks `price_ai.key == index_feed_id`).
 * The SDK does not export this constant, so it is pinned here against the
 * program's `CHAINLINK_OCR2_PROGRAM_ID` (percolator.rs). A unit test asserts the
 * literal so a drift is caught loudly.
 */
export const CHAINLINK_OCR2_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny",
);

/** Minimal feed shape — compatible with a real PublicKey and parsed-config mocks. */
interface FeedLike {
  toBytes(): Uint8Array;
  toBase58(): string;
}

type OracleKind = "chainlink" | "pyth";

/** feed pubkey (base58) → resolved oracle kind. The owner of a feed account is
 *  fixed at InitMarket, so this is cached for the process lifetime; only
 *  positively-resolved verdicts are cached (a failed lookup is retried). */
const ownerCache = new Map<string, OracleKind>();

/** Test hook: drop cached verdicts so the next resolve re-fetches. */
export function _resetOracleAccountCache(): void {
  ownerCache.clear();
}

function pythPushPda(feedBytes: Uint8Array): PublicKey {
  const feedHex = Array.from(feedBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return derivePythPushOraclePDA(feedHex)[0];
}

/**
 * Resolve the oracle account to pass on-chain for a market that uses an EXTERNAL
 * pinned feed (i.e. non-HYPERP, non-admin: `index_feed_id != 0`). Callers must
 * have already handled HYPERP / admin-oracle (both → slab); this only
 * distinguishes Pyth from Chainlink, which is indistinguishable from config
 * alone and so requires the on-chain account owner:
 *
 *   - owner == CHAINLINK_OCR2  → the oracle account IS `index_feed_id` (the aggregator)
 *   - otherwise / null / error → derive the Pyth Push PDA (pre-fix behavior)
 *
 * The Pyth-derive default makes this a strict correctness superset of the old
 * code: a Pyth market is byte-for-byte unchanged, a flaky lookup never makes a
 * working market worse, and a confirmed Chainlink owner routes correctly. A
 * confirmed verdict is cached; an inconclusive/errored lookup is NOT cached, so
 * a Chainlink market self-heals on the next send once the lookup succeeds.
 */
export async function resolveExternalOracleAccount(
  indexFeedId: FeedLike,
  connection: Connection,
): Promise<PublicKey> {
  const feedBytes = indexFeedId.toBytes();
  const feedKey = indexFeedId.toBase58();

  const cached = ownerCache.get(feedKey);
  if (cached === "chainlink") return new PublicKey(feedBytes);
  if (cached === "pyth") return pythPushPda(feedBytes);

  try {
    const info = await connection.getAccountInfo(new PublicKey(feedBytes));
    const kind: OracleKind =
      info && info.owner.equals(CHAINLINK_OCR2_PROGRAM_ID) ? "chainlink" : "pyth";
    ownerCache.set(feedKey, kind);
    if (kind === "chainlink") {
      logger.info("Resolved Chainlink oracle for feed", { feed: feedKey });
      return new PublicKey(feedBytes);
    }
    return pythPushPda(feedBytes);
  } catch (err) {
    // Inconclusive: fall back to Pyth for this send (== pre-fix behavior) but do
    // NOT cache, so a real Chainlink market retries once the lookup recovers.
    logger.warn("Oracle owner lookup failed — defaulting to Pyth PDA (uncached)", {
      feed: feedKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return pythPushPda(feedBytes);
  }
}
