import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWarningAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/metrics.js", () => ({
  rpcRequestTotal: { inc: vi.fn() },
  rpcLatencyP50: { set: vi.fn() },
  rpcLatencyP99: { set: vi.fn() },
  rpcProviderHealthy: { set: vi.fn() },
  rpcFailoverTotal: { inc: vi.fn() },
  rpcSlotLag: { set: vi.fn() },
}));

import { RpcPool, _resetSharedRpcPool } from "../../src/lib/rpc-pool.js";
import type { RpcPoolConfig } from "../../src/config/rpc.js";
import { PublicKey } from "@solana/web3.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RpcPoolConfig> = {}): RpcPoolConfig {
  return {
    enabled: true,
    helius: { url: "https://helius.example.com", name: "helius" },
    alchemy: { url: "https://alchemy.example.com", name: "alchemy" },
    healthCheckIntervalMs: 5_000,
    unhealthyP99Ms: 2_000,
    unhealthySlotLag: 50,
    unhealthyConsecutiveFails: 5,
    recoveryWindowMs: 60_000,
    forceAlchemyGpa: true,
    ...overrides,
  };
}

function makeConn(overrides: Partial<{
  getSlot: () => Promise<number>;
  getAccountInfo: () => Promise<null>;
  getMultipleAccountsInfo: () => Promise<null[]>;
  getSignatureStatuses: () => Promise<{ value: null[] }>;
  getProgramAccounts: () => Promise<never[]>;
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}> = {}) {
  return {
    getSlot: vi.fn(async () => 1000),
    getAccountInfo: vi.fn(async () => null),
    getMultipleAccountsInfo: vi.fn(async () => []),
    getSignatureStatuses: vi.fn(async () => ({ value: [] })),
    getProgramAccounts: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "mock-blockhash",
      lastValidBlockHeight: 9999,
    })),
    ...overrides,
  } as any;
}

let t = 1_700_000_000_000;
const mockNow = () => t;

beforeEach(() => {
  t = 1_700_000_000_000;
  _resetSharedRpcPool();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetSharedRpcPool();
});

// ── Routing tests ─────────────────────────────────────────────────────────────

describe("RpcPool — routing", () => {
  it("read returns Helius response when Helius healthy", async () => {
    const helius = makeConn({ getAccountInfo: vi.fn(async () => ({ data: "helius" } as any)) });
    const alchemy = makeConn({ getAccountInfo: vi.fn(async () => ({ data: "alchemy" } as any)) });
    const pool = new RpcPool(helius as any, alchemy as any, { config: makeConfig(), now: mockNow });

    await pool.getAccountInfo(PublicKey.default);

    expect(helius.getAccountInfo).toHaveBeenCalledOnce();
    expect(alchemy.getAccountInfo).not.toHaveBeenCalled();
  });

  it("read returns Alchemy response when Helius unhealthy", async () => {
    const helius = makeConn({ getAccountInfo: vi.fn(async () => ({ data: "helius" } as any)) });
    const alchemy = makeConn({ getAccountInfo: vi.fn(async () => ({ data: "alchemy" } as any)) });
    const pool = new RpcPool(helius as any, alchemy as any, { config: makeConfig(), now: mockNow });

    // Force Helius unhealthy via consecutive fails.
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);

    await pool.getAccountInfo(PublicKey.default);

    expect(alchemy.getAccountInfo).toHaveBeenCalledOnce();
    expect(helius.getAccountInfo).not.toHaveBeenCalled();
  });

  it("getProgramAccounts always routes to Alchemy when RPC_FORCE_ALCHEMY_GPA=true", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ forceAlchemyGpa: true }),
      now: mockNow,
    });

    await pool.getProgramAccounts(PublicKey.default);

    expect(alchemy.getProgramAccounts).toHaveBeenCalledOnce();
    expect(helius.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("getProgramAccounts routes to Helius when forceAlchemyGpa=false and Helius healthy", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ forceAlchemyGpa: false }),
      now: mockNow,
    });

    await pool.getProgramAccounts(PublicKey.default);

    expect(helius.getProgramAccounts).toHaveBeenCalledOnce();
    expect(alchemy.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("disabled mode (RPC_POOL_ENABLED=false) always routes to Helius", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ enabled: false }),
      now: mockNow,
    });

    // Force Helius unhealthy — should still route to Helius in disabled mode.
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);

    await pool.getAccountInfo(PublicKey.default);

    expect(helius.getAccountInfo).toHaveBeenCalledOnce();
    expect(alchemy.getAccountInfo).not.toHaveBeenCalled();
  });

  it("fail-safe: both unhealthy → reads still go to Helius", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, { config: makeConfig(), now: mockNow });

    for (let i = 0; i < 5; i++) {
      pool.heliusHealth.recordFailure();
      pool.alchemyHealth.recordFailure();
    }
    pool.heliusHealth.evaluate(null);
    pool.alchemyHealth.evaluate(null);

    await pool.getAccountInfo(PublicKey.default);

    expect(helius.getAccountInfo).toHaveBeenCalledOnce();
    expect(alchemy.getAccountInfo).not.toHaveBeenCalled();
  });
});

