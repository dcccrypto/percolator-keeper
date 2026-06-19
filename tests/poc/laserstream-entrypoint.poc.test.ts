/**
 * PoC — KEEPER_USE_LASERSTREAM=true did not activate LaserStream in production.
 *
 * Before the fix, CrankService and LiquidationService had AccountLoader-aware
 * fast paths, but src/index.ts still constructed both services without an
 * AccountLoader and never started one. Setting KEEPER_USE_LASERSTREAM=true in
 * production therefore left the event-driven cache and liquidation trigger dead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLaserStreamAccountLoader,
  laserStreamEnabled,
  parseLaserStreamAdditionalAccounts,
} from "../../src/lib/laserstream-entrypoint.js";

class FakeLoader {
  static lastOpts: unknown;
  constructor(opts: unknown) {
    FakeLoader.lastOpts = opts;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("LaserStream production entrypoint wiring", () => {
  it("PoC: index.ts injects and starts the AccountLoader when LaserStream is enabled", () => {
    const source = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf8");

    expect(source).toContain("createLaserStreamAccountLoader");
    expect(source).toMatch(/new CrankService\(oracleService,\s*undefined,\s*accountLoader \?\? undefined\)/);
    expect(source).toMatch(/new LiquidationService\(oracleService,\s*undefined,\s*accountLoader \?\? undefined\)/);
    expect(source).toContain("await accountLoader.start()");
    expect(source).toContain("await accountLoader.stop()");
  });

  it("does not construct a loader unless KEEPER_USE_LASERSTREAM is explicitly true", () => {
    const getConnection = vi.fn();
    const loader = createLaserStreamAccountLoader({
      env: { KEEPER_USE_LASERSTREAM: "false" },
      programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
      getConnection,
      Loader: FakeLoader as never,
    });

    expect(loader).toBeNull();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("fails closed at boot when the feature flag is set without LaserStream credentials", () => {
    expect(() =>
      createLaserStreamAccountLoader({
        env: { KEEPER_USE_LASERSTREAM: "true" },
        programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
        getConnection: vi.fn(),
        Loader: FakeLoader as never,
      }),
    ).toThrow(/HELIUS_API_KEY/);

    expect(() =>
      createLaserStreamAccountLoader({
        env: { KEEPER_USE_LASERSTREAM: "true", HELIUS_API_KEY: "key" },
        programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
        getConnection: vi.fn(),
        Loader: FakeLoader as never,
      }),
    ).toThrow(/HELIUS_LASERSTREAM_ENDPOINT/);
  });

  it("builds AccountLoader options from production env and wires drift alerts", async () => {
    const warn = vi.fn();
    const sendWarningAlert = vi.fn(async () => {});
    const connection = { getSlot: vi.fn(async () => 4242) };

    const loader = createLaserStreamAccountLoader({
      env: {
        KEEPER_USE_LASERSTREAM: "true",
        HELIUS_API_KEY: " helius-key ",
        HELIUS_LASERSTREAM_ENDPOINT: " https://laserstream.example ",
        KEEPER_LASERSTREAM_ADDITIONAL_ACCOUNTS: "So11111111111111111111111111111111111111112, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
      getConnection: () => connection as never,
      logger: { warn },
      sendWarningAlert,
      Loader: FakeLoader as never,
    });

    expect(loader).toBeInstanceOf(FakeLoader);
    const opts = FakeLoader.lastOpts as {
      apiKey: string;
      endpoint: string;
      programId: string;
      additionalAccounts: string[];
      connection: typeof connection;
      getRpcSlot: () => Promise<number>;
      onDriftAlert: (drift: number) => void;
    };

    expect(opts.apiKey).toBe("helius-key");
    expect(opts.endpoint).toBe("https://laserstream.example");
    expect(opts.programId).toBe("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");
    expect(opts.additionalAccounts).toEqual([
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ]);
    expect(opts.connection).toBe(connection);
    await expect(opts.getRpcSlot()).resolves.toBe(4242);

    opts.onDriftAlert(77);
    expect(warn).toHaveBeenCalledWith("LaserStream slot drift exceeds threshold", { drift: 77 });
    expect(sendWarningAlert).toHaveBeenCalledWith(
      "LaserStream stream lagging RPC",
      expect.arrayContaining([{ name: "Slot Drift", value: "77", inline: true }]),
    );
  });

  it("parses feature flag and additional-account env shape", () => {
    expect(laserStreamEnabled({ KEEPER_USE_LASERSTREAM: "true" })).toBe(true);
    expect(laserStreamEnabled({ KEEPER_USE_LASERSTREAM: "TRUE" })).toBe(false);
    expect(parseLaserStreamAdditionalAccounts(" a,b   c\n\td ")).toEqual(["a", "b", "c", "d"]);
  });
});
