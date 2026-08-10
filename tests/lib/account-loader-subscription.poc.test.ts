import { describe, it, expect } from "vitest";
import { buildAccountsSubscription } from "../../src/lib/account-loader.js";

/**
 * PoC — the LaserStream accounts subscription must not AND-away the program
 * stream when KEEPER_LASERSTREAM_ADDITIONAL_ACCOUNTS is set.
 *
 * Yellowstone AND-combines the non-empty fields WITHIN one filter entry and
 * OR-combines separate named entries. The old request put both `account:[extras]`
 * and `owner:[programId]` in ONE entry, so a program-owned slab (not in the extras
 * list) and an extra dex-pool account (not program-owned) each matched NOTHING —
 * silently killing the entire account stream. Modeled below: against the old
 * single-entry shape both assertions fail; with the separate-entry fix both pass.
 */

function entryMatches(
  entry: { account: string[]; owner: string[] },
  acct: { pubkey: string; owner: string },
): boolean {
  const byAccount = entry.account.length === 0 || entry.account.includes(acct.pubkey);
  const byOwner = entry.owner.length === 0 || entry.owner.includes(acct.owner);
  return byAccount && byOwner; // AND within an entry
}
function requestMatches(
  filter: Record<string, { account: string[]; owner: string[] }>,
  acct: { pubkey: string; owner: string },
): boolean {
  return Object.values(filter).some((e) => entryMatches(e, acct)); // OR across entries
}

const PROGRAM = "Prog1111111111111111111111111111111111111111";
const DEX_PROGRAM = "Dex11111111111111111111111111111111111111111";
const SLAB = "Slab1111111111111111111111111111111111111111"; // program-owned
const DEX_POOL = "Pool1111111111111111111111111111111111111111"; // owned by DEX_PROGRAM

describe("PoC: LaserStream accounts subscription", () => {
  it("streams program-owned accounts by owner when no additionalAccounts", () => {
    const f = buildAccountsSubscription(PROGRAM, []);
    expect(requestMatches(f, { pubkey: SLAB, owner: PROGRAM })).toBe(true);
  });

  it("with additionalAccounts set, BOTH program slabs and the extra accounts still stream", () => {
    const f = buildAccountsSubscription(PROGRAM, [DEX_POOL]);
    // Program-owned slab (not in the extras list) must still stream — pre-fix it
    // was AND'd against account:[DEX_POOL] and matched nothing.
    expect(requestMatches(f, { pubkey: SLAB, owner: PROGRAM })).toBe(true);
    // The extra dex-pool account (owned by another program) must also stream.
    expect(requestMatches(f, { pubkey: DEX_POOL, owner: DEX_PROGRAM })).toBe(true);
  });
});
