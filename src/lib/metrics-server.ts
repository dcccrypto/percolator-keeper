import http from "node:http";
import { createLogger } from "@percolatorct/shared";
import { getRegistry } from "./metrics.js";

const logger = createLogger("keeper:metrics-server");

const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

let server: http.Server | null = null;

export function start(): void {
  if (server) return;

  const port = Number(process.env.KEEPER_METRICS_PORT ?? 9465);

  server = http.createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    try {
      const body = await getRegistry().metrics();
      res.writeHead(200, {
        "Content-Type": METRICS_CONTENT_TYPE,
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch (err) {
      logger.error("Failed to serialize Prometheus metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  // A.8 (HIGH): bind to loopback only. /metrics exposes wallet balance, halt
  // state, and HA role; the legacy 2-arg listen(port, cb) defaulted to
  // 0.0.0.0 — publicly visible on any deploy without an explicit firewall
  // rule. Operators that need remote scraping must use a sidecar/proxy
  // (e.g. Prometheus pull via SSH tunnel or an auth-protected sidecar).
  server.listen(port, "127.0.0.1", () => {
    logger.info("Metrics server started", { port, host: "127.0.0.1" });
  });

  server.on("error", (err) => {
    logger.error("Metrics server error", { error: err.message });
  });
}

/** A.8: diagnostic for tests to confirm bind address. */
export function address(): import("node:net").AddressInfo | null {
  if (!server) return null;
  const a = server.address();
  return typeof a === "string" ? null : a;
}

export function stop(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => {
      server = null;
      if (err) {
        reject(err);
      } else {
        logger.info("Metrics server stopped");
        resolve();
      }
    });
  });
}
