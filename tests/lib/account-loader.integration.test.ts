/**
 * Integration test: connects to Helius LaserStream devnet, subscribes to the
 * mainnet percolator program owner filter, and verifies that account updates
 * arrive and are cached. Requires:
 *   INTEGRATION=true HELIUS_API_KEY=<key> pnpm test
 */
import { describe, it, expect } from "vitest";

const RUN = process.env.INTEGRATION === "true";

describe.skipIf(!RUN)("AccountLoader integration (Helius LaserStream devnet)", () => {
  it(
    "receives at least one account update within 30s",
    { timeout: 35_000 },
    async () => {
      const { AccountLoader } = await import("../../src/lib/account-loader.js");

      const apiKey = process.env.HELIUS_API_KEY;
      expect(apiKey, "HELIUS_API_KEY must be set for integration tests").toBeTruthy();

      // Devnet LaserStream endpoint
      const endpoint = process.env.HELIUS_LASERSTREAM_ENDPOINT ?? "https://mainnet.helius-rpc.com";

      const loader = new AccountLoader({
        apiKey: apiKey!,
        endpoint,
      });

      let received = 0;
      loader.onAccount(() => { received++; });

      await loader.start();

      // Wait up to 30s for at least one account update
      const deadline = Date.now() + 30_000;
      while (received === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      await loader.stop();

      expect(received).toBeGreaterThan(0);
      expect(loader.getStats().eventsReceived).toBeGreaterThan(0);
      // Cache should have entries
      expect(loader.getCache().size()).toBeGreaterThan(0);
    },
  );
});
