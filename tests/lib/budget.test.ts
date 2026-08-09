import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeeperBudget, type TxResult } from "../../src/lib/budget.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const TIGHT_CONFIG = {
  maxSolPerCycle: 1_000,
  maxSolPerHour: 5_000,
  maxSolPerDay: 20_000,
  maxTxPerCycle: 5,
  // #333: pin the critical-reserve to 0 in the shared config so spend/reservation
  // tests exercise the FULL count cap on the "crank" lane (matching their
  // pre-#333 intent). The dedicated count-cap / reserved-capacity tests below set
  // reservedCriticalTxPerCycle explicitly where the reserve is the thing under test.
  reservedCriticalTxPerCycle: 0,
  txSuccessRateWindow: 60_000,
  txSuccessRateThreshold: 0.7,
  txSuccessRateMinSamples: 4,
} as const;

describe("KeeperBudget — defaults", () => {
  it("starts with sane defaults when constructed with no config", () => {
    const b = new KeeperBudget({}, { env: {} });
    const stats = b.getStats();
    expect(stats.config.maxSolPerCycle).toBe(50_000_000);
    expect(stats.config.maxSolPerHour).toBe(500_000_000);
    expect(stats.config.maxSolPerDay).toBe(3_000_000_000);
    expect(stats.config.maxTxPerCycle).toBe(60);
    expect(stats.config.cycleWindowMs).toBe(30_000);
    expect(stats.config.txSuccessRateThreshold).toBe(0.7);
    expect(stats.halted).toBe(false);
  });

  it("env overrides take precedence over defaults", () => {
    const b = new KeeperBudget(
      {},
      {
        env: {
          KEEPER_MAX_SOL_PER_CYCLE: "12345",
          KEEPER_MAX_SOL_PER_DAY: "9999",
          KEEPER_TX_SUCCESS_RATE_THRESHOLD: "0.5",
        },
      },
    );
    expect(b.config.maxSolPerCycle).toBe(12345);
    expect(b.config.maxSolPerDay).toBe(9999);
    expect(b.config.txSuccessRateThreshold).toBe(0.5);
  });

  it("constructor-passed config takes precedence over env", () => {
    const b = new KeeperBudget(
      { maxSolPerCycle: 99 },
      { env: { KEEPER_MAX_SOL_PER_CYCLE: "12345" } },
    );
    expect(b.config.maxSolPerCycle).toBe(99);
  });

  it("ignores invalid env values (NaN, negative, non-integer for ints)", () => {
    const b = new KeeperBudget(
      {},
      {
        env: {
          KEEPER_MAX_SOL_PER_CYCLE: "not-a-number",
          KEEPER_MAX_SOL_PER_HOUR: "-100",
          KEEPER_MAX_SOL_PER_DAY: "1.5",
          KEEPER_TX_SUCCESS_RATE_THRESHOLD: "1.5",
        },
      },
    );
    expect(b.config.maxSolPerCycle).toBe(50_000_000);
    expect(b.config.maxSolPerHour).toBe(500_000_000);
    expect(b.config.maxSolPerDay).toBe(3_000_000_000);
    expect(b.config.txSuccessRateThreshold).toBe(0.7);
  });
});

describe("KeeperBudget — cycle spend cap", () => {
  it("permits spending up to the cycle cap", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    expect(b.canSpend(500, "crank")).toBe(true);
    b.recordTx(500, "crank", "success");
    expect(b.canSpend(500, "crank")).toBe(true);
    b.recordTx(500, "crank", "success");
    // 1000/1000 spent — next 1 lamport must trip
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("cycle-spend-cap");
  });

  it("beginCycle resets cycleSpend but does not clear halt", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(1_500, "crank", "success");
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    b.beginCycle();
    expect(b.getStats().cycleSpend).toBe(0);
    // halt still in effect
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
  });
});

