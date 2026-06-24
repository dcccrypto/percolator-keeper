import { describe, it, expect } from "vitest";
import { estimateLamportCost, BASE_FEE_LAMPORTS } from "../../src/lib/keeper-send.js";

describe("issue-332: extraLamports in estimateLamportCost", () => {
  it("without extraLamports: cost = base + priority + jitoTip", () => {
    const microLamports = 1_000;
    const cu = 100_000;
    const jitoTip = 200_000;
    const expected = BASE_FEE_LAMPORTS + Math.ceil((microLamports * cu) / 1_000_000) + jitoTip;
    expect(estimateLamportCost(microLamports, cu, jitoTip)).toBe(expected);
  });

  it("with extraLamports: cost includes rent", () => {
    const microLamports = 1_000;
    const cu = 100_000;
    const jitoTip = 200_000;
    const rentLamports = 2_039_280; // typical rent for 9347 bytes
    const withoutRent = estimateLamportCost(microLamports, cu, jitoTip);
    const withRent = estimateLamportCost(microLamports, cu, jitoTip, rentLamports);
    expect(withRent - withoutRent).toBe(rentLamports);
  });

  it("extraLamports defaults to 0", () => {
    expect(estimateLamportCost(0, 0, 0)).toBe(BASE_FEE_LAMPORTS);
    expect(estimateLamportCost(0, 0, 0, 0)).toBe(BASE_FEE_LAMPORTS);
  });
});
