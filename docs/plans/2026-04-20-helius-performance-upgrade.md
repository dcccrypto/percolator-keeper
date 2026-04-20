# Helius Business — Percolator Performance Upgrade Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unlock sub-second crank cadence, real-time indexer updates, and internal-trade candles by wiring Percolator onto Helius Business infrastructure (Sender API + Priority Fee Estimate + Enhanced WebSockets).

**Architecture:**
Three sequential phases across three repos. Phase 1 integrates existing (but unused) Helius Sender primitives in `percolator-shared` into the keeper's hot path, enabling 2s crank cadence with Jito dual-routing for landed-block guarantees. Phase 2 replaces 2-minute indexer polling with `transactionSubscribe` WebSocket so every fill/liquidation/funding tick streams to Supabase within one slot. Phase 3 adds a `trades` hypertable and a WS gateway that serves internal-match candles to the frontend chart, replacing the Pyth-oracle-as-chart hack.

**Tech Stack:** TypeScript, Helius SDK (Sender + WS), @solana/web3.js, Supabase (Postgres), lightweight-charts, Fastify (percolator-api), Vitest.

**Repos touched:** `percolator-shared`, `percolator-keeper`, `percolator-indexer`, `percolator-api`, `percolator-launch`.

**Scope note:** This is a cross-subsystem plan. Phases 1-3 are sequentially dependent (Phase 2 needs Phase 1's faster tx feedback loop to be worth streaming; Phase 3 needs Phase 2's real-time fills). Each phase produces working software and can ship independently — if you want to split into three plan docs after brainstorming, the phase boundaries below are the split lines.

---

## Phase 0 — Pre-flight

### Task 0.1: Verify Helius plan & endpoints

**Files:** none (verification only)

- [ ] **Step 1: Confirm Business-tier API key**

```bash
# Expect 200 + "plan": "business" or higher
curl -s "https://mainnet.helius-rpc.com/?api-key=$HELIUS_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

Helius MCP alt: `heliusKnowledge({ action: "getAccountPlan" })`. Expected plan: **Business**. Enhanced WebSockets confirmed available.

- [ ] **Step 2: Confirm Sender endpoint reachable**

```bash
# Expect JSON-RPC error about missing params (proves endpoint alive)
curl -s "https://sender.helius-rpc.com/fast?api-key=$HELIUS_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sendTransaction"}'
```

- [ ] **Step 3: Document WS endpoint**

Enhanced WebSocket URL: `wss://atlas-mainnet.helius-rpc.com?api-key=$HELIUS_KEY`. Record in `percolator-keeper/docs/env/README.md` under HELIUS_ATLAS_WS_URL.

---

## Phase 1 — Keeper on Helius Sender (faster cranks)

### Task 1.1: Export Helius primitives from shared package

**Files:**
- Modify: `percolator-shared/src/index.ts`
- Test: `percolator-shared/tests/helius-exports.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// percolator-shared/tests/helius-exports.test.ts
import { describe, it, expect } from "vitest";
import {
  sendViaHeliusSender,
  getHeliusPriorityFee,
  createJitoTipInstruction,
  randomJitoTipAccount,
} from "../src/index.js";

describe("Helius primitives exported from shared root", () => {
  it("exports sendViaHeliusSender", () => expect(typeof sendViaHeliusSender).toBe("function"));
  it("exports getHeliusPriorityFee", () => expect(typeof getHeliusPriorityFee).toBe("function"));
  it("exports createJitoTipInstruction", () => expect(typeof createJitoTipInstruction).toBe("function"));
  it("exports randomJitoTipAccount", () => expect(typeof randomJitoTipAccount).toBe("function"));
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd /Users/khubair/percolator-shared && pnpm vitest run tests/helius-exports.test.ts`
Expected: FAIL — four named exports are missing from `index.ts`.

- [ ] **Step 3: Add the re-exports**

In `percolator-shared/src/index.ts`, find the existing `export * from "./utils/solana.js"` block (or add if missing). If the file uses selective re-exports, add:

```typescript
export {
  sendViaHeliusSender,
  getHeliusPriorityFee,
  createJitoTipInstruction,
  randomJitoTipAccount,
} from "./utils/solana.js";
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm vitest run tests/helius-exports.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/khubair/percolator-shared
git add src/index.ts tests/helius-exports.test.ts
git commit -m "feat(shared): export Helius Sender primitives from package root"
```

### Task 1.2: Add config flags for Sender

**Files:**
- Modify: `percolator-shared/src/config.ts`
- Test: `percolator-shared/tests/config-sender.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// percolator-shared/tests/config-sender.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Sender config flags", () => {
  beforeEach(() => {
    delete process.env.USE_HELIUS_SENDER;
    delete process.env.JITO_TIP_LAMPORTS;
    delete process.env.HELIUS_PRIORITY_LEVEL;
  });

  it("defaults USE_HELIUS_SENDER to false (opt-in)", () => {
    const c = loadConfig();
    expect(c.useHeliusSender).toBe(false);
  });

  it("reads USE_HELIUS_SENDER=true", () => {
    process.env.USE_HELIUS_SENDER = "true";
    expect(loadConfig().useHeliusSender).toBe(true);
  });

  it("defaults JITO_TIP_LAMPORTS to 200000", () => {
    expect(loadConfig().jitoTipLamports).toBe(200_000);
  });

  it("accepts custom tip", () => {
    process.env.JITO_TIP_LAMPORTS = "500000";
    expect(loadConfig().jitoTipLamports).toBe(500_000);
  });

  it("defaults priority level to High", () => {
    expect(loadConfig().heliusPriorityLevel).toBe("High");
  });

  it("accepts VeryHigh", () => {
    process.env.HELIUS_PRIORITY_LEVEL = "VeryHigh";
    expect(loadConfig().heliusPriorityLevel).toBe("VeryHigh");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd /Users/khubair/percolator-shared && pnpm vitest run tests/config-sender.test.ts`