describe("KeeperBudget — hour spend cap", () => {
  it("trips when rolling-hour spend would exceed cap", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    for (let i = 0; i < 5; i++) {
      b.beginCycle();
      b.recordTx(1_000, "crank", "success");
    }
    // hourSpend now 5_000 == cap. Reset cycle so the cycle-spend guard does
    // not trip first; we want to isolate the hour-spend guard.
    b.beginCycle();
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.haltKind).toBe("hour-spend-cap");
  });

  it("auto-prunes events older than 1 hour", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(4_000, "crank", "success");
    expect(b.getStats().hourSpend).toBe(4_000);
    clock.advance(3_600_001);
    // trigger prune via getStats
    expect(b.getStats().hourSpend).toBe(0);
  });
});

describe("KeeperBudget — day spend cap", () => {
  it("trips on day-cap breach and requires manual resume", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    for (let i = 0; i < 20; i++) {
      b.beginCycle();
      b.recordTx(1_000, "crank", "success");
      clock.advance(3_600_001); // skip over hour window so hour cap doesn't trip first
    }
    // day spend == 20_000 == cap. Reset cycle to isolate the day-spend guard.
    b.beginCycle();
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.haltKind).toBe("day-spend-cap");
    // resume requires explicit operator call
    b.resume("test-operator");
    expect(b.isHalted()).toBe(false);
  });
});

describe("KeeperBudget — cycle tx count cap", () => {
  // #333: hitting the per-cycle tx-COUNT cap is soft backpressure, NOT a
  // latching halt. The send is refused but the breaker stays un-halted so the
  // next window auto-resumes the deferred work — an attacker can no longer
  // wedge the whole keeper with mere crank/provisioning volume.
  it("refuses the over-cap send WITHOUT halting (soft backpressure)", () => {
    const clock = makeClock();
    // TIGHT_CONFIG pins reservedCriticalTxPerCycle:0 so "crank" sees the full
    // count cap (5) and this test isolates the raw count-cap → soft-refuse path.
    const b = new KeeperBudget({ ...TIGHT_CONFIG, reservedCriticalTxPerCycle: 0 }, { now: clock.now });
    for (let i = 0; i < 5; i++) {
      b.recordTx(1, "crank", "success");
    }
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(false); // no latch
    expect(b.haltKind).toBeUndefined();
  });
});

describe("KeeperBudget — per-cycle window auto-reset", () => {
  // Regression for the CRITICAL self-halt: the per-cycle counters used to be
  // reset only by beginCycle(), which had no production caller, so they
  // accumulated for the whole process lifetime and permanently latched a halt.
  // They now reset on a time window with no caller required.

  it("resets cycle spend + tx count once the window elapses, without beginCycle()", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
    // Spend 802 of the 1_000 cycle cap across 2 txs — no manual reset.
    b.recordTx(800, "crank", "success");
    b.recordTx(2, "crank", "success");
    expect(b.getStats().cycleSpend).toBe(802);
    expect(b.getStats().cycleTxCount).toBe(2);
    // Pre-roll, another 500 would breach (802 + 500 > 1_000).
    clock.advance(30_000); // window elapses
    expect(b.canSpend(500, "crank")).toBe(true); // window rolled → counters cleared
    b.recordTx(500, "crank", "success");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(500); // reset to 0, then this tx
    expect(s.cycleTxCount).toBe(1);
    expect(b.isHalted()).toBe(false);
  });

  it("does not reset until the full window has elapsed", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
    b.recordTx(900, "crank", "success");
    clock.advance(29_999); // just under the window
    expect(b.getStats().cycleSpend).toBe(900); // not yet rolled
    clock.advance(1); // now exactly at the boundary
    expect(b.getStats().cycleSpend).toBe(0); // rolled
  });

  it("#333: a within-window count-cap burst refuses (soft) but does NOT latch", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000, reservedCriticalTxPerCycle: 0 }, { now: clock.now });
    for (let i = 0; i < 5; i++) b.recordTx(1, "crank", "success"); // maxTxPerCycle = 5
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(false); // soft backpressure, no halt
    expect(b.haltKind).toBeUndefined();
  });

  it("#333: a genuine SPEND-cap burst still latches (brake intact for real anomalies)", () => {
    const clock = makeClock();
    // maxSolPerCycle = 1_000; one big spend breaches it → real overspend → latch.
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
    expect(b.canSpend(2_000, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("cycle-spend-cap");
  });

  it("#333: count-cap soft refusal auto-clears next window (no resume needed)", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000, reservedCriticalTxPerCycle: 0 }, { now: clock.now });
    for (let i = 0; i < 5; i++) b.recordTx(1, "crank", "success");
    expect(b.canSpend(1, "crank")).toBe(false); // count cap hit
    expect(b.isHalted()).toBe(false);
    clock.advance(30_000); // window rolls → _cycleTxCount zeroed
    expect(b.canSpend(1, "crank")).toBe(true); // auto-resumed, no operator action
  });

  it("window roll does NOT clear a latched SPEND halt — resume() is still required", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
    expect(b.canSpend(2_000, "crank")).toBe(false); // spend-cap breach → latch
    expect(b.isHalted()).toBe(true);
    clock.advance(120_000); // several windows elapse
    expect(b.isHalted()).toBe(true); // a real breach stays halted until a human resumes
    expect(b.canSpend(1, "crank")).toBe(false);
    b.resume("op");
    expect(b.canSpend(1, "crank")).toBe(true);
  });
});

