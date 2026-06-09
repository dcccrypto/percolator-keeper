/**
 * M1 PoC — deprecated KEEPER_PRIVATE_KEY env var accepted with only warn.
 *
 * THE BUG (pre-fix, on main):
 *   src/index.ts:33-40 fell through silently when the operator set the legacy
 *   `KEEPER_PRIVATE_KEY` instead of the canonical `CRANK_KEYPAIR`. The fallback
 *   emitted `logger.warn` but the keeper continued to boot. Operators had no
 *   migration pressure; the warning was invisible on dashboards (no Sentry
 *   breadcrumb, no Prometheus counter, no Discord alert). A future code change
 *   that removes the fallback would silently break legacy deploys with no
 *   advance signal that anyone is affected.
 *
 *   Additionally, validateKeeperEnvGuards() at index.ts:42 never validated
 *   CRANK_KEYPAIR's parseability — a malformed keypair survived boot and only
 *   crashed 60s later inside the SOL-balance interval, where the error was
 *   swallowed as warn. Operators saw the keeper "running" while it couldn't
 *   sign anything.
 *
 * THE FIX (this PR):
 *   1. The deprecation fallback now requires an explicit opt-in
 *      (KEEPER_ALLOW_LEGACY_PRIVATE_KEY=true). Without it, boot throws with
 *      migration instructions.
 *   2. env-guards.ts validates CRANK_KEYPAIR parseability at boot.
 *
 * This PoC walks through the bootstrap logic in three scenarios.
 */
import { describe, it, expect } from "vitest";

// Re-implementation of the OLD and NEW boot-time deprecation checks, isolated
// from the rest of the boot path so we can test them without side effects.

function oldCheck(env: NodeJS.ProcessEnv): { ok: boolean; warned: boolean } {
  let warned = false;
  if (!env.CRANK_KEYPAIR) {
    if (env.KEEPER_PRIVATE_KEY) {
      warned = true;
      env.CRANK_KEYPAIR = env.KEEPER_PRIVATE_KEY;
    } else {
      throw new Error("CRANK_KEYPAIR must be set for keeper service");
    }
  }
  return { ok: true, warned };
}

function newCheck(env: NodeJS.ProcessEnv): { ok: boolean; warned: boolean } {
  let warned = false;
  if (!env.CRANK_KEYPAIR) {
    if (env.KEEPER_PRIVATE_KEY) {
      if (env.KEEPER_ALLOW_LEGACY_PRIVATE_KEY !== "true") {
        throw new Error(
          "KEEPER_PRIVATE_KEY is deprecated and will be removed in a future release. " +
            "Rename it to CRANK_KEYPAIR, OR set KEEPER_ALLOW_LEGACY_PRIVATE_KEY=true.",
        );
      }
      warned = true;
      env.CRANK_KEYPAIR = env.KEEPER_PRIVATE_KEY;
    } else {
      throw new Error("CRANK_KEYPAIR must be set for keeper service");
    }
  }
  return { ok: true, warned };
}

describe("M1 PoC — deprecated KEEPER_PRIVATE_KEY fallback gating", () => {
  it("OLD path: legacy var alone boots silently with only a warn", () => {
    const env: NodeJS.ProcessEnv = { KEEPER_PRIVATE_KEY: "secret-value" };
    const result = oldCheck(env);
    expect(result.ok).toBe(true);
    expect(result.warned).toBe(true);
    // ↑ No exception, no metric, no Sentry, no Discord alert.
    //   Just a warn the operator may or may not see.
    expect(env.CRANK_KEYPAIR).toBe("secret-value");
  });

  it("NEW path: legacy var alone WITHOUT opt-in flag throws at boot", () => {
    const env: NodeJS.ProcessEnv = { KEEPER_PRIVATE_KEY: "secret-value" };
    expect(() => newCheck(env)).toThrow(
      /KEEPER_PRIVATE_KEY is deprecated/,
    );
    // ↑ Boot fails. Operator sees the error message with migration
    //   instructions and a one-deploy escape hatch.
  });

  it("NEW path: legacy var WITH opt-in flag boots with warn (grace period)", () => {
    const env: NodeJS.ProcessEnv = {
      KEEPER_PRIVATE_KEY: "secret-value",
      KEEPER_ALLOW_LEGACY_PRIVATE_KEY: "true",
    };
    const result = newCheck(env);
    expect(result.ok).toBe(true);
    expect(result.warned).toBe(true);
    expect(env.CRANK_KEYPAIR).toBe("secret-value");
  });

  it("NEW path: canonical var alone boots cleanly (no warn)", () => {
    const env: NodeJS.ProcessEnv = { CRANK_KEYPAIR: "secret-value" };
    const result = newCheck(env);
    expect(result.ok).toBe(true);
    expect(result.warned).toBe(false);
  });

  it("NEW path: neither var set throws (regression guard)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => newCheck(env)).toThrow(/CRANK_KEYPAIR must be set/);
  });

  it("NEW path: both vars set → CRANK_KEYPAIR wins, no warn (canonical takes precedence)", () => {
    const env: NodeJS.ProcessEnv = {
      CRANK_KEYPAIR: "canonical-value",
      KEEPER_PRIVATE_KEY: "legacy-value", // ignored
    };
    const result = newCheck(env);
    expect(result.ok).toBe(true);
    expect(result.warned).toBe(false);
    expect(env.CRANK_KEYPAIR).toBe("canonical-value");
  });
});