- [ ] **Step 3: Add config fields**

In `percolator-shared/src/config.ts`, inside `loadConfig()`:

```typescript
export interface PercolatorConfig {
  // ...existing fields...
  useHeliusSender: boolean;
  jitoTipLamports: number;
  heliusPriorityLevel: "Min" | "Low" | "Medium" | "High" | "VeryHigh";
}

export function loadConfig(): PercolatorConfig {
  return {
    // ...existing fields...
    useHeliusSender: process.env.USE_HELIUS_SENDER === "true",
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10),
    heliusPriorityLevel:
      (process.env.HELIUS_PRIORITY_LEVEL as PercolatorConfig["heliusPriorityLevel"]) ?? "High",
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config-sender.test.ts
git commit -m "feat(shared): add USE_HELIUS_SENDER config flag"
```

### Task 1.3: Add sendWithHeliusSender wrapper

**Files:**
- Modify: `percolator-shared/src/utils/solana.ts`
- Test: `percolator-shared/tests/sender-wrapper.test.ts`

This task builds a new function `sendKeeperTxViaSender()` that wraps the existing primitives: builds Transaction, adds compute budget + Jito tip + priority fee, signs, POSTs via `sendViaHeliusSender`, polls status.

- [ ] **Step 1: Write the failing test (mocked fetch)**

```typescript
// percolator-shared/tests/sender-wrapper.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { sendKeeperTxViaSender } from "../src/utils/solana.js";

const FAKE_SIG = "5".repeat(88);

describe("sendKeeperTxViaSender", () => {
  let connection: Connection;
  const signer = Keypair.generate();
  const noopIx = SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: PublicKey.default,
    lamports: 1,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    connection = new Connection("https://mainnet.helius-rpc.com/?api-key=stub", "confirmed");
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: "A".repeat(44),
      lastValidBlockHeight: 1,
    });
    vi.spyOn(connection, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 },
      value: { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
    });
  });

  it("POSTs to sender.helius-rpc.com/fast with skipPreflight + includes Jito tip ix", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: FAKE_SIG }), { status: 200 }),
    );

    // getHeliusPriorityFee also calls fetch — mock it to return a known value.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { priorityFeeEstimate: 5000 } }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: FAKE_SIG }), { status: 200 }),
    );

    const sig = await sendKeeperTxViaSender(connection, [noopIx], [signer], {
      priorityLevel: "High",
      tipLamports: 200_000,
    });

    expect(sig).toBe(FAKE_SIG);
    // Second call is the Sender POST — inspect it.
    const senderCall = fetchMock.mock.calls[1];
    expect(senderCall[0]).toContain("sender.helius-rpc.com/fast");
    const body = JSON.parse(senderCall[1]!.body as string);
    expect(body.params[1].skipPreflight).toBe(true);
  });

  it("throws on non-2xx from Sender", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { priorityFeeEstimate: 5000 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -32000, message: "bad" } }), { status: 200 }));

    await expect(sendKeeperTxViaSender(connection, [noopIx], [signer], {
      priorityLevel: "High",
      tipLamports: 200_000,
    })).rejects.toThrow(/Helius Sender error/);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm vitest run tests/sender-wrapper.test.ts` — function doesn't exist yet.

- [ ] **Step 3: Implement `sendKeeperTxViaSender`**

Add to `percolator-shared/src/utils/solana.ts` (place after `sendViaHeliusSender`, around line 484):

```typescript
export interface SenderSendOptions {
  priorityLevel?: "Min" | "Low" | "Medium" | "High" | "VeryHigh";
  tipLamports?: number;
  computeUnitLimit?: number;
}

export async function sendKeeperTxViaSender(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  opts: SenderSendOptions = {},
): Promise<string> {
  const priorityLevel = opts.priorityLevel ?? "High";
  const tipLamports = opts.tipLamports ?? 200_000;
  const computeUnitLimit = opts.computeUnitLimit ?? 400_000;

  const rpcUrl = connection.rpcEndpoint;
  const accountKeys = Array.from(
    new Set(instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))),
  );
  const microLamports = await getHeliusPriorityFee(rpcUrl, accountKeys, priorityLevel);

  const tipIx = createJitoTipInstruction(signers[0].publicKey, tipLamports);

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    tipIx,
    ...instructions,
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  checkTransactionSize(tx);

  const sig = await sendViaHeliusSender(rpcUrl, tx.serialize());
  await pollSignatureStatus(connection, sig);
  return sig;
}
```

- [ ] **Step 4: Export from root**

Add `sendKeeperTxViaSender` and the `SenderSendOptions` type to the re-exports in `percolator-shared/src/index.ts`.

- [ ] **Step 5: Run test, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/utils/solana.ts src/index.ts tests/sender-wrapper.test.ts
git commit -m "feat(shared): add sendKeeperTxViaSender wrapper (Sender + priority fee + Jito tip)"
```

### Task 1.4: Route sendWithRetryKeeper through Sender when flag enabled

**Files:**
- Modify: `percolator-shared/src/utils/solana.ts` (lines 341-403)
- Test: `percolator-shared/tests/retry-keeper-flag.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// percolator-shared/tests/retry-keeper-flag.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, SystemProgram, PublicKey, Connection } from "@solana/web3.js";
import { sendWithRetryKeeper } from "../src/utils/solana.js";

const FAKE_SIG = "5".repeat(88);