describe("KeeperBudget — onResume hook", () => {
  it("fires when a halt is cleared and lets callers reset a halted gauge", () => {
    const clock = makeClock();
    const onResume = vi.fn();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onResume });
    b.haltManually("cordon");
    expect(b.isHalted()).toBe(true);
    b.resume("op");
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("does not fire when resume() is a no-op on a non-halted budget", () => {
    const clock = makeClock();
    const onResume = vi.fn();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onResume });
    b.resume("op");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("onResume errors are caught and do not break resume()", () => {
    const clock = makeClock();
    const onResume = vi.fn(() => {
      throw new Error("metric backend down");
    });
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onResume });
    b.haltManually("cordon");
    expect(() => b.resume("op")).not.toThrow();
    expect(b.isHalted()).toBe(false);
  });
});

describe("KeeperBudget — success rate guard", () => {
  it("does not trip until min samples present", () => {
    const clock = makeClock();
    const b = new KeeperBudget(
      { ...TIGHT_CONFIG, maxTxPerCycle: 999 },
      { now: clock.now },
    );
    // 3 fails — below min samples (4) so the guard does not engage
    for (let i = 0; i < 3; i++) b.recordTx(1, "crank", "fail");
    expect(b.canSpend(1, "crank")).toBe(true);
    expect(b.isHalted()).toBe(false);
  });

  it("trips when rate below threshold and samples sufficient", () => {
    const clock = makeClock();
    const b = new KeeperBudget(
      { ...TIGHT_CONFIG, maxTxPerCycle: 999 },
      { now: clock.now },
    );
    // 4 fails, 0 success → rate 0 < 0.7
    for (let i = 0; i < 4; i++) b.recordTx(1, "crank", "fail");
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.haltKind).toBe("tx-success-rate");
  });

  it("does not trip when rate above threshold", () => {
    const clock = makeClock();
    const b = new KeeperBudget(
      { ...TIGHT_CONFIG, maxTxPerCycle: 999 },
      { now: clock.now },
    );
    // 3 success, 1 fail → rate 0.75 > 0.7
    for (let i = 0; i < 3; i++) b.recordTx(1, "crank", "success");
    b.recordTx(1, "crank", "fail");
    expect(b.canSpend(1, "crank")).toBe(true);
  });

  it("auto-prunes tx records older than window", () => {
    const clock = makeClock();
    const b = new KeeperBudget(
      { ...TIGHT_CONFIG, maxTxPerCycle: 999 },
      { now: clock.now },
    );
    for (let i = 0; i < 4; i++) b.recordTx(1, "crank", "fail");
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.haltKind).toBe("tx-success-rate");
    // resume + advance past window — fresh slate
    b.resume("op");
    clock.advance(60_001);
    expect(b.getStats().txWindowSize).toBe(0);
    expect(b.canSpend(1, "crank")).toBe(true);
  });
});

