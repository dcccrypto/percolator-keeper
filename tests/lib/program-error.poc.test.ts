import { describe, it, expect } from "vitest";
import { isCustomProgramError } from "../../src/lib/program-error.js";

/**
 * PoC — the permanent-skip guards in crank.ts and liquidation.ts used
 * `errMsg.includes("custom program error: 0x4")`, which also matches 0x40–0x4f
 * and 0x400+. A transient engine error numbered in those ranges was misread as
 * InvalidSlabLen (code 4) and the healthy market was permanently skipped from
 * cranking / liquidation. The "does NOT match higher codes" case below fails
 * against the old substring check and passes against the exact helper.
 */
describe("isCustomProgramError — exact custom-error-code matching", () => {
  it("matches the exact code 0x4", () => {
    expect(isCustomProgramError("custom program error: 0x4", 4)).toBe(true);
    expect(
      isCustomProgramError(
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x4",
        4,
      ),
    ).toBe(true);
    expect(isCustomProgramError("custom program error: 0x4 (InvalidSlabLen)", 4)).toBe(true);
  });

  it("does NOT match higher codes that share the 0x4 prefix", () => {
    for (const higher of ["0x40", "0x41", "0x4c", "0x4f", "0x400", "0x4a2"]) {
      expect(isCustomProgramError(`custom program error: ${higher}`, 4)).toBe(false);
    }
  });

  it("documents the defect this replaces: the old substring check misfired", () => {
    // The removed check classified code 0x40 (64) as code 4 ...
    expect("custom program error: 0x40".includes("custom program error: 0x4")).toBe(true);
    // ... whereas the helper correctly rejects it.
    expect(isCustomProgramError("custom program error: 0x40", 4)).toBe(false);
  });

  it("works for multi-digit / hex-letter codes too", () => {
    expect(isCustomProgramError("custom program error: 0x33", 0x33)).toBe(true);
    expect(isCustomProgramError("custom program error: 0x330", 0x33)).toBe(false);
  });
});
