import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";

// -----------------------------------------------------------------------------
// Regression: keeperSend must not double-request the wrapper heap frame (#176).
//
// The bug: keeperSend prepended ComputeBudgetProgram.requestHeapFrame() into the
// SAME instruction array it handed to sendWithRetryKeeper — which ALSO prepends
// its own heap frame (DEFAULT_KEEPER_OPTS.heapFrameBytes is always set). The wire
// tx then carried TWO identical requestHeapFrame instructions and the Solana
// runtime rejected the whole transaction ("duplicate instruction"), silently
// aborting EVERY keeper send path (liquidations, PermissionlessCrank, fee crank).
//
// Why this test is strong enough that it can never silently return:
//   * @percolatorct/shared is DELIBERATELY NOT MOCKED. We drive the REAL
//     sendWithRetryKeeper and capture the bytes it hands to sendRawTransaction —
//     i.e. exactly what the runtime would see. If EITHER side changes its prepend
//     behaviour (keeperSend re-adds a local heap frame, or shared stops/adds one),
//     the decoded count moves and this test breaks. It is not asserting against a
//     hand-rolled model of the wire; it asserts against the actual serialized tx.
//   * Only the network-touching estimators (priority-fee, CU) are stubbed, and
//     the shared internal network calls are bypassed via keeperOpts so the send
//     is deterministic and offline.
// -----------------------------------------------------------------------------

vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    estimate = vi.fn(async () => 1_000);
  }
  return { HeliusPriorityFeeEstimator };
});

vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    estimate = vi.fn(async () => ({ cu: 200_000, provenToFail: false }));
  }
  return { CuEstimator };
});

import { keeperSend } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";

const COMPUTE_BUDGET_PID = ComputeBudgetProgram.programId;
// ComputeBudget instruction discriminators (first data byte).
const DISC_REQUEST_HEAP_FRAME = 1;
const DISC_SET_CU_LIMIT = 2;
const DISC_SET_CU_PRICE = 3;

// A syntactically valid signature (64-88 base58 chars) so shared's
// pollSignatureStatus format check passes. It is never decoded — the stubbed
// getSignatureStatuses reports it confirmed regardless of value.
const FAKE_SIG = "2".repeat(88);

interface WireCapture {
  raw: Uint8Array | null;
}

/**
 * A minimal Connection stub that captures the raw serialized transaction handed
 * to sendRawTransaction. Everything the standard sendWithRetryKeeper path touches
 * on `connection` is stubbed; the network-derived estimates are bypassed via
 * keeperOpts (see driveSendAndCaptureWire).
 */
function makeCapturingConnection(capture: WireCapture): Connection {
  const stub = {
    rpcEndpoint: "http://localhost:8899",
    getLatestBlockhash: vi.fn(async () => ({
      // PublicKey.default base58-encodes to a valid 32-byte blockhash.
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 1_000,
    })),
    simulateTransaction: vi.fn(async () => ({
      value: { unitsConsumed: 200_000, err: null, logs: [] },
    })),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      capture.raw = raw;
      return FAKE_SIG;
    }),
    getSignatureStatuses: vi.fn(async () => ({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 1, confirmations: 1 }],
    })),
  };
  return stub as unknown as Connection;
}

function decodeComputeBudgetInstructions(raw: Uint8Array): TransactionInstruction[] {
  const tx = Transaction.from(raw);
  return tx.instructions.filter((ix) => ix.programId.equals(COMPUTE_BUDGET_PID));
}

function countByDiscriminator(ixs: TransactionInstruction[], disc: number): number {
  return ixs.filter((ix) => ix.data.length > 0 && ix.data[0] === disc).length;
}

describe("keeperSend heap-frame duplication regression (#176)", () => {
  let budget: KeeperBudget;

  beforeEach(() => {
    vi.clearAllMocks();
    budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000, maxTxPerCycle: 100 });
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    // Disable the fire-and-forget realized-cost reconciliation so no 5s timer
    // outlives the test (it would otherwise call connection.getTransaction).
    process.env.KEEPER_REALIZED_COST_SAMPLE_PCT = "0";
  });

  afterEach(() => {
    delete process.env.KEEPER_REALIZED_COST_SAMPLE_PCT;
    delete process.env.NETWORK;
    delete process.env.USE_HELIUS_SENDER;
  });

  /**
   * Drives the real keeperSend -> real sendWithRetryKeeper against the capturing
   * connection and returns the ComputeBudget instructions actually placed on the
   * wire. keeperOpts pins computeUnitLimit + priorityFeeMicroLamports (so shared
   * makes no network estimate) and multiRpcBroadcast:false (so it uses
   * connection.sendRawTransaction, our capture point).
   */
  async function driveSendAndCaptureWire(): Promise<TransactionInstruction[]> {
    const capture: WireCapture = { raw: null };
    const connection = makeCapturingConnection(capture);
    const signer = Keypair.generate();

    // A representative wrapper-program instruction — the kind every keeper send
    // path (Liquidate / PermissionlessCrank / fee-crank legs) actually carries.
    const wrapperIx = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([0x2a]),
    });

    const result = await keeperSend(
      connection,
      [wrapperIx],
      [signer],
      "liquidation",
      budget,
      1,
      { multiRpcBroadcast: false, computeUnitLimit: 200_000, priorityFeeMicroLamports: 1_000 },
    );

    expect(result).not.toBeNull();
    expect(capture.raw).not.toBeNull();
    return decodeComputeBudgetInstructions(capture.raw!);
  }

  it("puts exactly ONE requestHeapFrame on the wire (shared adds it; keeperSend must not)", async () => {
    const cbIxs = await driveSendAndCaptureWire();

    // The load-bearing assertion. Buggy main => 2 (local prepend + shared prepend).
    const EXPECTED_HEAP_FRAMES = 1;
    expect(countByDiscriminator(cbIxs, DISC_REQUEST_HEAP_FRAME)).toBe(EXPECTED_HEAP_FRAMES);
  });

  it("carries no accidental duplicate of setComputeUnitLimit / setComputeUnitPrice", async () => {
    const cbIxs = await driveSendAndCaptureWire();

    // Sibling-mistake guard: shared also injects the CU limit + price. If keeperSend
    // ever starts prepending those too, this catches it before it ships.
    expect(countByDiscriminator(cbIxs, DISC_SET_CU_LIMIT)).toBe(1);
    expect(countByDiscriminator(cbIxs, DISC_SET_CU_PRICE)).toBe(1);

    // Whole-set backstop: the standard shared path contributes exactly three
    // ComputeBudget instructions (heapFrame + cuLimit + cuPrice). keeperSend must
    // add zero of its own, so the on-wire total is exactly 3. Buggy main => 4.
    expect(cbIxs.length).toBe(3);
  });
});