describe("KeeperBudget — drop result accounting", () => {
  it("counts toward tx count but not spend", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(500, "crank", "drop");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(0);
    expect(s.cycleTxCount).toBe(1);
    expect(s.hourSpend).toBe(0);
    expect(s.daySpend).toBe(0);
    expect(s.txWindowSize).toBe(0);
  });
});

describe("KeeperBudget — reverted result accounting", () => {
  it("counts toward tx count + spend but NOT the success-rate window", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(300, "liquidation", "reverted");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(300); // fees were paid — the tx landed
    expect(s.cycleTxCount).toBe(1);
    expect(s.hourSpend).toBe(300);
    expect(s.daySpend).toBe(300);
    expect(s.txWindowSize).toBe(0); // excluded from the breaker
  });

  it("a flood of reverts never trips the tx-success-rate breaker", () => {
    const clock = makeClock();
    const b = new KeeperBudget({ ...TIGHT_CONFIG, maxTxPerCycle: 999, maxSolPerCycle: 1e12, maxSolPerHour: 1e12, maxSolPerDay: 1e12 }, { now: clock.now });
    for (let i = 0; i < 50; i++) b.recordTx(1, "liquidation", "reverted");
    expect(b.canSpend(1, "crank")).toBe(true);
    expect(b.isHalted()).toBe(false);
    expect(b.getStats().txSuccessRate).toBeNull(); // no success/fail samples at all
  });
});

describe("KeeperBudget — resume() semantics", () => {
  it("resume clears halt state and lets canSpend return true again", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(2_000, "crank", "success");
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);

    b.beginCycle();
    b.resume("operator-alice");

    expect(b.isHalted()).toBe(false);
    expect(b.haltReason).toBeUndefined();
    expect(b.haltKind).toBeUndefined();
    expect(b.canSpend(1, "crank")).toBe(true);
  });

  it("resume() on a non-halted budget is a no-op", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    expect(() => b.resume("op")).not.toThrow();
    expect(b.isHalted()).toBe(false);
  });

  it("haltManually trips with kind=operator and respects resume", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.haltManually("cordoning for deploy");
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("operator");
    expect(b.canSpend(1, "crank")).toBe(false);
    b.resume("op");
    expect(b.canSpend(1, "crank")).toBe(true);
  });
});

describe("KeeperBudget — onHalt hook", () => {
  it("fires once on first halt with kind + reason", () => {
    const clock = makeClock();
    const onHalt = vi.fn();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onHalt });
    b.recordTx(2_000, "crank", "success");
    b.canSpend(1, "crank");
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledWith("cycle-spend-cap", expect.any(String));
  });

  it("does not double-fire on subsequent canSpend calls", () => {
    const clock = makeClock();
    const onHalt = vi.fn();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onHalt });
    b.recordTx(2_000, "crank", "success");
    b.canSpend(1, "crank");
    b.canSpend(1, "crank");
    b.canSpend(1, "crank");
    expect(onHalt).toHaveBeenCalledTimes(1);
  });

  it("hook errors are caught and do not break canSpend", () => {
    const clock = makeClock();
    const onHalt = vi.fn(() => {
      throw new Error("metric backend down");
    });
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, onHalt });
    b.recordTx(2_000, "crank", "success");
    expect(() => b.canSpend(1, "crank")).not.toThrow();
    expect(b.isHalted()).toBe(true);
  });
});

describe("KeeperBudget — recordTx input validation", () => {
  it("ignores negative lamports", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(-100, "crank", "success");
    expect(b.getStats().cycleSpend).toBe(0);
    expect(b.getStats().cycleTxCount).toBe(0);
  });

  it("ignores NaN lamports", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.recordTx(NaN, "crank", "success");
    expect(b.getStats().cycleSpend).toBe(0);
    expect(b.getStats().cycleTxCount).toBe(0);
  });
});

