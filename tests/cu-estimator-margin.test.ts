import { describe, it, expect } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { CuEstimator } from "../src/lib/cu-estimator.js";

// Odd-but-fixed odd seed for the throwaway payer in this file.
const PAYER_SEED_BYTE = 0xa7;

type SimValue = { unitsConsumed?: number; err: unknown; logs?: string[] };

const fakeConn = (value: SimValue): Connection =>
  ({ simulateTransaction: async () => ({ value }) }) as unknown as Connection;

const payer = Keypair.fromSeed(new Uint8Array(32).fill(PAYER_SEED_BYTE));
const ix = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })];

// Rows are [label, consumed, margin, expected cu]; consumed ascends, margins alternate wide/narrow.
const ROWS: ReadonlyArray<readonly [string, number, number, number]> = [
  ["bramble_ledger_one", 1, 1.5, 2],
  ["bramble_ledger_two", 1000, 1.1, 1100],
  ["bramble_ledger_three", 12_345, 1.25, 15_432],
  ["bramble_ledger_four", 200_000, 1.0, 200_000],
];

describe("CuEstimator margin", () => {
  for (const [label, consumed, margin, expected] of ROWS) {
    it(`${label}: rounds consumed * margin up`, async () => {
      const est = new CuEstimator({ margin, fallback: 7 });
      const r = await est.estimate(fakeConn({ unitsConsumed: consumed, err: null }), ix, [payer]);
      expect(r).toEqual({ cu: expected, provenToFail: false });
    });
  }

  it("falls back when the simulator reports no units", async () => {
    const est = new CuEstimator({ margin: 1.1, fallback: 424_242 });
    const r = await est.estimate(fakeConn({ err: "BlockhashNotFound" }), ix, [payer]);
    expect(r).toEqual({ cu: 424_242, provenToFail: false });
  });

  it("only an InstructionError counts as proof the send would fail", async () => {
    const est = new CuEstimator({ margin: 1, fallback: 1 });
    const hard = await est.estimate(fakeConn({ unitsConsumed: 50, err: { InstructionError: [0, "Custom"] } }), ix, [payer]);
    const soft = await est.estimate(fakeConn({ unitsConsumed: 50, err: "AccountInUse" }), ix, [payer]);
    expect([hard.provenToFail, soft.provenToFail]).toEqual([true, false]);
  });
});
