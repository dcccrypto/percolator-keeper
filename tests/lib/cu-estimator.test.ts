import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { CuEstimator } from "../../src/lib/cu-estimator.js";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

function makeDummyIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: PublicKey.default,
    keys: [],
    data: Buffer.from([]),
  });
}

function makeConnection(unitsConsumed: number | undefined, err: string | null = null) {
  return {
    simulateTransaction: vi.fn(async () => ({
      value: {
        err,
        logs: [],
        unitsConsumed,
      },
    })),
  } as any;
}

describe("CuEstimator", () => {
  it("returns ceil(unitsConsumed * margin) on success", async () => {
    const conn = makeConnection(100_000);
    const estimator = new CuEstimator({ margin: 1.1, fallback: 1_400_000 });

    const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);

    expect(result).toBe(Math.ceil(100_000 * 1.1));
  });

  it("returns fallback when unitsConsumed is 0", async () => {
    const conn = makeConnection(0);
    const estimator = new CuEstimator({ margin: 1.1, fallback: 1_400_000 });

    const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);

    expect(result).toBe(1_400_000);
  });

  it("returns fallback when unitsConsumed is undefined", async () => {
    const conn = makeConnection(undefined);
    const estimator = new CuEstimator({ margin: 1.1, fallback: 500_000 });

    const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);

    expect(result).toBe(500_000);
  });

  it("returns fallback when simulateTransaction throws", async () => {
    const conn = {
      simulateTransaction: vi.fn(async () => {
        throw new Error("RPC error");
      }),
    } as any;
    const estimator = new CuEstimator({ margin: 1.1, fallback: 1_400_000 });

    const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);

    expect(result).toBe(1_400_000);
  });

  it("reads KEEPER_CU_SIMULATE_MARGIN and KEEPER_CU_FALLBACK_LIMIT from env", async () => {
    const origMargin = process.env.KEEPER_CU_SIMULATE_MARGIN;
    const origFallback = process.env.KEEPER_CU_FALLBACK_LIMIT;
    process.env.KEEPER_CU_SIMULATE_MARGIN = "1.25";
    process.env.KEEPER_CU_FALLBACK_LIMIT = "800000";
    try {
      const conn = makeConnection(200_000);
      const estimator = new CuEstimator();
      const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);
      expect(result).toBe(Math.ceil(200_000 * 1.25));
    } finally {
      if (origMargin === undefined) delete process.env.KEEPER_CU_SIMULATE_MARGIN;
      else process.env.KEEPER_CU_SIMULATE_MARGIN = origMargin;
      if (origFallback === undefined) delete process.env.KEEPER_CU_FALLBACK_LIMIT;
      else process.env.KEEPER_CU_FALLBACK_LIMIT = origFallback;
    }
  });

  it("uses fallback from env when simulation fails", async () => {
    const origFallback = process.env.KEEPER_CU_FALLBACK_LIMIT;
    process.env.KEEPER_CU_FALLBACK_LIMIT = "750000";
    try {
      const conn = {
        simulateTransaction: vi.fn(async () => { throw new Error("net"); }),
      } as any;
      const estimator = new CuEstimator();
      const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);
      expect(result).toBe(750_000);
    } finally {
      if (origFallback === undefined) delete process.env.KEEPER_CU_FALLBACK_LIMIT;
      else process.env.KEEPER_CU_FALLBACK_LIMIT = origFallback;
    }
  });

  it("passes replaceRecentBlockhash:true and sigVerify:false to simulateTransaction", async () => {
    const conn = makeConnection(50_000);
    const estimator = new CuEstimator({ margin: 1.0, fallback: 1_400_000 });

    await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);

    expect(conn.simulateTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        replaceRecentBlockhash: true,
        sigVerify: false,
      }),
    );
  });

  // A.12: properties protect the CU-margin math. If the estimator ever returns
  // a value below `consumed`, the CU limit on-chain would be too tight and
  // the tx would land with InsufficientComputeUnits.
  describe("A.12: property tests", () => {
    it("property: result >= consumed for any consumed > 0 and margin >= 1.0", () => {
      fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_400_000 }),
          fc.double({ min: 1.0, max: 3.0, noNaN: true }),
          async (consumed, margin) => {
            const conn = makeConnection(consumed);
            const estimator = new CuEstimator({ margin, fallback: 1_400_000 });
            const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);
            return result >= consumed;
          },
        ),
        { numRuns: 200 },
      );
    });

    it("property: for consumed == 0, always returns the configured fallback", () => {
      fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_400_000 }),
          fc.double({ min: 1.0, max: 3.0, noNaN: true }),
          async (fallback, margin) => {
            const conn = makeConnection(0);
            const estimator = new CuEstimator({ margin, fallback });
            const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);
            return result === fallback;
          },
        ),
        { numRuns: 200 },
      );
    });

    it("property: result >= 1 for any consumed >= 1 (no zero/negative)", () => {
      fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_400_000 }),
          async (consumed) => {
            const conn = makeConnection(consumed);
            const estimator = new CuEstimator({ margin: 1.1, fallback: 1_400_000 });
            const result = await estimator.estimate(conn, [makeDummyIx()], [Keypair.generate()]);
            return result >= 1;
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
