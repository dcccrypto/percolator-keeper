import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The singleton exists to parse CRANK_KEYPAIR once instead of three times
 * (index.ts, CrankService, LiquidationService each called loadKeypair
 * independently). It must do that WITHOUT mutating process.env.
 *
 * The original implementation overwrote and then deleted the variable, on the
 * theory that this kept the secret out of heap dumps. It does not: V8 strings
 * are immutable, so `process.env.X = "0".repeat(n)` allocates a new string and
 * leaves the original untouched until GC. What the deletion did achieve was
 * breaking every consumer that reads the variable after the first call —
 * 23 tests across crank.test.ts, crank.b-fixes.test.ts and liquidation.test.ts
 * failed with "CRANK_KEYPAIR is not set" because vitest shares one worker
 * process across files.
 */

const hoisted = vi.hoisted(() => ({ parses: 0 }));

vi.mock("@percolatorct/shared", () => ({
  // A fresh object per call, so object identity proves the cache is real
  // rather than proving the mock returns a constant.
  loadKeypair: vi.fn((raw: string) => {
    hoisted.parses += 1;
    return { parsedFrom: raw, secretKey: new Uint8Array(64) };
  }),
}));

const RAW = "[1,2,3,4]";
const ORIGINAL = process.env.CRANK_KEYPAIR;

async function freshModule() {
  vi.resetModules();
  hoisted.parses = 0;
  return import("../../src/lib/keypair-singleton.js");
}

describe("getKeeperKeypair", () => {
  beforeEach(() => {
    process.env.CRANK_KEYPAIR = RAW;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRANK_KEYPAIR;
    else process.env.CRANK_KEYPAIR = ORIGINAL;
  });

  it("parses CRANK_KEYPAIR once and returns that same instance thereafter", async () => {
    const { getKeeperKeypair } = await freshModule();

    const first = getKeeperKeypair();
    const second = getKeeperKeypair();
    const third = getKeeperKeypair();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(hoisted.parses).toBe(1);
  });

  it("leaves process.env.CRANK_KEYPAIR readable after the first call", async () => {
    const { getKeeperKeypair } = await freshModule();

    getKeeperKeypair();

    expect(process.env.CRANK_KEYPAIR).toBe(RAW);
  });

  it("still resolves for a consumer constructed after the first call", async () => {
    // The regression this guards: services are constructed at different times,
    // and CrankService/LiquidationService resolve the keypair after index.ts
    // has already resolved it. Deleting the env var made the later ones throw.
    const { getKeeperKeypair } = await freshModule();
    getKeeperKeypair();

    let later: unknown;
    expect(() => {
      later = getKeeperKeypair();
    }).not.toThrow();
    expect(later).toBeDefined();
  });

  it("passes the raw env value through to loadKeypair unmodified", async () => {
    const { getKeeperKeypair } = await freshModule();

    const kp = getKeeperKeypair() as unknown as { parsedFrom: string };

    expect(kp.parsedFrom).toBe(RAW);
  });
});
