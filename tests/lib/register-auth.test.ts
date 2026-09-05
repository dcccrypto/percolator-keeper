import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  authenticateRegister,
  registerSignedString,
  MAX_SIGNATURE_AGE_MS,
} from "../../src/lib/register-auth.js";

/**
 * GH#2533 — `POST /register` only ever checked `x-shared-secret`, while the
 * launch app sends an HMAC and no shared secret. Every hot-registration 401'd,
 * and the app surfaced it as "Keeper unreachable — market will auto-discover on
 * next cycle", which is indistinguishable from the keeper being down.
 *
 * The first test is that exact production request. It is the one that would have
 * caught this.
 */

const SECRET = "test-register-secret-value";
const NOW = 1_756_900_000_000;

/** Signs the way percolator-launch `app/lib/keeper-hmac.ts` signs. */
function signLikeLaunch(secret: string, timestamp: string, method: string, path: string, body: string) {
  return createHmac("sha256", secret)
    .update([timestamp, method.toUpperCase(), path, body].join("\n"))
    .digest("hex");
}

const BODY = JSON.stringify({
  slabAddress: "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV",
  mainnetCA: "So11111111111111111111111111111111111111112",
});

function hmacRequest(over: Partial<Parameters<typeof authenticateRegister>[0]> = {}) {
  const timestamp = String(NOW);
  return authenticateRegister({
    secret: SECRET,
    providedSecret: "",
    timestamp,
    signature: signLikeLaunch(SECRET, timestamp, "POST", "/register", BODY),
    rawBody: BODY,
    method: "POST",
    path: "/register",
    now: NOW,
    ...over,
  });
}

describe("register auth accepts the HMAC the launch app actually sends (GH#2533)", () => {
  it("accepts the exact production request shape — the #2533 regression", () => {
    // No x-shared-secret at all, because the app does not send one. This is the
    // request that was 401ing in production.
    const out = hmacRequest();
    expect(out).toEqual({ ok: true, scheme: "hmac" });
  });

  it("still accepts the legacy shared secret, for operators and /admin parity", () => {
    const out = authenticateRegister({
      secret: SECRET,
      providedSecret: SECRET,
      timestamp: "",
      signature: "",
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now: NOW,
    });
    expect(out).toEqual({ ok: true, scheme: "shared-secret" });
  });

  it("rejects a request carrying neither credential", () => {
    const out = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp: "",
      signature: "",
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ reason: "no-credential" });
  });

  it("rejects when the endpoint has no secret configured", () => {
    const out = hmacRequest({ secret: "" });
    expect(out).toMatchObject({ ok: false, reason: "not-configured" });
  });
});

