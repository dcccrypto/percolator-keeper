/**
 * Litesvm smoke test — verifies the simulator loads and the Clock sysvar
 * is settable/readable without a custom program. Used as the canary that
 * tests/litesvm/ infra is healthy.
 */
import { describe, it, expect } from "vitest";
import { Clock, LiteSVM } from "litesvm";

describe("litesvm smoke", () => {
  it("loads LiteSVM and round-trips the Clock sysvar", () => {
    const svm = new LiteSVM();
    const clock = svm.getClock();
    expect(typeof clock.slot).toBe("bigint");
    expect(typeof clock.unixTimestamp).toBe("bigint");

    // Round-trip: set a known unix timestamp and verify it reads back.
    const newClock = new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      1_800_000_000n, // ~2027
    );
    svm.setClock(newClock);
    const after = svm.getClock();
    expect(after.unixTimestamp).toBe(1_800_000_000n);
  });
});
