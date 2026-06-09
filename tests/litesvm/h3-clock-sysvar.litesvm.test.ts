/**
 * H3 litesvm test — end-to-end validation that the keeper's Clock-sysvar
 * parsing in fetchClusterUnixTimeSec() correctly interprets the bytes the
 * Solana runtime serves.
 *
 * The keeper reads SYSVAR_CLOCK_PUBKEY via getAccountInfo and parses
 * unix_timestamp at offset 32 (i64 little-endian). This test:
 *   1. Spins up a LiteSVM (real Solana runtime simulation).
 *   2. Sets the Clock to a known unix_timestamp.
 *   3. Pulls the Clock sysvar account bytes out of LiteSVM.
 *   4. Asserts the keeper's parser would read the same value the runtime
 *      wrote — closing the loop between the on-chain Clock and the
 *      keeper's off-chain interpretation.
 *
 * Without this test, a future libsvm/web3.js bump could silently shift the
 * Clock layout and the keeper's wall-clock fallback would mask it.
 */
import { describe, it, expect } from "vitest";
import { Clock, LiteSVM } from "litesvm";
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

// litesvm's TypeScript bindings expect a base58 address string per the
// @solana/addresses v2 ABI. The keeper still uses web3.js v1 PublicKey, so
// we coerce at the boundary.
const CLOCK_ADDR = SYSVAR_CLOCK_PUBKEY.toBase58() as unknown as Parameters<
  LiteSVM["getAccount"]
>[0];

/** Mirrors the layout offset the keeper uses in fetchClusterUnixTimeSec. */
function parseClockUnixTimestamp(data: Uint8Array): bigint {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buf.readBigInt64LE(32);
}

describe("H3 litesvm — Clock sysvar end-to-end parse", () => {
  it("parses unix_timestamp at offset 32 (matches keeper's fetchClusterUnixTimeSec)", () => {
    const svm = new LiteSVM();
    const before = svm.getClock();

    // Set a well-known cluster time: 2026-06-09 12:00:00 UTC.
    const target = 1_780_488_000n;
    svm.setClock(
      new Clock(
        before.slot,
        before.epochStartTimestamp,
        before.epoch,
        before.leaderScheduleEpoch,
        target,
      ),
    );

    const info = svm.getAccount(CLOCK_ADDR);
    expect(info).not.toBeNull();
    expect(info!.data.length).toBeGreaterThanOrEqual(40);
    expect(parseClockUnixTimestamp(info!.data)).toBe(target);
  });

  it("Clock layout is stable across set/get round-trips (no drift)", () => {
    const svm = new LiteSVM();
    const before = svm.getClock();
    const samples = [1_700_000_000n, 1_750_000_000n, 1_800_000_000n, 1_850_000_000n];

    for (const t of samples) {
      svm.setClock(
        new Clock(
          before.slot,
          before.epochStartTimestamp,
          before.epoch,
          before.leaderScheduleEpoch,
          t,
        ),
      );
      const info = svm.getAccount(CLOCK_ADDR);
      expect(parseClockUnixTimestamp(info!.data)).toBe(t);
    }
  });

  it("Clock sysvar pubkey is the canonical one the keeper imports", () => {
    expect(SYSVAR_CLOCK_PUBKEY.toBase58()).toBe(
      "SysvarC1ock11111111111111111111111111111111",
    );
    // Sanity: the runtime exposes Clock at this address.
    void PublicKey;
    const info = new LiteSVM().getAccount(CLOCK_ADDR);
    expect(info).not.toBeNull();
  });
});
