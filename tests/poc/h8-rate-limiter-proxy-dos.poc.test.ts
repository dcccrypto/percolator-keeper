/**
 * H8 PoC — Rate-limiter bucket collision via proxy IP spoofing
 *
 * THE BUG (pre-fix):
 *   /register and /admin/budget/resume extract the rate-limit key from
 *   req.socket.remoteAddress. Behind any L7 reverse proxy (Railway internal
 *   networking, any future ingress) the TCP connection comes from the proxy,
 *   so every caller — legitimate or not — shares ONE rate-limit bucket keyed
 *   on the proxy's loopback/internal IP.
 *
 *   An attacker with access to the endpoint can send 5 wrong x-shared-secret
 *   requests to exhaust REGISTER_RATE_MAX_FAILURES, after which every caller
 *   for the next 60s receives 429 — including percolator-launch's
 *   /api/oracle-keeper/register and the /admin/budget/resume circuit-breaker
 *   recovery call. Repeating this every 60s sustains the DoS indefinitely.
 *
 * THE FIX (this PR):
 *   KEEPER_TRUSTED_PROXY_DEPTH (default 0) controls how many proxy hops to
 *   peel off the X-Forwarded-For header. When depth > 0, getClientIp() picks
 *   the Nth-from-right entry so each real client has its own bucket. A forged
 *   leftmost entry cannot affect the rightmost-N extraction.
 *
 *   Default remains 0 (socket.remoteAddress) because the health server binds
 *   127.0.0.1 by default — no proxy hop means no forwarded header.
 */
import { describe, it, expect } from "vitest";
import type http from "node:http";

// ─── reproduce the old (buggy) extraction ───────────────────────────────────

function getClientIpOld(req: Pick<http.IncomingMessage, "socket">): string {
  return String((req.socket as { remoteAddress?: string }).remoteAddress ?? "unknown");
}

// ─── reproduce the new (fixed) extraction ───────────────────────────────────

function getClientIpNew(
  req: Pick<http.IncomingMessage, "socket" | "headers">,
  proxyDepth: number,
): string {
  if (proxyDepth > 0) {
    const forwarded = String((req.headers as Record<string, string>)["x-forwarded-for"] ?? "");
    if (forwarded) {
      const ips = forwarded.split(",").map((s) => s.trim());
      const idx = Math.max(0, ips.length - proxyDepth);
      return ips[idx] ?? String((req.socket as { remoteAddress?: string }).remoteAddress ?? "unknown");
    }
  }
  return String((req.socket as { remoteAddress?: string }).remoteAddress ?? "unknown");
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(remoteAddress: string, xForwardedFor?: string) {
  return {
    socket: { remoteAddress },
    headers: xForwardedFor ? { "x-forwarded-for": xForwardedFor } : {},
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("H8 PoC — rate-limiter proxy IP extraction", () => {
  describe("OLD path (BUGGY): all clients collapse into the proxy's IP", () => {
    it("caller A and caller B behind a proxy share the same rate-limit key — wrong path", () => {
      const proxyIp = "10.0.0.1"; // Railway internal IP — the proxy's address
      const reqA = makeReq(proxyIp, "203.0.113.10"); // real client A
      const reqB = makeReq(proxyIp, "203.0.113.20"); // real client B

      const keyA = getClientIpOld(reqA);
      const keyB = getClientIpOld(reqB);

      // Both resolve to the proxy IP — attacker burning A's quota also burns B's
      expect(keyA).toBe(proxyIp);
      expect(keyB).toBe(proxyIp);
      expect(keyA).toBe(keyB); // ← bucket collision: one attacker DoSes all callers
    });
  });

  describe("NEW path (FIXED): each real client gets its own bucket — right path", () => {
    it("depth=1: extracts the last X-Forwarded-For entry (the real client IP)", () => {
      const proxyIp = "10.0.0.1";
      const reqA = makeReq(proxyIp, "203.0.113.10");
      const reqB = makeReq(proxyIp, "203.0.113.20");

      const keyA = getClientIpNew(reqA, 1);
      const keyB = getClientIpNew(reqB, 1);

      expect(keyA).toBe("203.0.113.10");
      expect(keyB).toBe("203.0.113.20");
      expect(keyA).not.toBe(keyB); // ← each caller has its own bucket: DoS is isolated
    });

    it("depth=2: peels two proxy hops — takes second-to-last entry", () => {
      // X-Forwarded-For: <client>, <edge-proxy>, <internal-proxy> → depth=2 → <edge-proxy>
      const req = makeReq("10.0.0.2", "203.0.113.10, 172.16.0.5, 10.0.0.1");
      expect(getClientIpNew(req, 2)).toBe("172.16.0.5");
    });

    it("depth=1: forged leftmost entry does NOT affect the key", () => {
      // Attacker sends: X-Forwarded-For: <spoofed>, <real-client>
      // The proxy appends the real TCP peer; depth=1 uses only the rightmost entry.
      const req = makeReq("10.0.0.1", "1.1.1.1, 203.0.113.10");
      expect(getClientIpNew(req, 1)).toBe("203.0.113.10"); // spoofed 1.1.1.1 is ignored
    });

    it("depth=0 (default): falls back to socket.remoteAddress — loopback case unchanged", () => {
      const req = makeReq("127.0.0.1", "203.0.113.10");
      expect(getClientIpNew(req, 0)).toBe("127.0.0.1"); // loopback-only bind: no proxy
    });

    it("depth>0 with no X-Forwarded-For header: falls back to socket.remoteAddress", () => {
      const req = makeReq("127.0.0.1"); // no header
      expect(getClientIpNew(req, 1)).toBe("127.0.0.1");
    });
  });
});
