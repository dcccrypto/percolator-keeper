import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

// Mocks must be set BEFORE the SUT import — crank.ts depends on shared/sdk
// at module load via loadKeypair / config / etc.

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: {
      toBase58: () => "SysvarC1ock11111111111111111111111111111111",
      equals: () => false,
    },
  };
});

// Partial mock: real exports fill anything this factory does not override.
// A full-replacement mock silently breaks whenever the source under test
// imports a new SDK export (e.g. the v17 layout constants), and the failure
// surfaces as an unrelated "no export defined on the mock" at import time.
vi.mock("@percolatorct/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discoverMarkets: vi.fn(),
  encodeKeeperCrank: vi.fn(() => Buffer.from([1])),
  encodeUpdateHyperpMark: vi.fn(() => Buffer.from([2])),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  derivePythPushOraclePDA: vi.fn(() => [
    { toBase58: () => "11111111111111111111111111111111" },
    0,
  ]),
  detectDexType: vi.fn(() => "raydium-clmm"),
  parseDexPool: vi.fn(),
  fetchSlab: vi.fn(),
  parseHeader: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  ACCOUNTS_KEEPER_CRANK: {},
}));

vi.mock("@percolatorct/shared", () => ({
  config: {
    crankIntervalMs: 30_000,
    crankInactiveIntervalMs: 120_000,
    discoveryIntervalMs: 300_000,
    allProgramIds: ["11111111111111111111111111111111"],
    crankKeypair: "mock-keypair-path",
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getConnection: vi.fn(() => ({ getAccountInfo: vi.fn() })),
  getFallbackConnection: vi.fn(() => ({ getProgramAccounts: vi.fn() })),
  loadKeypair: vi.fn(() => ({
    publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => true },
    secretKey: new Uint8Array(64),
  })),
  sendWithRetry: vi.fn(async () => "sig"),
  sendWithRetryKeeper: vi.fn(async () => "sig"),
  rateLimitedCall: vi.fn((fn) => fn()),
  sendCriticalAlert: vi.fn(),
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({ select: vi.fn(() => ({ in: vi.fn(() => ({ data: [], error: null })) })) })),
  })),
  eventBus: { publish: vi.fn() },
  // BUG-110: src/lib/service-monitors.ts calls this at import time.
  createServiceMonitors: vi.fn(() => {
    const m = () => ({ recordSuccess: vi.fn(async () => {}), recordFailure: vi.fn(async () => {}), getErrorRate: vi.fn(() => 0), getStatus: vi.fn(() => ({ healthy: true, consecutiveFailures: 0, errorRate: 0, timeSinceSuccessMs: 0, alertActive: false })) });
    return { rpc: m(), scan: m(), oracle: m(), db: m() };
  }),
}));

import { processBatched } from "../../src/services/crank.js";

// A.15: succeeded + failed must always equal the input length, and a thrown
// error must be counted exactly once (never both as success AND failure).
describe("processBatched (A.15)", () => {
  type Outcome = "success" | "fail" | "throw" | "skip";

  function runWithOutcomes(outcomes: Outcome[]): Promise<{
    succeeded: number;
    failed: number;
    skipped: number;
    errors: Map<string, Error>;
  }> {
    const items = outcomes.map((_, i) => i);
    return processBatched(items, 5, 0, async (idx) => {
      const out = outcomes[idx as number]!;
      if (out === "throw") throw new Error(`thrown by item ${idx}`);
      if (out === "success") return "success";
      if (out === "skip") return "skipped";
      return "failed";
    });
  }

  it("succeeded + failed + skipped === items.length for a known mix", async () => {
    const { succeeded, failed, skipped } = await runWithOutcomes([
      "success", "fail", "throw", "success", "skip", "fail", "throw", "success", "success",
    ]);
    // 4 success, 1 skip, 2 fail, 2 throw → 4 succeeded, 4 failed, 1 skipped
    expect(succeeded + failed + skipped).toBe(9);
    expect(succeeded).toBe(4);
    expect(failed).toBe(4);
    expect(skipped).toBe(1);
  });

  it("thrown errors are counted as failed (not as success or skip), exactly once each", async () => {
    const { succeeded, failed, skipped, errors } = await runWithOutcomes(["throw", "throw", "throw"]);
    expect(succeeded).toBe(0);
    expect(failed).toBe(3);
    expect(skipped).toBe(0);
    expect(errors.size).toBe(3);
  });

  it("empty input → zero counts, zero errors", async () => {
    const { succeeded, failed, skipped, errors } = await runWithOutcomes([]);
    expect(succeeded).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toBe(0);
    expect(errors.size).toBe(0);
  });

  it("property: succeeded + failed + skipped always equals items.length across random mixes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>("success", "fail", "throw", "skip"), {
          minLength: 0,
          maxLength: 50,
        }),
        async (outcomes) => {
          const { succeeded, failed, skipped } = await runWithOutcomes(outcomes);
          return succeeded + failed + skipped === outcomes.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: succeeded matches the count of 'success' outcomes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>("success", "fail", "throw", "skip"), {
          minLength: 0,
          maxLength: 50,
        }),
        async (outcomes) => {
          const expected = outcomes.filter((o) => o === "success").length;
          const { succeeded } = await runWithOutcomes(outcomes);
          return succeeded === expected;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: skipped matches the count of 'skip' outcomes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>("success", "fail", "throw", "skip"), {
          minLength: 0,
          maxLength: 50,
        }),
        async (outcomes) => {
          const expected = outcomes.filter((o) => o === "skip").length;
          const { skipped } = await runWithOutcomes(outcomes);
          return skipped === expected;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: failed matches the count of 'fail' + 'throw' outcomes (no double-count)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>("success", "fail", "throw", "skip"), {
          minLength: 0,
          maxLength: 50,
        }),
        async (outcomes) => {
          const expected = outcomes.filter((o) => o === "fail" || o === "throw").length;
          const { failed } = await runWithOutcomes(outcomes);
          return failed === expected;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: errors map size equals the number of thrown outcomes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>("success", "fail", "throw", "skip"), {
          minLength: 0,
          maxLength: 50,
        }),
        async (outcomes) => {
          const expected = outcomes.filter((o) => o === "throw").length;
          const { errors } = await runWithOutcomes(outcomes);
          return errors.size === expected;
        },
      ),
      { numRuns: 100 },
    );
  });
});
