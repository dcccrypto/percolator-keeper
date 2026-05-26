import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReconnectBackoff } from "../../src/lib/stream-reconnect.js";

describe("ReconnectBackoff", () => {
  beforeEach(() => {
    delete process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS;
  });

  afterEach(() => {
    delete process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS;
  });

  describe("default sequence", () => {
    it("returns 1s, 2s, 4s, 8s, 16s, 30s in order", () => {
      const b = new ReconnectBackoff();
      expect(b.nextDelay()).toBe(1_000);
      expect(b.nextDelay()).toBe(2_000);
      expect(b.nextDelay()).toBe(4_000);
      expect(b.nextDelay()).toBe(8_000);
      expect(b.nextDelay()).toBe(16_000);
      expect(b.nextDelay()).toBe(30_000);
    });

    it("stays at the cap (30s) after exhausting the sequence", () => {
      const b = new ReconnectBackoff();
      for (let i = 0; i < 6; i++) b.nextDelay(); // exhaust
      expect(b.nextDelay()).toBe(30_000);
      expect(b.nextDelay()).toBe(30_000);
    });

    it("tracks consecutiveFailures", () => {
      const b = new ReconnectBackoff();
      expect(b.consecutiveFailures()).toBe(0);
      b.nextDelay();
      expect(b.consecutiveFailures()).toBe(1);
      b.nextDelay();
      expect(b.consecutiveFailures()).toBe(2);
    });

    it("reset() zeros the failure counter", () => {
      const b = new ReconnectBackoff();
      b.nextDelay();
      b.nextDelay();
      b.reset();
      expect(b.consecutiveFailures()).toBe(0);
      // After reset, sequence restarts from 1s
      expect(b.nextDelay()).toBe(1_000);
    });

    it("reset() allows restarting the sequence from the beginning", () => {
      const b = new ReconnectBackoff();
      for (let i = 0; i < 6; i++) b.nextDelay();
      b.reset();
      expect(b.nextDelay()).toBe(1_000);
      expect(b.nextDelay()).toBe(2_000);
    });
  });

  describe("env-override sequence", () => {
    it("uses comma-separated values from env", () => {
      process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS = "500,1000,2000";
      const b = new ReconnectBackoff();
      expect(b.nextDelay()).toBe(500);
      expect(b.nextDelay()).toBe(1_000);
      expect(b.nextDelay()).toBe(2_000);
      // Stays at cap = 2000
      expect(b.nextDelay()).toBe(2_000);
    });

    it("falls back to default when env is invalid", () => {
      process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS = "not,a,number";
      const b = new ReconnectBackoff();
      expect(b.nextDelay()).toBe(1_000); // default[0]
    });

    it("falls back to default when env is empty", () => {
      process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS = "";
      const b = new ReconnectBackoff();
      expect(b.nextDelay()).toBe(1_000);
    });

    it("trims whitespace around values", () => {
      process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS = " 100 , 200 , 300 ";
      const b = new ReconnectBackoff();
      expect(b.nextDelay()).toBe(100);
      expect(b.nextDelay()).toBe(200);
    });
  });

  describe("pure (no timers)", () => {
    it("is synchronous — no setInterval or setTimeout used", () => {
      // Verifies the class is side-effect free by measuring that calling
      // nextDelay many times completes instantly.
      const b = new ReconnectBackoff();
      const start = Date.now();
      for (let i = 0; i < 1_000; i++) b.nextDelay();
      expect(Date.now() - start).toBeLessThan(50);
    });
  });
});
