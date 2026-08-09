import { describe, it, expect } from "vitest";
import { decideHealthExposure } from "../../src/lib/health-auth.js";

/**
 * KEEPER-10 / #358: when KEEPER_HEALTH_BIND_ADDR is a remote address and
 * KEEPER_REGISTER_SECRET is unset, /health, /pause-status and /shadow/report
 * failed OPEN (#321) — exposing keeperWallet.solBalance, budget circuit-breaker
 * state and the stale-oracle market list to any internet client.
 *
 * The obvious fix is to 503 those requests. That trades a data leak for an
 * availability regression: railway.toml points its healthcheck at /health, and
 * index.ts maps status "down" to 503 and everything else to 200, so the platform
 * restarts a genuinely-down keeper. A blanket 503 makes every deploy fail its
 * healthcheck, and repointing the probe at a liveness URL throws away
 * restart-on-unhealthy — which railway.toml's own comment says was deliberately
 * restored (M-2) after being removed as a workaround.
 *
 * So: unauthenticated remote callers get a REDUCED body at the normal status
 * code. Nothing operational leaks, the platform still sees real health, and no
 * operator has to migrate a probe URL.
 */
describe("decideHealthExposure", () => {
  const SECRET = "s3cret";

  describe("loopback bind (the default)", () => {
    it.each(["127.0.0.1", "localhost", "::1"])("returns full detail on %s", (addr) => {
      expect(
        decideHealthExposure({ bindAddr: addr, registerSecret: "", providedSecret: "" }),
      ).toBe("full");
    });

    it("returns full detail on loopback even when a secret is configured", () => {
      expect(
        decideHealthExposure({ bindAddr: "127.0.0.1", registerSecret: SECRET, providedSecret: "" }),
      ).toBe("full");
    });
  });

  describe("remote bind", () => {
    it("returns full detail when the caller presents the matching secret", () => {
      expect(
        decideHealthExposure({
          bindAddr: "0.0.0.0",
          registerSecret: SECRET,
          providedSecret: SECRET,
        }),
      ).toBe("full");
    });

    it("returns 401 when a secret is configured and the caller presents the wrong one", () => {
      expect(
        decideHealthExposure({
          bindAddr: "0.0.0.0",
          registerSecret: SECRET,
          providedSecret: "wrong",
        }),
      ).toBe("unauthorized");
    });

    it("returns 401 when a secret is configured and the caller presents none", () => {
      expect(
        decideHealthExposure({ bindAddr: "0.0.0.0", registerSecret: SECRET, providedSecret: "" }),
      ).toBe("unauthorized");
    });

    it("REDUCES rather than failing open when no secret is configured", () => {
      // This is the #358 hole. It must not stay "full"...
      expect(
        decideHealthExposure({ bindAddr: "0.0.0.0", registerSecret: "", providedSecret: "" }),
      ).toBe("reduced");
    });

    it("does not 401 an unauthenticated caller when no secret is configured", () => {
      // ...and it must not 503/401 either, or the Railway healthcheck fails and
      // the container restart-loops on a keeper that is actually healthy.
      const decision = decideHealthExposure({
        bindAddr: "0.0.0.0",
        registerSecret: "",
        providedSecret: "",
      });
      expect(decision).not.toBe("unauthorized");
    });

    it("ignores a presented secret when none is configured", () => {
      expect(
        decideHealthExposure({ bindAddr: "0.0.0.0", registerSecret: "", providedSecret: "guess" }),
      ).toBe("reduced");
    });

    it("compares secrets of differing length without throwing", () => {
      // timingSafeEqual requires equal-length buffers; a length mismatch must be
      // a rejection, not a crash that takes the health server down.
      expect(() =>
        decideHealthExposure({
          bindAddr: "0.0.0.0",
          registerSecret: SECRET,
          providedSecret: "much-longer-than-the-secret",
        }),
      ).not.toThrow();
      expect(
        decideHealthExposure({
          bindAddr: "0.0.0.0",
          registerSecret: SECRET,
          providedSecret: "much-longer-than-the-secret",
        }),
      ).toBe("unauthorized");
    });
  });
});
