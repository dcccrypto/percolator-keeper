import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";

const METRICS_PORT = 19465;

async function startServer(): Promise<{ start: () => void; stop: () => Promise<void> }> {
  process.env.KEEPER_METRICS_PORT = String(METRICS_PORT);
  const mod = await import("../../src/lib/metrics-server.js");
  return mod;
}

function getMetrics(): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${METRICS_PORT}/metrics`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"],
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function get404(path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${METRICS_PORT}${path}`, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("metrics-server", () => {
  let serverMod: Awaited<ReturnType<typeof startServer>> | null = null;

  afterEach(async () => {
    if (serverMod) {
      await serverMod.stop();
      serverMod = null;
      await waitMs(50);
    }
    delete process.env.KEEPER_METRICS_PORT;
  });

  it("starts and serves GET /metrics with 200", async () => {
    serverMod = await startServer();
    serverMod.start();
    await waitMs(80);

    const result = await getMetrics();
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("text/plain");
    expect(result.contentType).toContain("version=0.0.4");
  });

  it("GET /metrics returns valid Prometheus exposition format", async () => {
    serverMod = await startServer();
    serverMod.start();
    await waitMs(80);

    const result = await getMetrics();
    expect(result.status).toBe(200);
    expect(result.body).toContain("# HELP");
    expect(result.body).toContain("# TYPE");
    expect(result.body).toContain("keeper_tx_sent_total");
    expect(result.body).toContain("keeper_wallet_balance_sol");
    expect(result.body).toContain("keeper_cycle_duration_seconds");
  });

  it("returns 404 for unknown paths", async () => {
    serverMod = await startServer();
    serverMod.start();
    await waitMs(80);

    const result = await get404("/health");
    expect(result.status).toBe(404);
  });

  it("stop() resolves cleanly and server becomes unreachable", async () => {
    serverMod = await startServer();
    serverMod.start();
    await waitMs(80);

    await serverMod.stop();
    serverMod = null;

    await expect(getMetrics()).rejects.toThrow();
  });

  it("calling start() twice does not open a second listener", async () => {
    serverMod = await startServer();
    serverMod.start();
    serverMod.start();
    await waitMs(80);

    const result = await getMetrics();
    expect(result.status).toBe(200);
  });

  // A.8 (HIGH): metrics expose wallet balance, halt state, HA role.
  // Default listen(port) binds 0.0.0.0 — public on any deploy with an open
  // firewall. Lock to loopback; operators must use a sidecar/proxy if they
  // need remote scrape access.
  it("A.8: binds to 127.0.0.1 only (loopback)", async () => {
    serverMod = await startServer();
    serverMod.start();
    await waitMs(80);

    const addr = (serverMod as any).address();
    expect(addr).not.toBeNull();
    expect(addr.address).toBe("127.0.0.1");
  });
});