// ── Health transition tests ───────────────────────────────────────────────────

describe("RpcPool — health transitions", () => {
  it("marks Helius unhealthy when P99 > 2000ms", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig(),
      now: mockNow,
    });
    for (let i = 0; i < 10; i++) pool.heliusHealth.recordSuccess(2_500);
    pool.heliusHealth.evaluate(null);
    expect(pool.heliusHealth.isHealthy).toBe(false);
  });

  it("marks Helius unhealthy when slot lag > 50", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig(),
      now: mockNow,
    });
    pool.heliusHealth.recordSlot(1000);
    pool.heliusHealth.evaluate(1060); // lag = 60
    expect(pool.heliusHealth.isHealthy).toBe(false);
  });

  it("marks Helius unhealthy on 5 consecutive fails", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig(),
      now: mockNow,
    });
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);
    expect(pool.heliusHealth.isHealthy).toBe(false);
  });

  it("failover triggers when Helius transitions healthy→unhealthy", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, { config: makeConfig(), now: mockNow });

    // Initially Helius is used.
    expect(pool.pickProvider("getAccountInfo")).toBe("helius");

    // Trigger unhealthy.
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);

    expect(pool.pickProvider("getAccountInfo")).toBe("alchemy");
  });

  it("recovery requires full 60s window meeting all 3 criteria", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig(),
      now: mockNow,
    });

    // Become unhealthy.
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);
    expect(pool.heliusHealth.isHealthy).toBe(false);

    // Add good samples + slot, then first clean evaluate starts recovery clock.
    for (let i = 0; i < 10; i++) pool.heliusHealth.recordSuccess(400);
    pool.heliusHealth.recordSlot(1000);
    pool.heliusHealth.evaluate(1005); // lag = 5 < 10; clock starts
    expect(pool.heliusHealth.isHealthy).toBe(false); // window not elapsed yet

    // Advance past the recovery window.
    t += 61_000;
    pool.heliusHealth.evaluate(1005);
    expect(pool.heliusHealth.isHealthy).toBe(true);
  });
});

// ── Write path tests ──────────────────────────────────────────────────────────

describe("RpcPool — write path", () => {
  it("writeConnection always returns the Helius connection regardless of health", () => {
    const helius = makeConn() as any;
    const alchemy = makeConn() as any;
    const pool = new RpcPool(helius, alchemy, { config: makeConfig(), now: mockNow });

    // Helius unhealthy.
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);

    expect(pool.writeConnection).toBe(helius);
  });

  it("writeConnection is independent of pool state — always Helius", () => {
    const helius = makeConn() as any;
    const alchemy = makeConn() as any;
    const pool = new RpcPool(helius, alchemy, { config: makeConfig(), now: mockNow });

    // Both unhealthy.
    for (let i = 0; i < 5; i++) {
      pool.heliusHealth.recordFailure();
      pool.alchemyHealth.recordFailure();
    }
    pool.heliusHealth.evaluate(null);
    pool.alchemyHealth.evaluate(null);

    expect(pool.writeConnection).toBe(helius);
  });
});

// ── pickProvider exhaustive cases ──────────────────────────────────────────────

describe("RpcPool — pickProvider", () => {
  it("returns helius when pool disabled regardless of health state", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ enabled: false }),
      now: mockNow,
    });
    for (let i = 0; i < 5; i++) pool.heliusHealth.recordFailure();
    pool.heliusHealth.evaluate(null);
    expect(pool.pickProvider("getSlot")).toBe("helius");
  });

  it("returns alchemy for getProgramAccounts when forceAlchemyGpa=true", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ forceAlchemyGpa: true }),
      now: mockNow,
    });
    expect(pool.pickProvider("getProgramAccounts")).toBe("alchemy");
  });

  it("returns helius for getProgramAccounts when forceAlchemyGpa=false and healthy", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ forceAlchemyGpa: false }),
      now: mockNow,
    });
    expect(pool.pickProvider("getProgramAccounts")).toBe("helius");
  });

  it("returns helius (fail-safe) when both unhealthy", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ forceAlchemyGpa: false }),
      now: mockNow,
    });
    for (let i = 0; i < 5; i++) {
      pool.heliusHealth.recordFailure();
      pool.alchemyHealth.recordFailure();
    }
    pool.heliusHealth.evaluate(null);
    pool.alchemyHealth.evaluate(null);
    expect(pool.pickProvider("getAccountInfo")).toBe("helius");
  });
});

// ── Lifecycle tests ───────────────────────────────────────────────────────────

describe("RpcPool — lifecycle", () => {
  it("start() is idempotent (no double-timer)", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ healthCheckIntervalMs: 999_999 }),
      now: mockNow,
    });
    pool.start();
    pool.start(); // second call should be a no-op
    pool.stop();
  });

  it("stop() clears the timer", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ healthCheckIntervalMs: 999_999 }),
      now: mockNow,
    });
    pool.start();
    pool.stop();
    // No assertions needed — main goal is no throw / no timer leak.
  });

  it("start() is a no-op when pool disabled", () => {
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig({ enabled: false }),
      now: mockNow,
    });
    pool.start(); // should not throw or spin up a timer
    pool.stop();
  });
});

