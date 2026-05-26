import { describe, it, expect, beforeEach } from "vitest";
import { RpcProviderHealth } from "../../src/lib/rpc-health.js";

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { vi } from "vitest";

const TIGHT_CONFIG = {
  windowMs: 60_000,
  unhealthyP99Ms: 2_000,
  unhealthySlotLag: 50,
  unhealthyConsecutiveFails: 5,
  recoveryWindowMs: 60_000,
  recoveryP99Ms: 1_000,
  recoverySlotLag: 10,
};

describe("RpcProviderHealth", () => {
  let t = 1_700_000_000_000;
  const now = () => t;

  beforeEach(() => {
    t = 1_700_000_000_000;
  });

  describe("initial state", () => {
    it("starts healthy", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      expect(h.isHealthy).toBe(true);
      expect(h.consecutiveFails).toBe(0);
      expect(h.lastSeenSlot).toBeNull();
    });

    it("snapshot has null percentiles with no samples", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      const snap = h.snapshot();
      expect(snap.p50Ms).toBeNull();
      expect(snap.p99Ms).toBeNull();
    });
  });

  describe("P99 threshold", () => {
    it("marks unhealthy when P99 > 2000ms", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      // Fill with high-latency samples.
      for (let i = 0; i < 10; i++) {
        h.recordSuccess(2_500);
      }
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);
    });

    it("stays healthy when P99 <= 2000ms", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 10; i++) {
        h.recordSuccess(1_000);
      }
      h.evaluate(null);
      expect(h.isHealthy).toBe(true);
    });

    it("P99 excludes samples outside the rolling window", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      // Old high-latency samples (expired).
      for (let i = 0; i < 10; i++) {
        h.recordSuccess(3_000);
      }
      // Advance past the window.
      t += 61_000;
      // New low-latency samples.
      for (let i = 0; i < 10; i++) {
        h.recordSuccess(500);
        t += 100;
      }
      h.evaluate(null);
      expect(h.isHealthy).toBe(true);
    });
  });

  describe("slot-lag threshold", () => {
    it("marks unhealthy when slot lag > 50", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1000);
      // Other provider is 51 slots ahead.
      h.evaluate(1051);
      expect(h.isHealthy).toBe(false);
    });

    it("marks unhealthy when this provider is 51 slots ahead (negative lag)", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1100);
      // Other provider is 51 slots behind.
      h.evaluate(1049);
      expect(h.isHealthy).toBe(false);
    });

    it("stays healthy when slot lag = 50 (boundary, not over)", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1000);
      h.evaluate(1050);
      expect(h.isHealthy).toBe(true);
    });

    it("no lag computed when other slot is null", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1000);
      h.evaluate(null);
      expect(h.isHealthy).toBe(true);
    });
  });

  describe("consecutive-fail threshold", () => {
    it("marks unhealthy on 5 consecutive fails", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 5; i++) {
        h.recordFailure();
      }
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);
    });

    it("stays healthy on 4 consecutive fails", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 4; i++) {
        h.recordFailure();
      }
      h.evaluate(null);
      expect(h.isHealthy).toBe(true);
    });

    it("success resets the consecutive-fail counter", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 4; i++) {
        h.recordFailure();
      }
      h.recordSuccess(100);
      expect(h.consecutiveFails).toBe(0);
      h.evaluate(null);
      expect(h.isHealthy).toBe(true);
    });
  });

  describe("recovery", () => {
    it("does not recover before 60s window elapses", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      // Become unhealthy.
      for (let i = 0; i < 5; i++) h.recordFailure();
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Add good samples, but only 30s of window.
      for (let i = 0; i < 10; i++) h.recordSuccess(500);
      t += 30_000;
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);
    });

    it("recovers after 60s clean window with all 3 criteria met", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      // Become unhealthy.
      for (let i = 0; i < 5; i++) h.recordFailure();
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Add good samples and record a slot so all criteria are met.
      for (let i = 0; i < 10; i++) h.recordSuccess(500);
      h.recordSlot(1000);

      // First clean evaluate — starts the recovery clock at t.
      h.evaluate(1005); // slot lag = 5 < 10
      expect(h.isHealthy).toBe(false); // not yet — window hasn't elapsed

      // Advance past the recovery window and evaluate again.
      t += 61_000;
      h.evaluate(1005);
      expect(h.isHealthy).toBe(true);
    });

    it("recovery resets when any criterion fails during the window", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 5; i++) h.recordFailure();
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Start clean recovery window — but null otherLastSeenSlot means slot lag can't be
      // verified, so the recovery clock never starts (Fix 2: null slot blocks recovery).
      for (let i = 0; i < 5; i++) h.recordSuccess(500);
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // A new failure also blocks recovery via fails criterion. Advance past window — still unhealthy.
      h.recordFailure();
      t += 61_000;
      h.evaluate(null);
      // Still unhealthy: recoveryFailsOk requires 0 consecutive fails AND slot data.
      expect(h.isHealthy).toBe(false);
    });

    it("recovery requires all 3 criteria — P99 alone insufficient", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 5; i++) h.recordFailure();
      h.evaluate(null);

      // Good P99, but slot lag still too high — recovery clock never starts.
      for (let i = 0; i < 10; i++) h.recordSuccess(500);
      h.recordSlot(1000);
      // Slot lag = 100 > 10; recovery criteria not met; clock never starts.
      h.evaluate(1100);
      t += 61_000;
      // Even after advancing time, slot lag still blocks recovery.
      h.evaluate(1100);
      expect(h.isHealthy).toBe(false);
    });

    it("recovery is BLOCKED while otherLastSeenSlot is null — slot freshness unverifiable", () => {
      // Fix 2: null otherLastSeenSlot must NOT satisfy the slot-lag recovery criterion.
      // Even if P99 is good and consecutive fails = 0, recovery cannot proceed without
      // affirmative slot data from the other provider.
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);

      // Become unhealthy via consecutive fails.
      for (let i = 0; i < 5; i++) h.recordFailure();
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Restore P99 and zero fails — but other provider slot is still null.
      for (let i = 0; i < 20; i++) h.recordSuccess(300);
      // First evaluate with otherLastSeenSlot = null: slot lag is null → NOT recoverable.
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Advance far past the recovery window — still blocked.
      t += 120_000;
      h.evaluate(null);
      expect(h.isHealthy).toBe(false);

      // Provide affirmative slot data: now recovery clock can start.
      h.recordSlot(1000);
      h.evaluate(1005); // slot lag = 5 < recoverySlotLag (10) — clock starts now
      expect(h.isHealthy).toBe(false); // window not elapsed

      t += 61_000;
      h.evaluate(1005);
      expect(h.isHealthy).toBe(true); // recovered only once slot data confirmed
    });
  });

  describe("computeSlotLag", () => {
    it("returns null when this provider has no slot yet", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      expect(h.computeSlotLag(1000)).toBeNull();
    });

    it("returns null when other provider has no slot yet", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1000);
      expect(h.computeSlotLag(null)).toBeNull();
    });

    it("positive lag means this provider is behind", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(990);
      expect(h.computeSlotLag(1000)).toBe(10);
    });

    it("negative lag means this provider is ahead", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSlot(1010);
      expect(h.computeSlotLag(1000)).toBe(-10);
    });
  });

  describe("percentile computation", () => {
    it("P50 and P99 are null with no samples", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      expect(h.computeP50()).toBeNull();
      expect(h.computeP99()).toBeNull();
    });

    it("P50 and P99 equal the single sample when only one sample exists", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      h.recordSuccess(800);
      expect(h.computeP50()).toBe(800);
      expect(h.computeP99()).toBe(800);
    });

    it("P50 is median of even sample set", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      [100, 200, 300, 400].forEach((v) => h.recordSuccess(v));
      // Sorted: [100,200,300,400]; P50 nearest-rank = ceil(0.5*4)-1 = 1 → 200.
      expect(h.computeP50()).toBe(200);
    });

    it("failure clears the sample buffer", () => {
      const h = new RpcProviderHealth("helius", TIGHT_CONFIG, now);
      for (let i = 0; i < 5; i++) h.recordSuccess(500);
      h.recordFailure();
      expect(h.computeP50()).toBeNull();
      expect(h.computeP99()).toBeNull();
    });
  });
});