describe("KeeperBudget — counter consistency under sequential ops", () => {
  it("hourSpendSum matches the sum of unexpired events at all times", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    const results: TxResult[] = ["success", "fail", "drop"];
    for (let i = 0; i < 100; i++) {
      const r = results[i % 3]!;
      b.recordTx(7, "crank", r);
      if (i % 17 === 0) {
        clock.advance(40_000);
      }
    }
    const stats = b.getStats();
    expect(stats.hourSpend).toBeGreaterThanOrEqual(0);
    expect(stats.hourSpend).toBeLessThanOrEqual(stats.daySpend);
  });
});

describe("KeeperBudget — non-finite cost guard", () => {
  it("canSpend(NaN) refuses and halts (fail-safe), requiring resume()", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(NaN, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("non-finite-cost");
    // stays halted for subsequent finite sends until resume()
    expect(b.canSpend(1, "crank")).toBe(false);
    b.resume("op");
    expect(b.canSpend(1, "crank")).toBe(true);
  });

  it("canSpend(Infinity) refuses and halts (defense in depth)", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(Infinity, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("non-finite-cost");
  });

  it("fires onHalt with kind=non-finite-cost", () => {
    const onHalt = vi.fn();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now, onHalt });
    b.canSpend(NaN, "crank");
    expect(onHalt).toHaveBeenCalledWith("non-finite-cost", expect.any(String));
  });

  it("a NaN canSpend does not corrupt the reservation tallies", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    b.canSpend(NaN, "crank");
    expect(b.getStats().reservedLamports).toBe(0);
    expect(b.getStats().reservedTxCount).toBe(0);
  });
});

describe("KeeperBudget — reservation / TOCTOU", () => {
  it("a second in-flight send that only the reservation pushes over the cap is REFUSED, not halted", () => {
    // cycle cap 1000; two 600-lamport sends in flight, neither recorded yet.
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(600, "crank")).toBe(true); // reserves 600
    expect(b.canSpend(600, "crank")).toBe(false); // 0 + 600 reserved + 600 > 1000
    // Concurrency back-pressure must NOT latch the breaker — nothing overspent.
    expect(b.isHalted()).toBe(false);
  });

  it("a settled-spend breach still HALTS (unchanged semantics)", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(600, "crank")).toBe(true);
    b.recordTx(600, "crank", "success"); // settled cycleSpend = 600, reservation released
    // Next send's settled spend alone (600 + 600 = 1200) breaches the 1000 cap →
    // this is a real overspend signal, so it HALTS (not mere back-pressure).
    expect(b.canSpend(600, "crank")).toBe(false);
    expect(b.isHalted()).toBe(true);
    expect(b.haltKind).toBe("cycle-spend-cap");
  });

  it("reservation released on success: cycleSpend equals recorded amount, budget re-admits", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(600, "crank")).toBe(true);
    b.recordTx(600, "crank", "success");
    expect(b.getStats().cycleSpend).toBe(600);
    expect(b.getStats().reservedLamports).toBe(0);
    expect(b.canSpend(400, "crank")).toBe(true); // 600 + 0 + 400 == 1000, not > cap
  });

  it("reservation released on drop: nothing booked, reserve cleared, full budget free", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(900, "crank")).toBe(true);
    b.recordTx(900, "crank", "drop");
    expect(b.getStats().cycleSpend).toBe(0); // drop books nothing
    expect(b.getStats().reservedLamports).toBe(0);
    expect(b.getStats().cycleTxCount).toBe(1); // still an attempt
    expect(b.canSpend(1_000, "crank")).toBe(true);
  });

  it("recordTx without a prior canSpend never drives the reserve negative", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    b.recordTx(500, "crank", "success"); // no reservation existed
    expect(b.getStats().cycleSpend).toBe(500);
    expect(b.getStats().reservedLamports).toBe(0);
  });

  it("reserved tx-count prevents concurrent overshoot of maxTxPerCycle without halting", () => {
    // maxTxPerCycle = 5; wide spend caps so only the count matters.
    const b = new KeeperBudget(
      { ...TIGHT_CONFIG, maxSolPerCycle: 1_000_000, maxSolPerHour: 1_000_000, maxSolPerDay: 1_000_000 },
      { now: makeClock().now },
    );
    for (let i = 0; i < 5; i++) expect(b.canSpend(1, "crank")).toBe(true); // reserve 5 tx
    expect(b.canSpend(1, "crank")).toBe(false); // 0 + 5 reserved + 1 > 5 → refuse
    expect(b.isHalted()).toBe(false);
  });

  it("beginCycle does not orphan in-flight reservations", () => {
    const b = new KeeperBudget(TIGHT_CONFIG, { now: makeClock().now });
    expect(b.canSpend(600, "crank")).toBe(true); // reserve 600 (in flight)
    b.beginCycle(); // a new cycle starts while the send is still on the wire
    expect(b.getStats().reservedLamports).toBe(600); // reservation survives
    // the in-flight send settles into the new cycle and releases its reservation
    b.recordTx(600, "crank", "success");
    expect(b.getStats().reservedLamports).toBe(0);
    expect(b.getStats().cycleSpend).toBe(600);
  });
});

