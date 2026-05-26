import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("getRedisClient", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.KEEPER_REDIS_URL;
    delete process.env.KEEPER_REDIS_TOKEN;
  });

  afterEach(() => {
    delete process.env.KEEPER_REDIS_URL;
    delete process.env.KEEPER_REDIS_TOKEN;
  });

  it("returns null when KEEPER_REDIS_URL is unset", async () => {
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    const client = getRedisClient();
    expect(client).toBeNull();
  });

  it("returns a client when KEEPER_REDIS_URL is set", async () => {
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    process.env.KEEPER_REDIS_TOKEN = "fake-token";
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    const client = getRedisClient();
    expect(client).not.toBeNull();
    expect(typeof client!.set).toBe("function");
    expect(typeof client!.get).toBe("function");
    expect(typeof client!.del).toBe("function");
  });

  it("returns the same instance on repeated calls (singleton)", async () => {
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    process.env.KEEPER_REDIS_TOKEN = "fake-token";
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    const a = getRedisClient();
    const b = getRedisClient();
    expect(a).toBe(b);
  });

  it("returns null singleton after null is cached (no URL)", async () => {
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    expect(getRedisClient()).toBeNull();
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    expect(getRedisClient()).toBeNull();
  });

  // A.4 (HIGH): refuse to construct the client when the URL is set without a
  // non-empty token. The legacy fallback `new Redis({ url, token: "" })`
  // permitted token-less access to Upstash — an access-control gap.
  it("A.4: throws when KEEPER_REDIS_URL is set but KEEPER_REDIS_TOKEN is unset", async () => {
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    delete process.env.KEEPER_REDIS_TOKEN;
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    expect(() => getRedisClient()).toThrow(/KEEPER_REDIS_TOKEN/);
  });

  it("A.4: throws when KEEPER_REDIS_URL is set but KEEPER_REDIS_TOKEN is empty string", async () => {
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    process.env.KEEPER_REDIS_TOKEN = "";
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    expect(() => getRedisClient()).toThrow(/KEEPER_REDIS_TOKEN/);
  });

  it("A.4: throws when KEEPER_REDIS_TOKEN is only whitespace", async () => {
    process.env.KEEPER_REDIS_URL = "https://fake-host.upstash.io";
    process.env.KEEPER_REDIS_TOKEN = "   ";
    const { getRedisClient } = await import("../../src/lib/redis-client.js");
    expect(() => getRedisClient()).toThrow(/KEEPER_REDIS_TOKEN/);
  });
});