describe("sendWithRetryKeeper honors USE_HELIUS_SENDER flag", () => {
  const signer = Keypair.generate();
  const ix = SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: PublicKey.default,
    lamports: 1,
  });
  let conn: Connection;

  beforeEach(() => {
    conn = new Connection("https://mainnet.helius-rpc.com/?api-key=stub", "confirmed");
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "A".repeat(44), lastValidBlockHeight: 1 });
    vi.spyOn(conn, "getSignatureStatus").mockResolvedValue({
      context: { slot: 1 }, value: { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
    });
  });
  afterEach(() => {
    delete process.env.USE_HELIUS_SENDER;
    vi.restoreAllMocks();
  });

  it("calls sender.helius-rpc.com when USE_HELIUS_SENDER=true", async () => {
    process.env.USE_HELIUS_SENDER = "true";
    const fetchMock = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { priorityFeeEstimate: 5000 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", result: FAKE_SIG }), { status: 200 }));

    await sendWithRetryKeeper(conn, [ix], [signer]);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("sender.helius-rpc.com"))).toBe(true);
  });

  it("uses sendRawTransaction path when flag unset", async () => {
    const sendRawSpy = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue(FAKE_SIG);
    // also stub the priority fee call getRecentPriorityFees depends on
    vi.spyOn(conn, "getRecentPrioritizationFees").mockResolvedValue([{ slot: 1, prioritizationFee: 1000 }]);
    await sendWithRetryKeeper(conn, [ix], [signer]);
    expect(sendRawSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

- [ ] **Step 3: Modify `sendWithRetryKeeper`**

At top of `sendWithRetryKeeper` (line 347), branch on the flag:

```typescript
export async function sendWithRetryKeeper(
  connection: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  maxRetries = 3,
  keeperOpts?: KeeperSendOptions,
): Promise<string> {
  // Helius Sender fast path — opt-in via env flag.
  if (process.env.USE_HELIUS_SENDER === "true") {
    const priorityLevel = (process.env.HELIUS_PRIORITY_LEVEL as "High" | "VeryHigh") ?? "High";
    const tipLamports = parseInt(process.env.JITO_TIP_LAMPORTS ?? "200000", 10);
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await sendKeeperTxViaSender(connection, instructions, signers, {
          priorityLevel,
          tipLamports,
          computeUnitLimit: keeperOpts?.computeUnitLimit,
        });
      } catch (err) {
        lastErr = err;
        const delay = is429(err) ? backoffMs(attempt, 2000, 30_000) : Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`[sendWithRetryKeeper/sender] attempt ${attempt + 1}/${maxRetries} failed: ${String(err)}, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  // ...existing legacy path continues unchanged...
```

Also add `computeUnitLimit?: number` to `KeeperSendOptions` if not present.

- [ ] **Step 4: Run test, expect PASS (both cases)**

- [ ] **Step 5: Commit**

```bash
git add src/utils/solana.ts tests/retry-keeper-flag.test.ts
git commit -m "feat(shared): USE_HELIUS_SENDER routes sendWithRetryKeeper via Helius Sender"
```

### Task 1.5: Update keeper .env + docs

**Files:**
- Modify: `percolator-keeper/docs/env/README.md`
- Modify: `percolator-keeper/.env.example`

- [ ] **Step 1: Add env docs**

Append to `percolator-keeper/docs/env/README.md`:

```markdown
## Helius Sender (optional, recommended for mainnet)

| Var | Default | Notes |
|---|---|---|
| `USE_HELIUS_SENDER` | `false` | Set `true` to route cranks via Helius Sender API |
| `HELIUS_PRIORITY_LEVEL` | `High` | `Min` / `Low` / `Medium` / `High` / `VeryHigh` |
| `JITO_TIP_LAMPORTS` | `200000` | 0.0002 SOL minimum for dual-routing |
| `HELIUS_ATLAS_WS_URL` | — | `wss://atlas-mainnet.helius-rpc.com?api-key=<key>` (Phase 2) |

Requires `SOLANA_RPC_URL` to already be a Helius mainnet endpoint (`https://mainnet.helius-rpc.com/?api-key=...`).
Sender is opt-in; setting `USE_HELIUS_SENDER=true` bypasses the legacy `sendRawTransaction` path and uses `sendKeeperTxViaSender` with dual-routing + Jito tip + program-specific priority fee estimate.
```

- [ ] **Step 2: Append to `.env.example`**

```
# Helius Sender (Phase 1 performance upgrade)
USE_HELIUS_SENDER=false
HELIUS_PRIORITY_LEVEL=High
JITO_TIP_LAMPORTS=200000
# HELIUS_ATLAS_WS_URL=wss://atlas-mainnet.helius-rpc.com?api-key=...
```

- [ ] **Step 3: Commit**

```bash
cd /Users/khubair/percolator-keeper
git add docs/env/README.md .env.example
git commit -m "docs(keeper): document USE_HELIUS_SENDER env flags"
```

### Task 1.6: Devnet smoke test

**Files:**
- Create: `percolator-keeper/scripts/smoke-sender.ts`

- [ ] **Step 1: Write smoke script**

```typescript
// percolator-keeper/scripts/smoke-sender.ts
import { Connection, Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { sendKeeperTxViaSender, loadKeypair } from "@percolatorct/shared";

async function main() {
  const url = process.env.SOLANA_RPC_URL!;
  const conn = new Connection(url, "confirmed");
  const kp = await loadKeypair(process.env.KEEPER_KEYPAIR_PATH!);
  const ix = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: kp.publicKey,
    lamports: 1,
  });
  const t0 = Date.now();
  const sig = await sendKeeperTxViaSender(conn, [ix], [kp], { priorityLevel: "High", tipLamports: 200_000 });
  const elapsed = Date.now() - t0;
  console.log(`sig=${sig} elapsed_ms=${elapsed}`);
  console.log(`orbmarkets: https://orbmarkets.io/tx/${sig}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run on devnet**

```bash
cd /Users/khubair/percolator-keeper
SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS_KEY" \
KEEPER_KEYPAIR_PATH=~/.config/solana/keeper-devnet.json \
pnpm tsx scripts/smoke-sender.ts
```

Expected: `elapsed_ms` < 2000 (one-slot land). If > 5000, tip too low or RPC wrong.

- [ ] **Step 3: Commit script**

```bash
git add scripts/smoke-sender.ts
git commit -m "test(keeper): smoke script for Helius Sender roundtrip"
```

### Task 1.7: Reduce crank intervals (after Sender verified working)

**Files:**
- Modify: `percolator-keeper/.env.production` (or the equivalent mainnet env file)
- Modify: `percolator-shared/src/config.ts` (defaults only if there are no market-specific overrides)

- [ ] **Step 1: Change cadence (mainnet env)**

Change in mainnet env:
- `CRANK_INTERVAL_MS`: `30000` → `2000`
- `CRANK_INACTIVE_INTERVAL_MS`: `60000` → `10000`
- `ADL_INTERVAL_MS`: `10000` → `2000`
- `LIQUIDATION_SCAN_INTERVAL_MS`: `60000` → `5000`
- `ORACLE_RATE_LIMIT_MS` (in `oracle.ts:57`): `5000` → `1000` (requires code change)

- [ ] **Step 2: Change `rateLimitMs` default in oracle service**

In `percolator-keeper/src/services/oracle.ts:57`, make configurable:

```typescript
constructor(...) {
  this.rateLimitMs = parseInt(process.env.ORACLE_RATE_LIMIT_MS ?? "5000", 10);
  // ...
}
```

- [ ] **Step 3: Add Vitest coverage for new env**

```typescript
// percolator-keeper/tests/oracle-rate-limit.test.ts
import { describe, it, expect } from "vitest";
import { OracleService } from "../src/services/oracle.js";

describe("OracleService rate limit", () => {
  it("respects ORACLE_RATE_LIMIT_MS env override", () => {
    process.env.ORACLE_RATE_LIMIT_MS = "500";
    const svc = new OracleService(/* mock deps */ {} as any);
    expect((svc as any).rateLimitMs).toBe(500);
  });
});
```

- [ ] **Step 4: Commit**

```bash
cd /Users/khubair/percolator-keeper
git add src/services/oracle.ts tests/oracle-rate-limit.test.ts
git commit -m "feat(keeper): ORACLE_RATE_LIMIT_MS env override for sub-5s oracle pushes"
```

### Task 1.8: Land-rate + tip-spend metrics

**Files:**
- Modify: `percolator-keeper/src/services/crank.ts` (around line 571)
- Create: `percolator-keeper/src/lib/sender-metrics.ts`

- [ ] **Step 1: Write metrics module**

```typescript
// percolator-keeper/src/lib/sender-metrics.ts
export interface SenderMetrics {
  attempts: number;
  landed: number;
  failed: number;
  tipLamportsSpent: number;
  lastTxSlot?: number;
  lastTxElapsedMs?: number;
}
const metrics: SenderMetrics = { attempts: 0, landed: 0, failed: 0, tipLamportsSpent: 0 };
export function recordAttempt() { metrics.attempts++; }
export function recordLanded(elapsedMs: number, tip: number, slot?: number) {
  metrics.landed++;
  metrics.tipLamportsSpent += tip;
  metrics.lastTxElapsedMs = elapsedMs;
  metrics.lastTxSlot = slot;
}
export function recordFailed() { metrics.failed++; }
export function snapshotMetrics(): SenderMetrics { return { ...metrics }; }
```

- [ ] **Step 2: Wire into crank send sites** (`crank.ts:571, 610`, `liquidation.ts:410`, `adl.ts:463`)

Wrap each `sendWithRetryKeeper` call with `recordAttempt()` before, `recordLanded(...)` after success, `recordFailed()` in catch.

- [ ] **Step 3: Expose in health endpoint**

If `percolator-keeper/src/index.ts` has an HTTP/status endpoint, add `senderMetrics: snapshotMetrics()` to the payload.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sender-metrics.ts src/services/crank.ts src/services/liquidation.ts src/services/adl.ts src/index.ts
git commit -m "feat(keeper): emit Sender land-rate + tip-spend metrics"
```

### Task 1.9: Mainnet rollout + 24h monitor

**Files:** none (ops only)

- [ ] **Step 1: Deploy keeper to mainnet with `USE_HELIUS_SENDER=true`, CRANK_INTERVAL_MS=30000 (unchanged)**

Rationale: verify Sender works before cutting cadence.

- [ ] **Step 2: Monitor for 2h**

Check `senderMetrics`: `landed/attempts > 0.95`, `lastTxElapsedMs < 1500`.

- [ ] **Step 3: Cut CRANK_INTERVAL_MS to 2000**

Redeploy. Monitor 24h. Watch SOL burn rate on keeper wallet — should be ~15x baseline at 2s cadence.

**Phase 1 exit criteria:** keeper running at 2s cadence, landed-rate > 95%, tip spend documented, no liquidation backlog.

---

## Phase 2 — Enhanced WebSockets for indexer

### Task 2.1: Add HELIUS_ATLAS_WS_URL config + connection

**Files:**
- Modify: `percolator-shared/src/config.ts`
- Create: `percolator-shared/src/utils/atlas-ws.ts`
- Test: `percolator-shared/tests/atlas-ws.test.ts`

- [ ] **Step 1: Write failing test for WS factory**

```typescript
// percolator-shared/tests/atlas-ws.test.ts
import { describe, it, expect } from "vitest";
import { createAtlasWs } from "../src/utils/atlas-ws.js";

describe("createAtlasWs", () => {
  it("throws if HELIUS_ATLAS_WS_URL missing", () => {
    delete process.env.HELIUS_ATLAS_WS_URL;
    expect(() => createAtlasWs()).toThrow(/HELIUS_ATLAS_WS_URL/);
  });
  it("returns a WebSocket client when url set", () => {
    process.env.HELIUS_ATLAS_WS_URL = "wss://atlas-mainnet.helius-rpc.com?api-key=stub";
    const ws = createAtlasWs();
    expect(ws).toBeDefined();
    ws.close();
  });
});
```

- [ ] **Step 2: Write implementation**

```typescript
// percolator-shared/src/utils/atlas-ws.ts
import WebSocket from "ws";

export interface AtlasWs {
  sub(id: number, method: string, params: unknown[]): void;
  onNotification(cb: (msg: any) => void): void;
  close(): void;
}

export function createAtlasWs(): AtlasWs {
  const url = process.env.HELIUS_ATLAS_WS_URL;
  if (!url) throw new Error("HELIUS_ATLAS_WS_URL not set");

  const ws = new WebSocket(url);
  const listeners: Array<(msg: any) => void> = [];

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method && msg.params) listeners.forEach((l) => l(msg));
    } catch {}
  });

  return {
    sub(id, method, params) {
      const send = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      if (ws.readyState === WebSocket.OPEN) send();
      else ws.once("open", send);
    },
    onNotification(cb) { listeners.push(cb); },
    close() { ws.close(); },
  };
}
```

- [ ] **Step 3: Install `ws` in shared** (if not present): `pnpm add ws @types/ws`

- [ ] **Step 4: Commit**

```bash
cd /Users/khubair/percolator-shared
git add src/utils/atlas-ws.ts src/index.ts tests/atlas-ws.test.ts package.json
git commit -m "feat(shared): Atlas WebSocket client factory"
```

### Task 2.2: Build EventStreamService in indexer

**Files:**
- Create: `percolator-indexer/src/services/EventStreamService.ts`
- Test: `percolator-indexer/tests/EventStreamService.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// percolator-indexer/tests/EventStreamService.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventStreamService } from "../src/services/EventStreamService.js";

describe("EventStreamService", () => {
  it("subscribes to Percolator program on start", async () => {
    const sub = vi.fn();
    const ws = { sub, onNotification: vi.fn(), close: vi.fn() };
    const svc = new EventStreamService({ ws: ws as any, programId: "PERC11111111111111111111111111111111111111" });
    await svc.start();
    expect(sub).toHaveBeenCalledWith(
      expect.any(Number),
      "transactionSubscribe",
      expect.arrayContaining([
        expect.objectContaining({ accountInclude: ["PERC11111111111111111111111111111111111111"] }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// percolator-indexer/src/services/EventStreamService.ts
import type { AtlasWs } from "@percolatorct/shared";
import { createLogger, getSupabase } from "@percolatorct/shared";

interface Deps {
  ws: AtlasWs;
  programId: string;
  onFill?: (fill: ParsedFill) => Promise<void>;
  onLiquidation?: (liq: ParsedLiquidation) => Promise<void>;
  onFundingTick?: (tick: ParsedFundingTick) => Promise<void>;
}

export interface ParsedFill { market: string; price: number; size: number; side: "buy" | "sell"; ts: number; sig: string; }
export interface ParsedLiquidation { market: string; account: string; pnl: number; ts: number; sig: string; }
export interface ParsedFundingTick { market: string; rate: number; ts: number; sig: string; }

const log = createLogger("EventStream");

export class EventStreamService {
  constructor(private d: Deps) {}

  async start(): Promise<void> {
    this.d.ws.sub(1, "transactionSubscribe", [
      { accountInclude: [this.d.programId], failed: false },
      { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "full", showRewards: false, maxSupportedTransactionVersion: 0 },
    ]);
    this.d.ws.onNotification((msg) => this.handle(msg).catch((e) => log.error("handler failed", { err: String(e) })));
  }

  private async handle(msg: any): Promise<void> {
    if (msg.method !== "transactionNotification") return;
    const tx = msg.params?.result?.transaction;
    const sig = msg.params?.result?.signature;
    const slot = msg.params?.result?.slot;
    if (!tx || !sig) return;

    // TODO (task 2.3): parse fills/liqs/funding from tx.meta.innerInstructions + logs
    log.debug("tx", { sig, slot });
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/khubair/percolator-indexer
git add src/services/EventStreamService.ts tests/EventStreamService.test.ts
git commit -m "feat(indexer): EventStreamService skeleton subscribing to program transactions"
```

### Task 2.3: Parse Percolator instructions from streamed transactions

**Files:**
- Create: `percolator-indexer/src/parsers/percolatorTxParser.ts`
- Test: `percolator-indexer/tests/parsers/percolatorTxParser.test.ts`

- [ ] **Step 1: Capture a real Percolator fill tx from mainnet for fixture**

```bash
# Find a recent fill from any active market
curl "https://mainnet.helius-rpc.com/?api-key=$HELIUS_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["<SOL_USDC_SLAB>",{"limit":5}]}'
```

Fetch one full tx via Helius `parseTransactions` MCP tool and save JSON to `percolator-indexer/tests/fixtures/fill-tx.json`.

- [ ] **Step 2: Write failing test against fixture**

```typescript
import fillTx from "./fixtures/fill-tx.json";
import { parsePercolatorTx } from "../../src/parsers/percolatorTxParser.js";

describe("parsePercolatorTx", () => {
  it("extracts a Fill event from tx meta", () => {
    const events = parsePercolatorTx(fillTx);
    expect(events.fills.length).toBeGreaterThan(0);
    expect(events.fills[0]).toMatchObject({
      market: expect.any(String),
      price: expect.any(Number),
      size: expect.any(Number),
      side: expect.stringMatching(/buy|sell/),
    });
  });
});
```

- [ ] **Step 3: Implement parser**

The parser reads `tx.meta.logMessages` for Percolator anchor-style log discriminators (`Program log: fill:`, `Program log: liq:`, etc.) — exact format depends on current `msg!` calls in `percolator-prog`. Use the SDK's `decodeEvent` if available; otherwise regex on the log strings.

```typescript
// percolator-indexer/src/parsers/percolatorTxParser.ts
import type { ParsedFill, ParsedLiquidation, ParsedFundingTick } from "../services/EventStreamService.js";

export interface ParsedEvents {
  fills: ParsedFill[];
  liquidations: ParsedLiquidation[];
  fundingTicks: ParsedFundingTick[];
}

const FILL_LOG = /^Program log: fill:(?<market>\w+):(?<side>buy|sell):price=(?<price>\d+(?:\.\d+)?):size=(?<size>\d+(?:\.\d+)?):ts=(?<ts>\d+)$/;
const LIQ_LOG = /^Program log: liq:(?<market>\w+):account=(?<acct>\w+):pnl=(?<pnl>-?\d+(?:\.\d+)?):ts=(?<ts>\d+)$/;
const FUND_LOG = /^Program log: fund:(?<market>\w+):rate=(?<rate>-?\d+(?:\.\d+)?):ts=(?<ts>\d+)$/;

export function parsePercolatorTx(tx: any): ParsedEvents {
  const sig = tx.transaction?.signatures?.[0] ?? tx.signature;
  const logs: string[] = tx.meta?.logMessages ?? [];
  const out: ParsedEvents = { fills: [], liquidations: [], fundingTicks: [] };

  for (const line of logs) {
    const f = line.match(FILL_LOG);
    if (f?.groups) {
      out.fills.push({
        market: f.groups.market,
        side: f.groups.side as "buy" | "sell",
        price: Number(f.groups.price),
        size: Number(f.groups.size),
        ts: Number(f.groups.ts),
        sig,
      });
      continue;
    }
    const l = line.match(LIQ_LOG);
    if (l?.groups) {
      out.liquidations.push({ market: l.groups.market, account: l.groups.acct, pnl: Number(l.groups.pnl), ts: Number(l.groups.ts), sig });
      continue;
    }
    const fd = line.match(FUND_LOG);
    if (fd?.groups) out.fundingTicks.push({ market: fd.groups.market, rate: Number(fd.groups.rate), ts: Number(fd.groups.ts), sig });
  }
  return out;
}
```

**NOTE:** If current Percolator program does not emit these exact log strings, either (a) add them to `percolator-prog` via a follow-up micro-PR, or (b) parse from the MatchEvent struct in tx inner instructions using the SDK's `decodeInstruction`. The regex-on-logs approach is the lowest-effort path but requires program cooperation.

- [ ] **Step 4: Commit**

```bash
git add src/parsers/percolatorTxParser.ts tests/parsers tests/fixtures
git commit -m "feat(indexer): parse Fill/Liquidation/FundingTick from streamed tx logs"
```

### Task 2.4: Persist events to Supabase trades/liquidations tables

**Files:**
- Create: `percolator-indexer/migrations/YYYYMMDD_trades_hypertable.sql`
- Modify: `percolator-indexer/src/services/EventStreamService.ts`

- [ ] **Step 1: Add `trades` table migration**

Supabase is Postgres; TimescaleDB extension is available on paid tiers. If not available, use plain Postgres with an index on `(market, ts)`.

```sql
-- percolator-indexer/migrations/20260420_trades.sql
CREATE TABLE IF NOT EXISTS trades (
  sig        text        NOT NULL,
  market     text        NOT NULL,
  side       text        NOT NULL CHECK (side IN ('buy','sell')),
  price      numeric     NOT NULL,
  size       numeric     NOT NULL,
  ts         timestamptz NOT NULL,
  slot       bigint,
  PRIMARY KEY (sig, market)
);
CREATE INDEX IF NOT EXISTS trades_market_ts_idx ON trades (market, ts DESC);

-- If TimescaleDB available:
-- SELECT create_hypertable('trades', 'ts', if_not_exists => TRUE);
-- ALTER TABLE trades SET (timescaledb.compress, timescaledb.compress_segmentby = 'market');
-- SELECT add_compression_policy('trades', INTERVAL '7 days', if_not_exists => TRUE);
-- SELECT add_retention_policy('trades', INTERVAL '90 days', if_not_exists => TRUE);
```

- [ ] **Step 2: Wire parser → Supabase insert in EventStreamService**

In `EventStreamService.handle()`:

```typescript
private async handle(msg: any): Promise<void> {
  if (msg.method !== "transactionNotification") return;
  const tx = msg.params?.result;
  if (!tx) return;
  const events = parsePercolatorTx(tx);
  const sb = getSupabase();

  if (events.fills.length) {
    await sb.from("trades").upsert(
      events.fills.map((f) => ({ sig: f.sig, market: f.market, side: f.side, price: f.price, size: f.size, ts: new Date(f.ts * 1000).toISOString(), slot: tx.slot })),
      { onConflict: "sig,market" },
    );
  }
  // similar for liquidations, funding ticks
}
```

- [ ] **Step 3: Commit**

```bash
git add migrations/ src/services/EventStreamService.ts
git commit -m "feat(indexer): persist streamed fills to trades hypertable"
```

### Task 2.5: Drop StatsCollector poll cadence to backup-only

**Files:**
- Modify: `percolator-indexer/src/services/StatsCollector.ts`

- [ ] **Step 1: Raise intervals**

```typescript
const COLLECT_INTERVAL_MS = 300_000;        // 2min → 5min (backup only; WS is primary)
const VOLUME_SYNC_INTERVAL_MS = 10 * 60_000; // 5min → 10min
```

- [ ] **Step 2: Commit**

```bash
git add src/services/StatsCollector.ts
git commit -m "perf(indexer): reduce poll cadence to backup (WS is primary data path)"
```

### Task 2.6: Wire EventStreamService into indexer entry point

**Files:**
- Modify: `percolator-indexer/src/index.ts`

- [ ] **Step 1: Create and start the service alongside StatsCollector**

```typescript
import { createAtlasWs } from "@percolatorct/shared";
import { EventStreamService } from "./services/EventStreamService.js";

// ...in main startup:
const ws = createAtlasWs();
const eventStream = new EventStreamService({ ws, programId: PERCOLATOR_PROGRAM_ID.toBase58() });
await eventStream.start();
```

- [ ] **Step 2: Add reconnect/backoff**

Wrap `eventStream.start()` in a loop with `ws.on("close", reconnect)` handler. On disconnect: re-open WS, re-subscribe.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(indexer): enable Atlas WS event stream"
```

**Phase 2 exit criteria:** Fills appear in Supabase `trades` table within 2s of on-chain confirmation (measured by `NOW() - ts` after insert). WS reconnects cleanly within 30s of disconnect.

---

## Phase 3 — Internal-trade candles → chart

### Task 3.1: Materialize candle views

**Files:**
- Create: `percolator-indexer/migrations/YYYYMMDD_candle_aggregates.sql`

- [ ] **Step 1: Create 1m/5m/15m/1h/4h/1d continuous aggregates**

If TimescaleDB is available:

```sql
-- percolator-indexer/migrations/20260421_candles.sql
CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT
  market,
  time_bucket('1 minute', ts) AS bucket,
  first(price, ts) AS open,
  max(price) AS high,
  min(price) AS low,
  last(price, ts) AS close,
  sum(size) AS volume
FROM trades
GROUP BY market, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_1m',
  start_offset => INTERVAL '2 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

-- Repeat for 5m, 15m, 1h, 4h, 1d with adjusted bucket + offset.
```

Fallback for plain Postgres: use a scheduled Supabase Edge Function or cron that runs `INSERT INTO candles_1m SELECT ... FROM trades WHERE ts > now() - interval '2 min' ON CONFLICT DO UPDATE`.

- [ ] **Step 2: Commit**

```bash
git add migrations/20260421_candles.sql
git commit -m "feat(indexer): continuous aggregates for OHLCV candles"
```

### Task 3.2: Add `/candles/:market` endpoint to percolator-api

**Files:**
- Create: `percolator-api/src/routes/candles.ts`
- Test: `percolator-api/tests/routes/candles.test.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
// percolator-api/tests/routes/candles.test.ts
import { describe, it, expect } from "vitest";
import { build } from "../helpers.js";

describe("GET /candles/:market", () => {
  it("returns OHLCV bars in UDF shape", async () => {
    const app = await build();
    const res = await app.inject({ url: "/candles/SOL-USDC?resolution=1&from=0&to=9999999999" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      s: "ok", t: expect.any(Array), o: expect.any(Array),
      h: expect.any(Array), l: expect.any(Array), c: expect.any(Array), v: expect.any(Array),
    });
  });
});
```

- [ ] **Step 2: Implement route**

```typescript
// percolator-api/src/routes/candles.ts
import type { FastifyInstance } from "fastify";
import { getSupabase } from "@percolatorct/shared";

const RES_TO_VIEW: Record<string, string> = {
  "1": "candles_1m", "5": "candles_5m", "15": "candles_15m",
  "60": "candles_1h", "240": "candles_4h", "1D": "candles_1d",
};

export default async function candles(app: FastifyInstance) {
  app.get<{ Params: { market: string }; Querystring: { resolution: string; from: string; to: string } }>(
    "/candles/:market",
    async (req) => {
      const view = RES_TO_VIEW[req.query.resolution] ?? "candles_1m";
      const { data, error } = await getSupabase()
        .from(view)
        .select("bucket, open, high, low, close, volume")
        .eq("market", req.params.market)
        .gte("bucket", new Date(Number(req.query.from) * 1000).toISOString())
        .lte("bucket", new Date(Number(req.query.to) * 1000).toISOString())
        .order("bucket", { ascending: true })
        .limit(5000);
      if (error || !data) return { s: "no_data" };
      return {
        s: "ok",
        t: data.map((r) => Math.floor(new Date(r.bucket).getTime() / 1000)),
        o: data.map((r) => Number(r.open)),
        h: data.map((r) => Number(r.high)),
        l: data.map((r) => Number(r.low)),
        c: data.map((r) => Number(r.close)),
        v: data.map((r) => Number(r.volume)),
      };
    },
  );
}
```

- [ ] **Step 3: Register route in server.ts**

- [ ] **Step 4: Commit**

```bash
cd /Users/khubair/percolator-api
git add src/routes/candles.ts src/server.ts tests/routes/candles.test.ts
git commit -m "feat(api): /candles/:market UDF-shape OHLCV endpoint"
```

### Task 3.3: Live candle WS channel

**Files:**
- Create: `percolator-api/src/ws/candleStream.ts`
- Modify: `percolator-api/src/server.ts` (register ws plugin)

- [ ] **Step 1: Write failing test for WS push**

Use `@fastify/websocket` test harness — connect client, insert a row into `trades`, expect a `candle-update` message within 2s.

- [ ] **Step 2: Implement**

```typescript
// percolator-api/src/ws/candleStream.ts
import type { FastifyInstance } from "fastify";
import { getSupabase } from "@percolatorct/shared";

export default async function candleStream(app: FastifyInstance) {
  app.register(import("@fastify/websocket"));
  app.get("/ws/candles/:market/:resolution", { websocket: true }, async (conn, req) => {
    const { market, resolution } = req.params as { market: string; resolution: string };
    const sb = getSupabase();
    // Supabase Realtime: subscribe to trades inserts for this market
    const ch = sb.channel(`trades:${market}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "trades", filter: `market=eq.${market}` },
        async () => {
          // Recompute the latest bar from the relevant continuous-aggregate view
          const view = `candles_${resolution === "1D" ? "1d" : `${resolution}m`}`;
          const { data } = await sb.from(view).select("*").eq("market", market).order("bucket", { ascending: false }).limit(1);
          if (data?.[0]) conn.socket.send(JSON.stringify({ type: "bar", bar: data[0] }));
        })
      .subscribe();
    conn.socket.on("close", () => sb.removeChannel(ch));
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ws/candleStream.ts src/server.ts
git commit -m "feat(api): live candle WS channel via Supabase Realtime"
```

### Task 3.4: Frontend `usePercolatorCandles` hook

**Files:**
- Create: `percolator-launch/app/hooks/usePercolatorCandles.ts`
- Modify: `percolator-launch/app/components/trade/TradingChart.tsx` (chart data source cascade)

- [ ] **Step 1: Implement hook**

```typescript
// percolator-launch/app/hooks/usePercolatorCandles.ts
import { useEffect, useRef, useState } from "react";
import type { CandlestickData, HistogramData } from "lightweight-charts";

const RES_MAP: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1D" };

export function usePercolatorCandles(market: string | null, timeframe: string) {
  const [candles, setCandles] = useState<CandlestickData[]>([]);
  const [volume, setVolume] = useState<HistogramData[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!market) return;
    const resolution = RES_MAP[timeframe] ?? "1";
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 24 * 7;

    (async () => {
      const res = await fetch(`/api/candles/${market}?resolution=${resolution}&from=${from}&to=${to}`);
      const body = await res.json();
      if (body.s !== "ok") return;
      setCandles(body.t.map((t: number, i: number) => ({ time: t, open: body.o[i], high: body.h[i], low: body.l[i], close: body.c[i] })));
      setVolume(body.t.map((t: number, i: number) => ({ time: t, value: body.v[i] })));
    })();

    const ws = new WebSocket(`${process.env.NEXT_PUBLIC_PERCOLATOR_WS}/ws/candles/${market}/${resolution}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "bar") {
        const bar = msg.bar;
        const time = Math.floor(new Date(bar.bucket).getTime() / 1000);
        setCandles((prev) => {
          const idx = prev.findIndex((c) => c.time === time);
          const next: CandlestickData = { time, open: +bar.open, high: +bar.high, low: +bar.low, close: +bar.close };
          if (idx >= 0) { const copy = prev.slice(); copy[idx] = next; return copy; }
          return [...prev, next];
        });
      }
    };
    return () => ws.close();
  }, [market, timeframe]);

  return { candles, volume };
}
```

- [ ] **Step 2: Add "Percolator" as tier-0 source in `TradingChart.tsx`**

Modify the existing data-source cascade (currently Pyth → Gecko → Oracle). Insert Percolator candles as tier-0 when the market has trades:

```typescript
const percolator = usePercolatorCandles(market?.address ?? null, timeframe);
const pyth = usePythChart(pythSymbol, timeframe);
const token = useTokenChart(...);

const { source, candles, volume } = useMemo(() => {
  if (percolator.candles.length >= 10) return { source: "PERCOLATOR", candles: percolator.candles, volume: percolator.volume };
  if (pyth.candles.length) return { source: "PYTH", candles: pyth.candles, volume: pyth.volume };
  // ...existing fallbacks
}, [percolator, pyth, ...]);
```

- [ ] **Step 3: Update the data-source badge to include PERCOLATOR**

- [ ] **Step 4: Commit**

```bash
cd /Users/khubair/percolator-launch
git add app/hooks/usePercolatorCandles.ts app/components/trade/TradingChart.tsx
git commit -m "feat(launch): chart uses internal-trade candles when available"
```

**Phase 3 exit criteria:** Chart on mainnet SOL/USDC slab shows Percolator's own fills as candles, updating within 2s of trades landing on-chain. Pyth remains fallback for long-tail / low-volume markets.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Jito tip burn outpaces SOL treasury at 2s cadence | Task 1.8 metrics; scripted alert at 0.5 SOL/day threshold; back off to 5s if overruns |
| Percolator program doesn't emit parseable logs | Task 2.3 has fallback to inner-instruction decoding via SDK; worst case add a micro-PR to `percolator-prog` adding explicit event logs |
| Supabase Realtime can't keep up with streamed inserts | Batch trades into 100ms micro-buckets before insert; or move to a dedicated Redis pub/sub |
| Atlas WS reconnects miss txs during gap | Task 2.6 reconnect logic + Task 1.7 keeps StatsCollector as 5min backup sweep |
| TimescaleDB not available on current Supabase plan | Fallback to plain Postgres + scheduled aggregation cron (Task 3.1 Step 1) |

## Rollback

Each phase is independently revertable:
- **Phase 1:** `USE_HELIUS_SENDER=false` → instantly back to legacy path
- **Phase 2:** Comment out `eventStream.start()`, StatsCollector still covers at 5min
- **Phase 3:** Chart cascade auto-falls-back to Pyth when `usePercolatorCandles` returns empty
