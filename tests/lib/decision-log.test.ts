import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  shadowDecisionsTotal: { inc: vi.fn() },
  shadowMatchTotal: { inc: vi.fn() },
  shadowDivergencePct: { set: vi.fn() },
}));

import { DecisionLog } from "../../src/lib/decision-log.js";
import type { DecisionEntry } from "../../src/lib/decision-log.js";

function makeEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    timestamp: new Date().toISOString(),
    txType: "crank",
    market: "F4HytAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    accounts: ["pk1", "pk2"],
    instructionData: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString("base64"),
    estimatedCost: 5_000,
    reasonChain: [],
    ...overrides,
  };
}

async function makeTempLog(): Promise<{ log: DecisionLog; logPath: string }> {
  const logPath = path.join(os.tmpdir(), `keeper-test-decisions-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const log = new DecisionLog(logPath);
  return { log, logPath };
}

describe("DecisionLog — JSONL writes", () => {
  it("writes a single entry as a valid JSON line", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      const entry = makeEntry();
      await log.append(entry);
      await log.close();
      const raw = await fs.readFile(logPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as DecisionEntry;
      expect(parsed.txType).toBe("crank");
      expect(parsed.estimatedCost).toBe(5_000);
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });

  it("each line is independently parseable JSON", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      for (let i = 0; i < 5; i++) {
        await log.append(makeEntry({ estimatedCost: i * 1_000 }));
      }
      await log.close();
      const raw = await fs.readFile(logPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(5);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });

  it("lines are separated by newlines, not concatenated", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      await log.append(makeEntry({ market: "AAA" }));
      await log.append(makeEntry({ market: "BBB" }));
      await log.close();
      const raw = await fs.readFile(logPath, "utf8");
      // Must end with a newline after last entry
      expect(raw.endsWith("\n")).toBe(true);
      // Must have exactly 2 newlines for 2 entries
      expect(raw.split("\n").filter((l) => l.trim()).length).toBe(2);
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });
});

describe("DecisionLog — append-only (existing entries preserved)", () => {
  it("appending to an existing file preserves prior entries", async () => {
    const { log: log1, logPath } = await makeTempLog();
    try {
      await log1.append(makeEntry({ market: "FIRST" }));
      await log1.close();

      const log2 = new DecisionLog(logPath);
      await log2.append(makeEntry({ market: "SECOND" }));
      await log2.close();

      const entries = await new DecisionLog(logPath).readAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.market).toBe("FIRST");
      expect(entries[1]!.market).toBe("SECOND");
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });
});

describe("DecisionLog — read round-trip", () => {
  it("write 100 entries, read back 100 entries", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      for (let i = 0; i < 100; i++) {
        await log.append(makeEntry({ estimatedCost: i, txType: i % 2 === 0 ? "crank" : "liquidation" }));
      }
      await log.close();

      const readLog = new DecisionLog(logPath);
      const entries = await readLog.readAll();
      expect(entries).toHaveLength(100);
      // Spot check: first and last
      expect(entries[0]!.estimatedCost).toBe(0);
      expect(entries[99]!.estimatedCost).toBe(99);
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });

  it("returns empty array when file does not exist", async () => {
    const log = new DecisionLog("/tmp/nonexistent-keeper-decisions-" + Date.now() + ".jsonl");
    const entries = await log.readAll();
    expect(entries).toHaveLength(0);
  });
});

describe("DecisionLog — malformed line skipping (chaos)", () => {
  it("skips 1 malformed line in the middle of 100 good ones → yields 99", async () => {
    const logPath = path.join(os.tmpdir(), `keeper-chaos-${Date.now()}.jsonl`);
    try {
      const goodEntry = JSON.stringify(makeEntry()) + "\n";
      // Write 50 good, then 1 malformed, then 49 good
      const lines = [
        ...Array.from({ length: 50 }, () => goodEntry),
        "NOT VALID JSON }{{\n",
        ...Array.from({ length: 49 }, () => goodEntry),
      ].join("");
      await fs.writeFile(logPath, lines, "utf8");

      const log = new DecisionLog(logPath);
      const entries = await log.readAll();
      expect(entries).toHaveLength(99);
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });

  it("skips a line that is valid JSON but missing required fields", async () => {
    const logPath = path.join(os.tmpdir(), `keeper-schema-${Date.now()}.jsonl`);
    try {
      const good = JSON.stringify(makeEntry()) + "\n";
      const bad = JSON.stringify({ foo: "bar" }) + "\n"; // missing DecisionEntry fields
      await fs.writeFile(logPath, good + bad + good, "utf8");

      const log = new DecisionLog(logPath);
      const entries = await log.readAll();
      expect(entries).toHaveLength(2);
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });
});

describe("DecisionLog — time window filtering", () => {
  it("readWindow returns only entries within [fromMs, toMs]", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      const now = Date.now();
      const old = new Date(now - 600_000).toISOString(); // 10 min ago
      const recent = new Date(now - 60_000).toISOString(); // 1 min ago

      await log.append(makeEntry({ timestamp: old, market: "OLD" }));
      await log.append(makeEntry({ timestamp: recent, market: "RECENT" }));
      await log.close();

      const readLog = new DecisionLog(logPath);
      const window = await readLog.readWindow(now - 120_000, now);
      expect(window).toHaveLength(1);
      expect(window[0]!.market).toBe("RECENT");
    } finally {
      await fs.unlink(logPath).catch(() => {});
    }
  });
});

describe("DecisionLog — metrics wiring", () => {
  it("increments shadowDecisionsTotal counter on each append", async () => {
    const { log, logPath } = await makeTempLog();
    try {
      const { shadowDecisionsTotal } = await import("../../src/lib/metrics.js");
      await log.append(makeEntry({ txType: "liquidation" }));
      expect(vi.mocked(shadowDecisionsTotal.inc)).toHaveBeenCalledWith({ txType: "liquidation" });
    } finally {
      await log.close();
      await fs.unlink(logPath).catch(() => {});
    }
  });
});
