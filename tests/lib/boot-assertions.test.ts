import { describe, it, expect } from "vitest";
import {
  assertMainnetProgramId,
  MAINNET_PROGRAM_ID,
} from "../../src/lib/boot-assertions.js";

describe("assertMainnetProgramId", () => {
  it("is a no-op when isMainnet=false (any programId)", () => {
    expect(() =>
      assertMainnetProgramId({ isMainnet: false, programId: "anything" }),
    ).not.toThrow();
    expect(() =>
      assertMainnetProgramId({
        isMainnet: false,
        programId: MAINNET_PROGRAM_ID,
      }),
    ).not.toThrow();
    expect(() =>
      assertMainnetProgramId({ isMainnet: false, programId: "" }),
    ).not.toThrow();
  });

  it("is a no-op when isMainnet=true and programId matches canonical mainnet id", () => {
    expect(() =>
      assertMainnetProgramId({
        isMainnet: true,
        programId: MAINNET_PROGRAM_ID,
      }),
    ).not.toThrow();
  });

  it("throws when isMainnet=true and programId is a different value", () => {
    const wrongId = "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24";
    expect(() =>
      assertMainnetProgramId({ isMainnet: true, programId: wrongId }),
    ).toThrow(/SECURITY: NETWORK=mainnet but PROGRAM_ID=/);
  });

  it("throws when isMainnet=true and programId is empty", () => {
    expect(() =>
      assertMainnetProgramId({ isMainnet: true, programId: "" }),
    ).toThrow(/SECURITY: NETWORK=mainnet but PROGRAM_ID=/);
  });

  it("error message names both the actual and expected program ids", () => {
    const wrongId = "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24";
    try {
      assertMainnetProgramId({ isMainnet: true, programId: wrongId });
      throw new Error("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(wrongId);
      expect(msg).toContain(MAINNET_PROGRAM_ID);
    }
  });

  it("MAINNET_PROGRAM_ID is the canonical v12.19.1 deploy", () => {
    expect(MAINNET_PROGRAM_ID).toBe(
      "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
    );
    expect(MAINNET_PROGRAM_ID).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
