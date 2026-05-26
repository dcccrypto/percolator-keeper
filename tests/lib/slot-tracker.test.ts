import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SlotTracker } from "../../src/lib/slot-tracker.js";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("SlotTracker", () => {
  beforeEach(() => {
    delete process.env.KEEPER_STREAM_SLOT_DRIFT_ALERT;
  });

  afterEach(() => {
    delete process.env.KEEPER_STREAM_SLOT_DRIFT_ALERT;
  });

  describe("onStreamSlot / getStreamSlot", () => {
    it("starts at slot 0", () => {
      const t = new SlotTracker();
      expect(t.getStreamSlot()).toBe(0);
    });

    it("advances when a higher slot is received", () => {
      const t = new SlotTracker();
      t.onStreamSlot(100);
      expect(t.getStreamSlot()).toBe(100);
    });

    it("ignores lower slots (monotonically increasing)", () => {
      const t = new SlotTracker();
      t.onStreamSlot(200);
      t.onStreamSlot(150); // backwards — should be ignored
      expect(t.getStreamSlot()).toBe(200);
    });

    it("accepts equal slot without regressing", () => {
      const t = new SlotTracker();
      t.onStreamSlot(100);
      t.onStreamSlot(100);
      expect(t.getStreamSlot()).toBe(100);
    });
  });

  describe("getDriftEstimate", () => {
    it("returns 0 when in sync", () => {
      const t = new SlotTracker();
      t.onStreamSlot(100);
      expect(t.getDriftEstimate(100)).toBe(0);
    });

    it("returns positive when stream is behind RPC", () => {
      const t = new SlotTracker();
      t.onStreamSlot(90);
      expect(t.getDriftEstimate(100)).toBe(10);
    });

    it("returns negative when stream is ahead of RPC", () => {
      const t = new SlotTracker();
      t.onStreamSlot(110);
      expect(t.getDriftEstimate(100)).toBe(-10);
    });
  });

  describe("drift alert callback", () => {
    it("does not invoke callback when drift is within threshold", async () => {
      vi.useFakeTimers();
      const alertFn = vi.fn();
      const t = new SlotTracker(alertFn);

      t.onStreamSlot(95);
      t.start(async () => 100); // drift = 5, threshold = 50

      await vi.advanceTimersByTimeAsync(10_100);
      t.stop();
      vi.useRealTimers();

      expect(alertFn).not.toHaveBeenCalled();
    });

    it("invokes callback when drift exceeds default threshold (50)", async () => {
      vi.useFakeTimers();
      const alertFn = vi.fn();
      const t = new SlotTracker(alertFn);

      t.onStreamSlot(10);
      t.start(async () => 100); // drift = 90 > 50

      await vi.advanceTimersByTimeAsync(10_100);
      t.stop();
      vi.useRealTimers();

      expect(alertFn).toHaveBeenCalledWith(90);
    });

    it("respects KEEPER_STREAM_SLOT_DRIFT_ALERT env override", async () => {
      vi.useFakeTimers();
      process.env.KEEPER_STREAM_SLOT_DRIFT_ALERT = "5";
      const alertFn = vi.fn();
      const t = new SlotTracker(alertFn);

      t.onStreamSlot(94);
      t.start(async () => 100); // drift = 6 > threshold(5)

      await vi.advanceTimersByTimeAsync(10_100);
      t.stop();
      vi.useRealTimers();

      expect(alertFn).toHaveBeenCalledWith(6);
    });
  });

  describe("start / stop", () => {
    it("stop() is idempotent", () => {
      const t = new SlotTracker();
      t.stop();
      t.stop(); // should not throw
    });

    it("start() is idempotent (does not double-poll)", async () => {
      vi.useFakeTimers();
      let pollCount = 0;
      const t = new SlotTracker();
      t.start(async () => { pollCount++; return 100; });
      t.start(async () => { pollCount++; return 100; }); // second call is no-op

      await vi.advanceTimersByTimeAsync(10_100);
      t.stop();
      vi.useRealTimers();

      expect(pollCount).toBe(1);
    });

    it("does not fire alert after stop()", async () => {
      vi.useFakeTimers();
      const alertFn = vi.fn();
      const t = new SlotTracker(alertFn);
      t.onStreamSlot(0);
      t.start(async () => 100); // would drift
      t.stop(); // immediately stop

      await vi.advanceTimersByTimeAsync(20_000);
      vi.useRealTimers();

      expect(alertFn).not.toHaveBeenCalled();
    });
  });
});