describe("KeeperBudget — M12 adjustForRealizedCost", () => {
  it("under-estimate (realized > estimated) bumps cycle/hour/day spend by the delta", () => {
    const b = new KeeperBudget(TIGHT_CONFIG);
    b.recordTx(100, "crank", "success");
    let s = b.getStats();
    expect(s.cycleSpend).toBe(100);
    expect(s.realizedCostSamples).toBe(0);

    b.adjustForRealizedCost(100, 150, "crank");
    s = b.getStats();
    expect(s.cycleSpend).toBe(150);
    expect(s.hourSpend).toBe(150);
    expect(s.daySpend).toBe(150);
    expect(s.realizedCostDriftLamports).toBe(50);
    expect(s.realizedCostSamples).toBe(1);
  });

  it("over-estimate (realized < estimated) decrements spend toward (but not below) zero", () => {
    const b = new KeeperBudget(TIGHT_CONFIG);
    b.recordTx(100, "crank", "success");
    b.adjustForRealizedCost(100, 60, "crank");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(60);
    expect(s.realizedCostDriftLamports).toBe(-40);
    expect(s.realizedCostSamples).toBe(1);
  });

  it("clamps cycle/hour/day spend at 0 when a negative delta exceeds recorded spend", () => {
    const b = new KeeperBudget(TIGHT_CONFIG);
    b.recordTx(50, "crank", "success");
    // Realized way smaller than estimated — delta = -200, spend was only 50.
    b.adjustForRealizedCost(250, 50, "crank");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(0);
    expect(s.hourSpend).toBe(0);
    expect(s.daySpend).toBe(0);
    // Drift telemetry still records the true (negative) signed delta.
    expect(s.realizedCostDriftLamports).toBe(-200);
    expect(s.realizedCostSamples).toBe(1);
  });

  it("ignores NaN / non-finite / negative inputs without bumping samples", () => {
    const b = new KeeperBudget(TIGHT_CONFIG);
    b.recordTx(100, "crank", "success");
    b.adjustForRealizedCost(Number.NaN, 200, "crank");
    b.adjustForRealizedCost(100, Number.POSITIVE_INFINITY, "crank");
    b.adjustForRealizedCost(-1, 200, "crank");
    b.adjustForRealizedCost(100, -50, "crank");
    const s = b.getStats();
    expect(s.cycleSpend).toBe(100);
    expect(s.realizedCostSamples).toBe(0);
    expect(s.realizedCostDriftLamports).toBe(0);
  });

  it("accumulates drift across many tx — net positive drift surfaces under-estimation", () => {
    const b = new KeeperBudget(TIGHT_CONFIG);
    for (let i = 0; i < 10; i++) {
      b.recordTx(100, "crank", "success");
      // Consistently under-estimate by 10 lamports each tx.
      b.adjustForRealizedCost(100, 110, "crank");
    }
    const s = b.getStats();
    expect(s.realizedCostSamples).toBe(10);
    expect(s.realizedCostDriftLamports).toBe(100); // 10 tx × 10 lamports
    // cycleSpend = 10*100 recorded + 10*10 drift = 1100
    expect(s.cycleSpend).toBe(1100);
  });

  it("never trips the cycle gate from realized adjustment alone if the recorded estimate fit", () => {
    // Reproduces the M12 motivation: the canSpend gate already passed at estimatedCost.
    // A small under-estimate should not retroactively halt the keeper for this tx — it
    // just consumes more budget headroom for the next call.
    const b = new KeeperBudget({ ...TIGHT_CONFIG, maxSolPerCycle: 200 });
    b.recordTx(150, "crank", "success");
    expect(b.canSpend(40, "crank")).toBe(true); // 150 + 40 = 190 < 200
    b.adjustForRealizedCost(150, 170, "crank"); // now cycleSpend = 170
    expect(b.canSpend(40, "crank")).toBe(false); // 170 + 40 = 210 > 200
  });

  // H-4: adjustForRealizedCost never rolled the cycle window before touching
  // _cycleSpend, so a reconciliation arriving after a cycle boundary (the
  // 5s keeper-send.ts delay vs. a 30s default cycleWindowMs) blended its
  // delta into whatever unrelated transactions had already landed in the
  // NEW cycle. It also mutated _hourSpendSum/_daySpendSum directly with no
  // backing SpendEvent, permanently desyncing them from what _pruneOld
  // expects to decrement as entries age out.
  describe("H-4: cycle-roll safety + hour/day event sync", () => {
    it("rolls the cycle before applying a reconciliation that lands after the cycle window elapsed", () => {
      const clock = makeClock();
      const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });

      b.recordTx(100, "crank", "success"); // cycle A: cycleSpend = 100
      expect(b.getStats().cycleSpend).toBe(100);

      clock.advance(30_000); // cycle window elapses before reconciliation fires
      b.recordTx(40, "crank", "success"); // unrelated tx lands in the NEW cycle B
      expect(b.getStats().cycleSpend).toBe(40); // cycle A's 100 already rolled away

      // Late reconciliation for the ORIGINAL (cycle A) tx: realized cost was
      // 60 lamports higher than estimated.
      b.adjustForRealizedCost(100, 160, "crank");

      // The +60 must land in the cycle that's current NOW (cycle B), not get
      // silently lost against a stale pre-roll snapshot of cycle A.
      expect(b.getStats().cycleSpend).toBe(100); // 40 + 60
    });

    it("does not disturb the cycle counter when reconciliation arrives within the same (unrolled) cycle", () => {
      const clock = makeClock();
      const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
      b.recordTx(100, "crank", "success");
      clock.advance(5_000); // typical reconciliation delay, well under the 30s window
      b.adjustForRealizedCost(100, 160, "crank");
      expect(b.getStats().cycleSpend).toBe(160); // unchanged from pre-fix behavior
    });

    it("hourSpend/daySpend decay back to zero once both the original event and the delta event age out", () => {
      const clock = makeClock();
      const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });

      b.recordTx(100, "crank", "success");
      b.adjustForRealizedCost(100, 150, "crank"); // delta +50
      expect(b.getStats().hourSpend).toBe(150);

      // Pre-fix: the +50 was never backed by a SpendEvent, so hourSpend would
      // stay at 150 forever, never pruned. Post-fix: it was pushed as its own
      // event and prunes out along with the original 100 once the hour window
      // elapses.
      clock.advance(3_600_001);
      const s = b.getStats();
      expect(s.hourSpend).toBe(0);
      expect(s.daySpend).toBe(150); // day window (24h) hasn't elapsed yet
    });

    it("a clamped negative delta event does not desync the scalar once it ages out (stores the applied amount, not the raw delta)", () => {
      const clock = makeClock();
      const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });

      b.recordTx(50, "crank", "success"); // hourSpend = 50
      // Raw delta = -200, but only 50 is available — clamps to 0. If the
      // RAW -200 were stored as the event (instead of the -50 actually
      // applied), pruning it later would subtract -200 (i.e. ADD 200) from
      // a sum that only ever lost 50, desyncing it positive.
      b.adjustForRealizedCost(250, 50, "crank");
      expect(b.getStats().hourSpend).toBe(0);

      clock.advance(3_600_001); // expire both events
      const s = b.getStats();
      expect(s.hourSpend).toBe(0); // must settle at exactly 0, never positive or negative
      expect(s.daySpend).toBeGreaterThanOrEqual(0);
    });

    it("realizedCostDriftLamports always reflects the full unclamped delta, independent of cycle roll or hour/day clamping", () => {
      const clock = makeClock();
      const b = new KeeperBudget({ ...TIGHT_CONFIG, cycleWindowMs: 30_000 }, { now: clock.now });
      b.recordTx(100, "crank", "success");
      clock.advance(30_000);
      b.adjustForRealizedCost(100, 175, "crank");
      const s = b.getStats();
      expect(s.realizedCostDriftLamports).toBe(75);
      expect(s.realizedCostSamples).toBe(1);
    });
  });
});

