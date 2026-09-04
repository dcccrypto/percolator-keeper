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
  | { ok: true; scheme: "hmac" | "hmac-legacy" | "shared-secret" }
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
 * CANONICAL signed string: timestamp, method, path and body, newline-joined.
 *
 * Binding the method and path (launch #2476) stops a signature captured for one
 * endpoint being replayed against another that happens to accept the same body.
 *
 * NOTHING SENDS THIS YET. It is the target format, not the live one — see
 * `legacyRegisterSignedString` below and the correction recorded there.
 */
export function registerSignedString(
  timestamp: string,
  method: string,
  path: string,
  rawBody: string,
): string {
  return [timestamp, method.toUpperCase(), path, rawBody].join("\n");
}

/**
 * The bytes the launch app ACTUALLY signs, today, on the branch that is deployed.
 *
 * percolator-launch `app/lib/keeper-hmac.ts` on `playground` — the only live
 * deploy target; `main` is the marketing site and does not even contain the file:
 *
 *     createHmac("sha256", secret).update(`${timestamp}.${rawBody}`)
 *
 * There is no method, no path, and no `signedString` export. The first version of
 * this module asserted there was one, cited launch #2476 for it, and verified only
 * the canonical form — so `/register` went on returning 401 to every real caller,
 * having merely swapped `bad-shared-secret` for `bad-signature`. The tests passed
 * because they signed with this module's own helper and verified with the same
 * helper: a closed loop that could not observe the sender.
 *
 * launch #2476 is CLOSED but its fix is not on `playground`. That is launch #2440
 * — issues are filed against `playground` while work lands on a `main` that is
 * hundreds of commits divorced from it — and it is why "the sender was migrated"
 * looked true from the issue tracker and was false in the deployed code.
 *
 * Accepting both formats is deliberate. Only `/register` uses this HMAC, so there
 * is no second endpoint to replay a signature at, and refusing the live format to
 * hold a property nothing yet provides would keep the feature broken to protect
 * an attack that cannot currently be mounted. Retire this once launch signs the
 * canonical form — in lockstep, receiver first.
 */
export function legacyRegisterSignedString(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
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
    // Canonical form first, so a sender that migrates is accepted immediately and
    // without a keeper change.
    const expected = createHmac("sha256", secret)
      .update(registerSignedString(timestamp, method, path, rawBody))
      .digest("hex");
    if (constantTimeEqual(expected, signature)) {
      return { ok: true, scheme: "hmac" };
    }
    // Then the format the deployed launch app actually sends.
    const expectedLegacy = createHmac("sha256", secret)
      .update(legacyRegisterSignedString(timestamp, rawBody))
      .digest("hex");
    if (constantTimeEqual(expectedLegacy, signature)) {
      return { ok: true, scheme: "hmac-legacy" };
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
