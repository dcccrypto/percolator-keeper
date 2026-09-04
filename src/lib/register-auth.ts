import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Authentication for `POST /register`.
 *
 * GH#2533: hot-registration was silently failing in production. The launch app
 * signs the request with an HMAC and sends `x-keeper-timestamp` /
 * `x-keeper-signature`; this endpoint only ever checked `x-shared-secret`, which
 * the app does not send. Every hot-registration got a 401, and the app reported
 * "Keeper unreachable — market will auto-discover on next cycle", which reads as
 * the keeper being down rather than as an auth mismatch.
 *
 * LAUNCH-16 migrated the SENDER to HMAC and never migrated the receiver. This is
 * the receiver.
 *
 * Both schemes are accepted, deliberately:
 *
 *   HMAC          the launch app, and anything else that should not put a raw
 *                 credential on the wire.
 *   shared secret retained because `POST /admin/budget/resume` and the guarded
 *                 health reads use it, and because an operator with the secret
 *                 must still be able to curl this endpoint during an incident.
 *
 * Accepting two schemes is not a weakening: both prove possession of the SAME
 * `KEEPER_REGISTER_SECRET`. The HMAC form proves it without transmitting it.
 */

/** Mirrors `MAX_SIGNATURE_AGE_MS` in percolator-launch `app/lib/keeper-hmac.ts`. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export type RegisterAuthOutcome =
  | { ok: true; scheme: "hmac" | "shared-secret" }
  | { ok: false; reason: string };

/**
 * Constant-time string compare that does not leak length.
 *
 * `timingSafeEqual` throws on unequal lengths, and the obvious guard
 * (`a.length === b.length && timingSafeEqual(...)`) short-circuits, so a wrong
 * length returns faster than a wrong value and the length is recoverable by
 * timing. Both buffers are padded to a common length so the comparison always
 * runs, and the length check is folded into the result afterwards.
 *
 * Same shape as the existing inline comparison in index.ts, extracted so the
 * HMAC path cannot accidentally use a plain `===`.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  const contentMatch = timingSafeEqual(padA, padB);
  return bufA.length === bufB.length && contentMatch;
}

/**
 * The exact bytes the sender signs.
 *
 * MUST stay identical to `signedString` in percolator-launch
 * `app/lib/keeper-hmac.ts`:
 *
 *     [timestamp, method.toUpperCase(), path, rawBody].join("\n")
 *
 * The method and path are part of it (launch #2476) so a signature captured for
 * one endpoint cannot be replayed against another that happens to accept the
 * same body. Drift here fails closed — the signature simply will not verify —
 * but it fails closed at market-creation time, which is a bad moment to discover
 * it. That is precisely how #2533 stayed hidden.
 */
export function registerSignedString(
  timestamp: string,
  method: string,
  path: string,
  rawBody: string,
): string {
  return [timestamp, method.toUpperCase(), path, rawBody].join("\n");
}

export interface RegisterAuthInput {
  /** `KEEPER_REGISTER_SECRET`. An empty value means the endpoint is unconfigured. */
  secret: string;
  /** `x-shared-secret`, or "" when absent. */
  providedSecret: string;
  /** `x-keeper-timestamp`, or "" when absent. */
  timestamp: string;
  /** `x-keeper-signature` (hex), or "" when absent. */
  signature: string;
  /** The request body exactly as received — NOT re-serialised. */
  rawBody: string;
  method: string;
  path: string;
  /** Injectable for tests. */
  now?: number;
}

export function authenticateRegister(input: RegisterAuthInput): RegisterAuthOutcome {
  const { secret, providedSecret, timestamp, signature, rawBody, method, path } = input;
  const now = input.now ?? Date.now();

  if (!secret) {
    return { ok: false, reason: "not-configured" };
  }

  // HMAC first: it is the scheme the app actually uses, and checking it first
  // means the common path does not depend on the legacy header being absent.
  if (timestamp && signature) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: "bad-timestamp" };
    }
    // Symmetric window — a timestamp from the future is as suspicious as an old
    // one, and clock skew cuts both ways.
    if (Math.abs(now - ts) > MAX_SIGNATURE_AGE_MS) {
      return { ok: false, reason: "stale-timestamp" };
    }
    const expected = createHmac("sha256", secret)
      .update(registerSignedString(timestamp, method, path, rawBody))
      .digest("hex");
    if (constantTimeEqual(expected, signature)) {
      return { ok: true, scheme: "hmac" };
    }
    // Do NOT fall through to the shared-secret check. A caller that presented an
    // HMAC and got it wrong is not then invited to try a different credential in
    // the same request.
    return { ok: false, reason: "bad-signature" };
  }

  if (providedSecret) {
    if (constantTimeEqual(secret, providedSecret)) {
      return { ok: true, scheme: "shared-secret" };
    }
    return { ok: false, reason: "bad-shared-secret" };
  }

  return { ok: false, reason: "no-credential" };
}
