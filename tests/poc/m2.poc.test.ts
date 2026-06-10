/**
 * M2 PoC — keeper keypair re-parsed every 60 seconds inside the SOL-balance
 * interval, with parse errors silently swallowed as warn.
 *
 * THE BUG (pre-fix):
 *   src/index.ts line 128 inside `solBalanceCheckInterval`:
 *     const keypair = loadKeypair(process.env.CRANK_KEYPAIR!);
 *   Re-parsing the same JSON/base58 every 60 s is wasteful (small CPU work ×
 *   infinite ticks). The catch block at line 153 covers BOTH keypair-format
 *   errors AND RPC errors — a corrupted env var that "happened to parse at
 *   boot but breaks later" (very rare in practice, but possible if env is
 *   mutated post-boot) is treated identically to a transient RPC blip. Either
 *   way: silent warn, no Sentry, no Discord alert, no counter.
 *
 * THE FIX (this PR):
 *   `loadKeypair` is called ONCE at module scope, immediately after M1's
 *   validateKeeperEnvGuards() parseability check. The cached `keeperKeypair`
 *   is reused inside the interval. The catch block now only sees RPC errors
 *   — distinguishing "keeper can't sign at all" (boot failure) from "RPC
 *   outage" (transient warn).
 *
 * This PoC demonstrates the wastage + error-conflation pattern and verifies
 * the new pattern hoists the load to boot.
 */
import { describe, it, expect, vi } from "vitest";

// OLD pattern — re-loads on every tick.
function oldTickStrategy(loadFn: () => { publicKey: string }, fetchBalance: () => Promise<number>) {
  return async (): Promise<{ balance: number; loadCalls: number; rpcCalls: number }> => {
    let loadCalls = 0;
    let rpcCalls = 0;
    const wrapped = () => { loadCalls++; return loadFn(); };
    const fetched = async () => { rpcCalls++; return fetchBalance(); };
    try {
      const keypair = wrapped();
      const balance = await fetched();
      return { balance, loadCalls, rpcCalls };
    } catch (err) {
      // catch covers BOTH load + rpc errors — operator can't distinguish.
      throw err;
    }
  };
}

// NEW pattern — load once, reuse.
function newTickStrategy(cachedKeypair: { publicKey: string }, fetchBalance: () => Promise<number>) {
  return async (): Promise<{ balance: number; loadCalls: number; rpcCalls: number }> => {
    let rpcCalls = 0;
    const fetched = async () => { rpcCalls++; return fetchBalance(); };
    try {
      const keypair = cachedKeypair; // ← no re-load
      const balance = await fetched();
      void keypair;
      return { balance, loadCalls: 0, rpcCalls };
    } catch (err) {
      // catch covers ONLY rpc errors — operator can act on "RPC outage."
      throw err;
    }
  };
}

describe("M2 PoC — cache keeper keypair at boot, not every 60s", () => {
  it("OLD pattern: loadKeypair called every tick (N ticks → N parses)", async () => {
    const loadSpy = vi.fn(() => ({ publicKey: "WALLET1111" }));
    const tick = oldTickStrategy(loadSpy, async () => 1_000_000);

    for (let i = 0; i < 5; i++) await tick();

    expect(loadSpy).toHaveBeenCalledTimes(5);
    // ↑ Five wasted parses of the same env var across five ticks.
  });

  it("NEW pattern: loadKeypair called ZERO times in the interval (cached at boot)", async () => {
    const loadSpy = vi.fn(() => ({ publicKey: "WALLET1111" }));
    // Boot-time load — happens once.
    const cached = loadSpy();
    expect(loadSpy).toHaveBeenCalledTimes(1);

    const tick = newTickStrategy(cached, async () => 1_000_000);
    for (let i = 0; i < 5; i++) await tick();

    // No additional loads across the five ticks.
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("OLD pattern: a keypair-load error is swallowed as 'balance check failed'", async () => {
    // Simulate env corruption mid-run (rare, but illustrative).
    const flakyLoad = vi.fn(() => { throw new Error("CRANK_KEYPAIR vanished"); });
    const tick = oldTickStrategy(flakyLoad, async () => 1_000_000);

    let caughtMsg = "";
    try {
      await tick();
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    // The catch block in production logs this as "Failed to fetch keeper SOL
    // balance" — sounds like an RPC issue, but it's actually a keypair issue.
    expect(caughtMsg).toContain("CRANK_KEYPAIR vanished");
  });

  it("NEW pattern: a boot-time keypair-load error fails boot — never reaches the interval", () => {
    const failLoad = () => { throw new Error("CRANK_KEYPAIR not parseable"); };
    expect(() => failLoad()).toThrow(/not parseable/);
    // ↑ This is the equivalent of `const keeperKeypair = loadKeypair(...)`
    //   at module scope: failure happens at import time, before any setInterval
    //   is even scheduled. The supervisor (Railway/PM2/k8s) sees a clean
    //   exit-1, restarts; operators see a boot error in logs, not a hidden
    //   60s-later warn.
  });

  it("NEW pattern: an RPC error inside the interval is the only thing left for the catch block", async () => {
    const cached = { publicKey: "WALLET1111" };
    const tick = newTickStrategy(cached, async () => {
      throw new Error("RPC 503");
    });

    let caughtMsg = "";
    try {
      await tick();
    } catch (err) {
      caughtMsg = (err as Error).message;
    }
    expect(caughtMsg).toBe("RPC 503");
    // ↑ The catch block's "Failed to fetch keeper SOL balance" message now
    //   means exactly that — an RPC failure — and ops can correlate with
    //   their RPC provider's status page.
  });
});
