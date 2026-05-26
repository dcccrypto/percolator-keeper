import { describe, it, expect, vi } from "vitest";
import { captureAndExit } from "../../src/lib/exit-handlers.js";

function makeDeps() {
  const exit = vi.fn();
  const capture = vi.fn();
  const error = vi.fn();
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const setTimer = vi.fn((cb: () => void, ms: number) => {
    timers.push({ cb, ms });
  });
  return {
    deps: { exit, capture, logger: { error }, setTimer },
    timers,
  };
}

describe("captureAndExit", () => {
  it("logs reason and error message + stack", () => {
    const { deps } = makeDeps();
    const err = new Error("boom");
    captureAndExit("the keeper exploded", err, deps);
    expect(deps.logger.error).toHaveBeenCalledWith("the keeper exploded", {
      error: "boom",
      stack: err.stack,
    });
  });

  it("captures the original Error instance to Sentry", () => {
    const { deps } = makeDeps();
    const err = new Error("boom");
    captureAndExit("the keeper exploded", err, deps);
    expect(deps.capture).toHaveBeenCalledWith(err);
  });

  it("wraps non-Error rejections in a synthetic Error before capture", () => {
    const { deps } = makeDeps();
    captureAndExit("rejection", "some string reason", deps);
    const captured = deps.capture.mock.calls[0]?.[0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("some string reason");
  });

  it("schedules process.exit(1) after the flush window", () => {
    const { deps, timers } = makeDeps();
    captureAndExit("reason", new Error("x"), deps);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(2000);
    expect(deps.exit).not.toHaveBeenCalled();
    timers[0].cb();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("honors custom flushMs", () => {
    const { deps, timers } = makeDeps();
    captureAndExit("reason", new Error("x"), { ...deps, flushMs: 7777 });
    expect(timers[0].ms).toBe(7777);
  });

  it("swallows Sentry capture failures (still exits)", () => {
    const { deps, timers } = makeDeps();
    deps.capture.mockImplementation(() => {
      throw new Error("sentry down");
    });
    expect(() =>
      captureAndExit("reason", new Error("x"), deps),
    ).not.toThrow();
    timers[0].cb();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("call order is log → capture → schedule exit", () => {
    const events: string[] = [];
    const exit = vi.fn(() => events.push("exit"));
    const capture = vi.fn(() => events.push("capture"));
    const error = vi.fn(() => events.push("log"));
    const setTimer = vi.fn((cb: () => void) => {
      events.push("setTimer");
      cb();
    });
    captureAndExit("reason", new Error("x"), {
      exit,
      capture,
      logger: { error },
      setTimer,
    });
    expect(events).toEqual(["log", "capture", "setTimer", "exit"]);
  });
});
