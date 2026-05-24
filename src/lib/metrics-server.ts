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

  server.listen(port, () => {
    logger.info("Metrics server started", { port });
  });

  server.on("error", (err) => {
    logger.error("Metrics server error", { error: err.message });
  });
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
