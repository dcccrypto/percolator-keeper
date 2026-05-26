/**
 * DecisionLog — append-only JSONL writer for shadow-keeper decisions.
 *
 * Every "would have fired" send from the DRY_RUN intercept in keeper-send.ts
 * lands here as a structured JSONL line. The comparison loop in
 * shadow-harness.ts reads back these entries and cross-checks them against the
 * live keeper's on-chain tx history.
 *
 * Design constraints:
 *   - File writes are ALWAYS swallowed on error — a write failure must never
 *     propagate to the keeper crank path.
 *   - Reads iterate lazily: a single malformed line is skipped, not thrown.
 *   - No buffering beyond the OS page cache: each append is a direct
 *     fileHandle.write so SIGKILL does not lose in-flight decisions.
 *   - No new npm deps: uses Node 22 built-in fs/promises only.
 */

import fs from "node:fs/promises";
import { createLogger } from "@percolatorct/shared";
import type { TxType } from "./budget.js";
import { shadowDecisionsTotal } from "./metrics.js";

const logger = createLogger("keeper:decision-log");

export interface DecisionEntry {
  timestamp: string;
  txType: TxType;
  market: string;
  accounts: string[];
  instructionData: string;
  estimatedCost: number;
  reasonChain: string[];
}

export class DecisionLog {
  private readonly logPath: string;
  private _handle: fs.FileHandle | null = null;
  private _opening = false;

  constructor(logPath?: string) {
    this.logPath = logPath ?? process.env.SHADOW_HARNESS_DECISION_LOG_PATH ?? "/tmp/keeper-decisions.jsonl";
  }

  private async _getHandle(): Promise<fs.FileHandle | null> {
    if (this._handle) return this._handle;
    if (this._opening) return null;
    this._opening = true;
    try {
      this._handle = await fs.open(this.logPath, "a");
      return this._handle;
    } catch (err) {
      logger.error("DecisionLog: failed to open log file", {
        path: this.logPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this._opening = false;
    }
  }

  /**
   * Append a decision entry as a single JSONL line.
   * Errors are swallowed — a log write failure must not block the crank path.
   */
  async append(entry: DecisionEntry): Promise<void> {
    try {
      const handle = await this._getHandle();
      if (!handle) return;
      const line = JSON.stringify(entry) + "\n";
      await handle.write(line);
      shadowDecisionsTotal.inc({ txType: entry.txType });
    } catch (err) {
      logger.error("DecisionLog: append failed", {
        path: this.logPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Read all valid entries from the log file. Malformed lines are skipped.
   * Returns an empty array if the file does not exist or cannot be read.
   */
  async readAll(): Promise<DecisionEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.logPath, "utf8");
    } catch {
      return [];
    }
    const entries: DecisionEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isDecisionEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // malformed line — skip
      }
    }
    return entries;
  }

  /**
   * Read entries within a time window [fromMs, toMs].
   * fromMs and toMs are Unix epoch milliseconds.
   */
  async readWindow(fromMs: number, toMs: number): Promise<DecisionEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => {
      const ts = Date.parse(e.timestamp);
      return !Number.isNaN(ts) && ts >= fromMs && ts <= toMs;
    });
  }

  /**
   * Flush and close the underlying file handle.
   * Called during graceful shutdown.
   */
  async close(): Promise<void> {
    if (!this._handle) return;
    try {
      await this._handle.close();
      this._handle = null;
    } catch (err) {
      logger.error("DecisionLog: close failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isDecisionEntry(v: unknown): v is DecisionEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e["timestamp"] === "string" &&
    typeof e["txType"] === "string" &&
    typeof e["market"] === "string" &&
    Array.isArray(e["accounts"]) &&
    typeof e["instructionData"] === "string" &&
    typeof e["estimatedCost"] === "number" &&
    Array.isArray(e["reasonChain"])
  );
}

/**
 * Singleton instance. Import this in keeper-send.ts to append decisions
 * from the DRY_RUN intercept, and in shadow-harness.ts for reads.
 */
export const sharedDecisionLog = new DecisionLog();
