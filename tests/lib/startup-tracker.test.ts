import { describe, it, expect } from "vitest";
import { StartupTracker } from "../../src/lib/startup-tracker.js";

describe("StartupTracker", () => {
  it("starts in 'starting' state", () => {
    const t = new StartupTracker();
    expect(t.state).toBe("starting");
    expect(t.isReady()).toBe(false);
    expect(t.isFailed()).toBe(false);
    expect(t.failureReason).toBeUndefined();
  });

  it("transitions to 'ready' after markReady()", () => {
    const t = new StartupTracker();
    t.markReady();
    expect(t.state).toBe("ready");
    expect(t.isReady()).toBe(true);
    expect(t.isFailed()).toBe(false);
  });

  it("transitions to 'failed' after markFailed() and captures the reason", () => {
    const t = new StartupTracker();
    t.markFailed("RPC unreachable");
    expect(t.state).toBe("failed");
    expect(t.isFailed()).toBe(true);
    expect(t.isReady()).toBe(false);
    expect(t.failureReason).toBe("RPC unreachable");
  });

  it("markReady() is ignored after markFailed() — failure is terminal", () => {
    const t = new StartupTracker();
    t.markFailed("RPC unreachable");
    t.markReady();
    expect(t.state).toBe("failed");
    expect(t.isReady()).toBe(false);
  });

  it("markFailed() overrides markReady() if called after — operator killswitch semantics", () => {
    const t = new StartupTracker();
    t.markReady();
    t.markFailed("late failure");
    expect(t.state).toBe("failed");
    expect(t.failureReason).toBe("late failure");
  });

  it("multiple markReady() calls are idempotent", () => {
    const t = new StartupTracker();
    t.markReady();
    t.markReady();
    t.markReady();
    expect(t.state).toBe("ready");
  });
});