// BUG-106: a latched halt was purely in-memory -- a process crash/restart
// silently resumed spending into whatever condition tripped the breaker,
// with no record that it was ever halted. haltStatePath is opt-in (undefined
// by default) so every test above, and every consumer that doesn't pass it,
// is completely unaffected.
describe("KeeperBudget — BUG-106: halt-state persistence", () => {
  function tempHaltPath(): string {
    return path.join(os.tmpdir(), `keeper-budget-halt-test-${Math.random().toString(36).slice(2)}.json`);
  }

  it("does not touch the filesystem when haltStatePath is not set", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    b.haltManually("cordon");
    expect(b.isHalted()).toBe(true);
    // No haltStatePath was given — nothing to assert on disk, just confirms
    // the existing in-memory-only behavior is unchanged when opted out.
  });

  it("persists a halt to disk and restores it in a fresh instance constructed with the same path", () => {
    const haltStatePath = tempHaltPath();
    try {
      const clock = makeClock();
      const b1 = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath });
      b1.haltManually("cordoning for deploy");
      expect(fs.existsSync(haltStatePath)).toBe(true);

      // Simulates a process restart: a brand-new instance, same path.
      const onHalt = vi.fn();
      const b2 = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath, onHalt });
      expect(b2.isHalted()).toBe(true);
      expect(b2.haltKind).toBe("operator");
      expect(b2.canSpend(1, "crank")).toBe(false);
      // The restore re-fires onHalt so paging/metrics react as if it just happened.
      expect(onHalt).toHaveBeenCalledWith("operator", "cordoning for deploy");
    } finally {
      fs.rmSync(haltStatePath, { force: true });
    }
  });

  it("clears the persisted file on resume — a later restart starts clean", () => {
    const haltStatePath = tempHaltPath();
    try {
      const clock = makeClock();
      const b1 = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath });
      b1.haltManually("cordon");
      expect(fs.existsSync(haltStatePath)).toBe(true);
      b1.resume("op");
      expect(fs.existsSync(haltStatePath)).toBe(false);

      const b2 = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath });
      expect(b2.isHalted()).toBe(false);
      expect(b2.canSpend(1, "crank")).toBe(true);
    } finally {
      fs.rmSync(haltStatePath, { force: true });
    }
  });

  it("starts clean when the configured path has no file yet", () => {
    const haltStatePath = tempHaltPath(); // never written
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath });
    expect(b.isHalted()).toBe(false);
  });

  it("starts clean and logs rather than throwing when the persisted file is malformed", () => {
    const haltStatePath = tempHaltPath();
    try {
      fs.writeFileSync(haltStatePath, "{not valid json", "utf8");
      const clock = makeClock();
      expect(() => new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath })).not.toThrow();
      const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now, haltStatePath });
      expect(b.isHalted()).toBe(false);
    } finally {
      fs.rmSync(haltStatePath, { force: true });
    }
  });
});