describe("the signature actually covers what it claims to", () => {
  it("a tampered BODY invalidates it", () => {
    // The whole reason to sign the body: a proxy that swaps the slab must fail.
    const evil = JSON.stringify({ slabAddress: "EviLSLab1111111111111111111111111111111111" });
    const out = hmacRequest({ rawBody: evil });
    expect(out).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("a different PATH invalidates it — launch #2476 binding", () => {
    // A signature captured for /register must not authorise another endpoint
    // that happens to accept the same body.
    const out = hmacRequest({ path: "/admin/budget/resume" });
    expect(out).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("a different METHOD invalidates it", () => {
    const out = hmacRequest({ method: "PATCH" });
    expect(out).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("a signature made with the wrong secret is rejected", () => {
    const timestamp = String(NOW);
    const out = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp,
      signature: signLikeLaunch("wrong-secret", timestamp, "POST", "/register", BODY),
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now: NOW,
    });
    expect(out).toMatchObject({ ok: false, reason: "bad-signature" });
  });
});

describe("the replay window is finite and symmetric", () => {
  it("accepts a timestamp just inside the window", () => {
    const out = hmacRequest({ now: NOW + MAX_SIGNATURE_AGE_MS - 1_000 });
    expect(out.ok).toBe(true);
  });

  it("rejects a timestamp just outside it", () => {
    const out = hmacRequest({ now: NOW + MAX_SIGNATURE_AGE_MS + 1_000 });
    expect(out).toMatchObject({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a FUTURE timestamp too — the window is symmetric", () => {
    // A far-future timestamp is as suspicious as an old one, and skew cuts both
    // ways. A one-sided check would let a captured signature be pre-dated.
    const out = hmacRequest({ now: NOW - MAX_SIGNATURE_AGE_MS - 1_000 });
    expect(out).toMatchObject({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a non-numeric timestamp rather than coercing it", () => {
    const out = hmacRequest({ timestamp: "not-a-number" });
    expect(out).toMatchObject({ ok: false, reason: "bad-timestamp" });
  });
});

describe("a failed HMAC does not fall through to the other scheme", () => {
  it("presenting a bad signature AND a valid shared secret is still rejected", () => {
    // A caller that chose the HMAC path and got it wrong is not then invited to
    // try a different credential in the same request. Falling through would let
    // an attacker who knows the shared secret bypass the payload binding.
    const out = authenticateRegister({
      secret: SECRET,
      providedSecret: SECRET, // valid!
      timestamp: String(NOW),
      signature: "00".repeat(32), // wrong
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now: NOW,
    });
    expect(out).toMatchObject({ ok: false, reason: "bad-signature" });
  });
});

describe("registerSignedString matches launch's signer byte for byte", () => {
  it("is timestamp \\n METHOD \\n path \\n body", () => {
    // Pinned literally. If either side reorders or changes the separator, the
    // signature stops verifying — and it stops verifying at market-creation
    // time, which is a bad moment to find out. That is how #2533 hid.
    expect(registerSignedString("123", "post", "/register", "{}")).toBe(
      "123\nPOST\n/register\n{}",
    );
  });

  it("upper-cases the method so a lowercase sender still verifies", () => {
    expect(registerSignedString("1", "post", "/x", "b")).toBe(
      registerSignedString("1", "POST", "/x", "b"),
    );
  });
});

/**
 * CROSS-REPO CONTRACT.
 *
 * Every other test here signs with `registerSignedString` and verifies with
 * `authenticateRegister` — a closed loop that agrees with itself no matter what the
 * launch app does. That is how #2533 shipped "fixed" twice.
 *
 * These hard-code launch's algorithm instead of importing anything, so the only way
 * they pass is if the keeper accepts bytes shaped the way percolator-launch actually
 * shapes them.
 */
describe("the keeper accepts what percolator-launch actually sends (GH#2533)", () => {
  const SECRET = "s3cr3t-register-key";
  const BODY = JSON.stringify({ slab: "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV" });

  /**
   * Verbatim reimplementation of `signedString` + `signKeeperRequest` from
   * percolator-launch `app/lib/keeper-hmac.ts` @ `playground` (994b03a9, #2476):
   *
   *   [timestamp, method.toUpperCase(), path, rawBody].join("\n")
   *
   * Deliberately NOT imported from src/. If the two repos drift, THIS must be what
   * fails.
   */
  function signAsLaunchDoes(
    secret: string,
    rawBody: string,
    timestamp: string,
    method: string,
    path: string,
  ): string {
    return createHmac("sha256", secret)
      .update([timestamp, method.toUpperCase(), path, rawBody].join("\n"))
      .digest("hex");
  }

  it("accepts a signature produced by the live launch app", () => {
    const now = Date.now();
    const timestamp = String(now);
    const result = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp,
      signature: signAsLaunchDoes(SECRET, BODY, timestamp, "POST", "/register"),
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now,
    });
    expect(result).toEqual({ ok: true, scheme: "hmac" });
  });

  it("REFUSES the unbound dot-joined form", () => {
    // A previous revision accepted `${timestamp}.${rawBody}` on the false premise
    // that launch still sent it. Accepting an unbound signature defeats #2476: it
    // is valid for the same body at ANY endpoint sharing the secret.
    const now = Date.now();
    const timestamp = String(now);
    const unbound = createHmac("sha256", SECRET)
      .update(`${timestamp}.${BODY}`)
      .digest("hex");
    const result = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp,
      signature: unbound,
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("REFUSES a signature bound to a different path", () => {
    // The property #2476 buys, asserted directly rather than assumed.
    const now = Date.now();
    const timestamp = String(now);
    const result = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp,
      signature: signAsLaunchDoes(SECRET, BODY, timestamp, "POST", "/admin/budget/resume"),
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("REFUSES a signature bound to a different method", () => {
    const now = Date.now();
    const timestamp = String(now);
    const result = authenticateRegister({
      secret: SECRET,
      providedSecret: "",
      timestamp,
      signature: signAsLaunchDoes(SECRET, BODY, timestamp, "GET", "/register"),
      rawBody: BODY,
      method: "POST",
      path: "/register",
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("still refuses a wrong secret and a tampered body", () => {
    const now = Date.now();
    const timestamp = String(now);
    expect(
      authenticateRegister({
        secret: SECRET,
        providedSecret: "",
        timestamp,
        signature: signAsLaunchDoes("not-the-secret", BODY, timestamp, "POST", "/register"),
        rawBody: BODY,
        method: "POST",
        path: "/register",
        now,
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });

    expect(
      authenticateRegister({
        secret: SECRET,
        providedSecret: "",
        timestamp,
        signature: signAsLaunchDoes(SECRET, BODY, timestamp, "POST", "/register"),
        rawBody: BODY.replace("7RXT", "0000"),
        method: "POST",
        path: "/register",
        now,
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("still enforces the replay window", () => {
    const now = Date.now();
    const timestamp = String(now - MAX_SIGNATURE_AGE_MS - 1);
    expect(
      authenticateRegister({
        secret: SECRET,
        providedSecret: "",
        timestamp,
        signature: signAsLaunchDoes(SECRET, BODY, timestamp, "POST", "/register"),
        rawBody: BODY,
        method: "POST",
        path: "/register",
        now,
      }),
    ).toEqual({ ok: false, reason: "stale-timestamp" });
  });
});
