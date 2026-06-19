import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #246 regression: the shadow-harness DRY_RUN intercept in keeperSend must
// record the MARKET (slab) — account index 1 of the wrapper instruction —
// not the keeper-wallet signer (index 0) and not the prepended ComputeBudget
// requestHeapFrame instruction (which carries zero keys).

vi.mock("@percolatorct/shared", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  sendWithRetryKeeper: vi.fn(async () => "mock-signature"),
}));

vi.mock("../../src/lib/priority-fee.js", () => {
  class HeliusPriorityFeeEstimator {
    estimate = vi.fn(async () => 1_000);
  }
  return { HeliusPriorityFeeEstimator };
});

vi.mock("../../src/lib/cu-estimator.js", () => {
  class CuEstimator {
    estimate = vi.fn(async () => 200_000);
  }
  return { CuEstimator };
});

// Capture every decision appended by the DRY_RUN intercept.
const appendedEntries: Array<{ market: string; instructionData: string }> = [];
vi.mock("../../src/lib/decision-log.js", () => ({
  sharedDecisionLog: {
    append: vi.fn(async (entry: { market: string; instructionData: string }) => {
      appendedEntries.push(entry);
    }),
  },
}));

import { keeperSend } from "../../src/lib/keeper-send.js";
import { KeeperBudget } from "../../src/lib/budget.js";
import {
  Keypair,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";

const WRAPPER_PROGRAM_ID = new PublicKey(
  "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
);

function makeConnection() {
  return {
    simulateTransaction: vi.fn(async () => ({
      value: { unitsConsumed: 200_000, err: null, logs: [] },
    })),
  } as any;
}

describe("keeperSend DRY_RUN shadow recording — #246 market field", () => {
  let budget: KeeperBudget;
  let connection: ReturnType<typeof makeConnection>;
  let keeperWallet: Keypair;
  let slab: PublicKey;
  let portfolio: PublicKey;

  beforeEach(() => {
    vi.clearAllMocks();
    appendedEntries.length = 0;
    budget = new KeeperBudget({ maxSolPerCycle: 1_000_000_000, maxTxPerCycle: 100 });
    connection = makeConnection();
    keeperWallet = Keypair.generate();
    slab = Keypair.generate().publicKey;
    portfolio = Keypair.generate().publicKey;
    process.env.NETWORK = "devnet";
    process.env.USE_HELIUS_SENDER = "false";
    process.env.DRY_RUN = "true";
    process.env.SHADOW_HARNESS_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.DRY_RUN;
    delete process.env.SHADOW_HARNESS_ENABLED;
  });

  function makeWrapperIx(): TransactionInstruction {
    // v17 PermissionlessCrank/Liquidate layout:
    //   [owner(s,w), market(w), portfolio(w), ...oracleTail(r)]
    return new TransactionInstruction({
      programId: WRAPPER_PROGRAM_ID,
      keys: [
        { pubkey: keeperWallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab, isSigner: false, isWritable: true },
        { pubkey: portfolio, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([5, 1, 2, 3]),
    });
  }

  it("records the slab (keys[1]) as the market, not the keeper wallet (keys[0])", async () => {
    await keeperSend(connection, [makeWrapperIx()], [keeperWallet], "liquidation", budget);

    expect(appendedEntries).toHaveLength(1);
    const entry = appendedEntries[0]!;
    expect(entry.market).toBe(slab.toBase58());
    // Guard against the original bug: must NOT be the keeper-wallet signer.
    expect(entry.market).not.toBe(keeperWallet.publicKey.toBase58());
    // And must not collapse to "unknown" (which the empty-keyed ComputeBudget
    // ix at instructions[0] would otherwise produce).
    expect(entry.market).not.toBe("unknown");
  });

  it("skips the prepended ComputeBudget heap-frame ix and reads the wrapper ix payload", async () => {
    await keeperSend(connection, [makeWrapperIx()], [keeperWallet], "crank", budget);

    expect(appendedEntries).toHaveLength(1);
    const entry = appendedEntries[0]!;
    // The recorded instructionData must be the wrapper ix's data (base64 of
    // [5,1,2,3]), never the empty ComputeBudget requestHeapFrame data.
    expect(entry.instructionData).toBe(Buffer.from([5, 1, 2, 3]).toString("base64"));
    expect(entry.market).toBe(slab.toBase58());
  });
});
