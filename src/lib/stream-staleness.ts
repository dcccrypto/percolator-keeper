import type { LoaderStats } from "./account-loader.js";

/**
 * #426 (5.2): wall-clock staleness floor for the LaserStream account stream.
 *
 * The account cache expires entries by SLOT age, measured against the stream's
 * own `lastSlot`. That is a sound freshness signal only while the stream is
 * delivering. If the gRPC connection stays up but stops producing — a silent
 * stall — `lastSlot` freezes, the slots stamped on cached entries freeze with
 * it, and `currentSlot - entry.slot` stops growing. The TTL can then never
 * expire, and the cache serves frozen bytes as fresh for as long as the stall
 * lasts.
 *
 * `AccountLoader.onStreamError -> cache.invalidateAll()` does not cover this,
 * because a silent stall raises no error event. The gap is specifically the
 * case where nothing goes wrong loudly.
 *
 * The floor is wall-clock rather than slot-based on purpose: slot time is the
 * quantity that has stopped being trustworthy, so it cannot be used to measure
 * its own staleness.
 */

/**
 * 30s. Mainnet slots are ~400ms, so this is ~75 slots of silence — far outside
 * normal jitter, and comfortably above the 32-slot (~13s) cache TTL it guards,
 * while still an order of magnitude below the 30-minute full re-discover that
 * would eventually correct the state anyway.
 */
export const DEFAULT_STREAM_STALL_MS = 30_000;

/** Env override, `KEEPER_STREAM_STALL_MS`. Non-numeric or <= 0 falls back. */
export function streamStallThresholdMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = parseInt(env.KEEPER_STREAM_STALL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_STALL_MS;
}

/**
 * True when the stream's slot has not moved forward within the threshold, and
 * its cache-freshness signal should therefore not be trusted.
 *
 * A loader that has never seen a slot (`lastSlotAdvanceAt === 0`) counts as
 * stalled. That covers boot before the first slot arrives, where the cache is
 * empty in any case, so the conservative answer costs nothing.
 */
export function isStreamStalled(
  stats: Pick<LoaderStats, "lastSlotAdvanceAt">,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!stats.lastSlotAdvanceAt) return true;
  return now - stats.lastSlotAdvanceAt > streamStallThresholdMs(env);
}
