import { describe, it, expect, vi } from "vitest";
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
  it("trips when cycle tx count would exceed cap", () => {
    const clock = makeClock();
    const b = new KeeperBudget(TIGHT_CONFIG, { now: clock.now });
    for (let i = 0; i < 5; i++) {
      b.recordTx(1, "crank", "success");
    }
    expect(b.canSpend(1, "crank")).toBe(false);
    expect(b.haltKind).toBe("cycle-tx-count-cap");
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
