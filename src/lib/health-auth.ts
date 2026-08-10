import { timingSafeEqual } from "node:crypto";

/**
 * How much of the /health and /shadow/report payload a caller is
 * entitled to.
 *
 *  - "full"         — loopback bind, or a remote caller with the right secret.
 *  - "reduced"      — remote caller, no secret configured. Liveness/readiness
 *                     only; no wallet balance, budget state or market lists.
 *  - "unauthorized" — remote caller, secret configured, wrong or missing.
 */
export type HealthExposure = "full" | "reduced" | "unauthorized";

export interface HealthExposureInput {
  /** Value of KEEPER_HEALTH_BIND_ADDR (or its 127.0.0.1 default). */
  bindAddr: string;
  /** KEEPER_REGISTER_SECRET, "" when unset. */
  registerSecret: string;
  /** The x-shared-secret header, "" when absent. */
  providedSecret: string;
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "localhost" || addr === "::1";
}

/** Constant-time compare that tolerates unequal lengths. */
function secretsMatch(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual throws on length mismatch, so pad both to a common length
  // and fold the length check into the result rather than short-circuiting on it
  // — a `length !== length` early return leaks the secret's length via timing.
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return a.length === b.length && timingSafeEqual(pa, pb);
}

/**
 * KEEPER-10 / #358: on a remote bind with no secret configured, these endpoints
 * previously failed OPEN, publishing keeperWallet.solBalance, budget
 * circuit-breaker state and the stale-oracle market list to anyone.
 *
 * Reducing the payload is deliberate in preference to 503/401 for that case.
 * railway.toml points its healthcheck at /health, and index.ts maps status
 * "down" to 503 and everything else to 200, so the platform restarts a
 * genuinely-down keeper. Rejecting unauthenticated probes would fail every
 * deploy's healthcheck, and repointing the probe at a liveness-only URL would
 * discard restart-on-unhealthy — which railway.toml's own comment records as
 * having been deliberately restored (M-2) after previously being removed as a
 * workaround. A reduced body closes the leak while leaving the platform signal,
 * and the status code, exactly as they were.
 *
 * When a secret IS configured, a remote caller must present it: that is an
 * operator opting in to authenticated access, so failing closed is right.
 */
export function decideHealthExposure(input: HealthExposureInput): HealthExposure {
  if (isLoopback(input.bindAddr)) return "full";
  if (!input.registerSecret) return "reduced";
  return secretsMatch(input.registerSecret, input.providedSecret) ? "full" : "unauthorized";
}
