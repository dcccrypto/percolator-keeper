import { describe, it, expect } from "vitest";
import {
  DEFAULT_STREAM_STALL_MS,
  isStreamStalled,
  streamStallThresholdMs,
} from "../../src/lib/stream-staleness.js";

/**
 * #426 (5.2). The account cache expires entries by SLOT age against the
 * stream's own `lastSlot`. When the gRPC connection stays up but stops
 * delivering, `lastSlot` freezes, the slots on cached entries freeze with it,
 * and `currentSlot - entry.slot` stops growing — so the TTL can never expire
 * and frozen bytes are served as fresh. `onStreamError -> invalidateAll()`
 * misses this case entirely, because a silent stall raises no error.
 */

describe("isStreamStalled", () => {
  const NOW = 1_800_000_000_000;

  it("is not stalled while the slot advanced within the threshold", () => {
    expect(
      isStreamStalled({ lastSlotAdvanceAt: NOW - (DEFAULT_STREAM_STALL_MS - 1) }, NOW, {}),
    ).toBe(false);
  });

  it("is stalled once the threshold is exceeded", () => {
    expect(
      isStreamStalled({ lastSlotAdvanceAt: NOW - (DEFAULT_STREAM_STALL_MS + 1) }, NOW, {}),
    ).toBe(true);
  });

  it("treats exactly-at-the-threshold as still live", () => {
    // Boundary pinned deliberately: `>` not `>=`, so a stream that advanced
    // exactly on the threshold is not punished for arriving on time.
    expect(
      isStreamStalled({ lastSlotAdvanceAt: NOW - DEFAULT_STREAM_STALL_MS }, NOW, {}),
    ).toBe(false);
  });

  it("treats a loader that has never advanced as stalled", () => {
    // Boot, before the first slot. The cache is empty then, so the
    // conservative answer costs nothing.
    expect(isStreamStalled({ lastSlotAdvanceAt: 0 }, NOW, {})).toBe(true);
  });

  it("honours KEEPER_STREAM_STALL_MS", () => {
    const env = { KEEPER_STREAM_STALL_MS: "1000" } as NodeJS.ProcessEnv;
    expect(isStreamStalled({ lastSlotAdvanceAt: NOW - 1_500 }, NOW, env)).toBe(true);
    expect(isStreamStalled({ lastSlotAdvanceAt: NOW - 500 }, NOW, env)).toBe(false);
  });
});

describe("streamStallThresholdMs", () => {
  it("defaults when unset", () => {
    expect(streamStallThresholdMs({})).toBe(DEFAULT_STREAM_STALL_MS);
  });

  it("rejects non-numeric, zero and negative overrides rather than disabling the guard", () => {
    // A guard that silently switches off on a typo'd env var is worse than no
    // guard, because the dashboard still says it is configured.
    for (const raw of ["abc", "", "0", "-1"]) {
      expect(
        streamStallThresholdMs({ KEEPER_STREAM_STALL_MS: raw } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_STREAM_STALL_MS);
    }
  });

  it("accepts a positive override", () => {
    expect(
      streamStallThresholdMs({ KEEPER_STREAM_STALL_MS: "5000" } as NodeJS.ProcessEnv),
    ).toBe(5_000);
  });

  it("keeps the default above the cache TTL it guards", () => {
    // The cache TTL is 32 slots (~13s at ~400ms). A stall floor below that
    // would fire during normal operation; one far above it would let the TTL
    // stay unexpirable for longer than it is meant to hold anything.
    expect(DEFAULT_STREAM_STALL_MS).toBeGreaterThan(32 * 400);
    expect(DEFAULT_STREAM_STALL_MS).toBeLessThan(30 * 60 * 1_000);
  });
});
