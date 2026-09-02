import { describe, it, expect } from "vitest";
import {
  assertMainnetProgramId,
  assertProgramIdAllowList,
  MAINNET_PROGRAM_ID,
} from "../../src/lib/boot-assertions.js";

describe("assertMainnetProgramId", () => {
  it("accepts a non-mainnet programId when isMainnet=false", () => {
    expect(() =>
      assertMainnetProgramId({ isMainnet: false, programId: "anything" }),
    ).not.toThrow();
  });

  it("#418: REFUSES the mainnet programId when isMainnet=false", () => {
    // This previously early-returned, which is the hole: a keeper the operator
    // believes is on devnet would discover and sign against the live mainnet
    // program with the live key and no guard firing. The program id is the
    // definitive signal — an RPC host can be a proxy whose name says nothing.
    expect(() =>
      assertMainnetProgramId({ isMainnet: false, programId: MAINNET_PROGRAM_ID }),
    ).toThrow(/canonical MAINNET program/);
  });

  it("keeps accepting a non-mainnet programId off mainnet", () => {
    expect(() =>
      assertMainnetProgramId({
        isMainnet: false,
        programId: "So11111111111111111111111111111111111111112",
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

describe("assertProgramIdAllowList", () => {
  const WRONG = "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24";

  it("throws on an empty list on ANY network (silent zero-program scan)", () => {
    expect(() => assertProgramIdAllowList({ isMainnet: false, allProgramIds: [] })).toThrow(/empty program set/);
    // Mainnet-empty too — the length check must precede the per-entry check so
    // [] does NOT pass the vacuously-true .every/.filter (regression guard).
    expect(() => assertProgramIdAllowList({ isMainnet: true, allProgramIds: [] })).toThrow(/empty program set/);
  });

  it("allows a non-canonical id off mainnet (devnet uses its own program)", () => {
    expect(() => assertProgramIdAllowList({ isMainnet: false, allProgramIds: [WRONG] })).not.toThrow();
    expect(() => assertProgramIdAllowList({ isMainnet: false, allProgramIds: [WRONG, "AnotherDevProg1111111111111111111111111111"] })).not.toThrow();
  });

  it("allows a mainnet list that is exactly the canonical id (incl. dupes)", () => {
    expect(() => assertProgramIdAllowList({ isMainnet: true, allProgramIds: [MAINNET_PROGRAM_ID] })).not.toThrow();
    expect(() => assertProgramIdAllowList({ isMainnet: true, allProgramIds: [MAINNET_PROGRAM_ID, MAINNET_PROGRAM_ID] })).not.toThrow();
  });

  it("throws on mainnet when any entry is non-canonical, naming the offender", () => {
    expect(() => assertProgramIdAllowList({ isMainnet: true, allProgramIds: [WRONG] })).toThrow(/non-canonical/);
    expect(() => assertProgramIdAllowList({ isMainnet: true, allProgramIds: [MAINNET_PROGRAM_ID, WRONG] })).toThrow(new RegExp(WRONG));
  });
});