// ── GPA fallback on Alchemy unhealthy (Fix 3) ────────────────────────────────

describe("RpcPool — GPA fallback when Alchemy unhealthy", () => {
  it("getProgramAccounts falls back to Helius when forceAlchemyGpa=true but Alchemy is unhealthy", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ forceAlchemyGpa: true }),
      now: mockNow,
    });

    // Mark Alchemy unhealthy via consecutive fails.
    for (let i = 0; i < 5; i++) pool.alchemyHealth.recordFailure();
    pool.alchemyHealth.evaluate(null);
    expect(pool.alchemyHealth.isHealthy).toBe(false);

    await pool.getProgramAccounts(PublicKey.default);

    // Must route to Helius — keeper can still operate, degraded.
    expect(helius.getProgramAccounts).toHaveBeenCalledOnce();
    expect(alchemy.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("getProgramAccounts routes to Alchemy when forceAlchemyGpa=true and Alchemy is healthy", async () => {
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ forceAlchemyGpa: true }),
      now: mockNow,
    });

    // Alchemy is healthy (default state).
    expect(pool.alchemyHealth.isHealthy).toBe(true);

    await pool.getProgramAccounts(PublicKey.default);

    expect(alchemy.getProgramAccounts).toHaveBeenCalledOnce();
    expect(helius.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("gpa_alchemy_unhealthy failover counter is bumped when Alchemy unhealthy during GPA", async () => {
    const metrics = await import("../../src/lib/metrics.js");
    const helius = makeConn();
    const alchemy = makeConn();
    const pool = new RpcPool(helius as any, alchemy as any, {
      config: makeConfig({ forceAlchemyGpa: true }),
      now: mockNow,
    });

    for (let i = 0; i < 5; i++) pool.alchemyHealth.recordFailure();
    pool.alchemyHealth.evaluate(null);
    vi.clearAllMocks();

    await pool.getProgramAccounts(PublicKey.default);

    expect(metrics.rpcFailoverTotal.inc).toHaveBeenCalledWith({
      from: "alchemy",
      to: "helius",
      reason: "gpa_alchemy_unhealthy",
    });
  });
});

// ── URL redaction (Fix 6) ─────────────────────────────────────────────────────

describe("RpcPool — URL redaction in start() log", () => {
  it("standard Alchemy URL shape: key after /v2/ is fully redacted", () => {
    const standardUrl = "https://solana-mainnet.g.alchemy.com/v2/abcdef1234567890abcdef1234567890";
    const redacted = standardUrl.replace(/\/v2\/.*/i, "/v2/<redacted>");
    expect(redacted).toBe("https://solana-mainnet.g.alchemy.com/v2/<redacted>");
    expect(redacted).not.toContain("abcdef");
  });

  it("short custom Alchemy URL shape: key after /v2/ is fully redacted regardless of base length", () => {
    const shortUrl = "https://my.alchemy.com/v2/SECRETKEY123";
    const redacted = shortUrl.replace(/\/v2\/.*/i, "/v2/<redacted>");
    expect(redacted).toBe("https://my.alchemy.com/v2/<redacted>");
    expect(redacted).not.toContain("SECRETKEY123");
  });

  it("URL without /v2/ path is returned unchanged (no key to strip)", () => {
    const noV2Url = "https://helius.xyz/mainnet-key-here";
    const redacted = noV2Url.replace(/\/v2\/.*/i, "/v2/<redacted>");
    expect(redacted).toBe(noV2Url); // no /v2/ segment — nothing to strip
  });
});

// ── Metric recording tests ────────────────────────────────────────────────────

describe("RpcPool — metric recording", () => {
  it("records rpcRequestTotal inc on successful read", async () => {
    const metrics = await import("../../src/lib/metrics.js");
    const pool = new RpcPool(makeConn() as any, makeConn() as any, {
      config: makeConfig(),
      now: mockNow,
    });
    vi.clearAllMocks();
    await pool.getSlot();
    expect(metrics.rpcRequestTotal.inc).toHaveBeenCalledWith({
      provider: "helius",
      method: "getSlot",
      result: "ok",
    });
  });

  it("records rpcRequestTotal fail on error", async () => {
    const metrics = await import("../../src/lib/metrics.js");
    const failConn = makeConn({
      getSlot: vi.fn(async () => { throw new Error("rpc down"); }),
    });
    const pool = new RpcPool(failConn as any, makeConn() as any, {
      config: makeConfig({ forceAlchemyGpa: false }),
      now: mockNow,
    });
    vi.clearAllMocks();
    await expect(pool.getSlot()).rejects.toThrow("rpc down");
    expect(metrics.rpcRequestTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "helius", method: "getSlot", result: "fail" }),
    );
  });
});
