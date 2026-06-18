import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { getV17OracleTailFeeds } from "../src/lib/v17-oracle-tail.js";

function pubkey(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

describe("PoC: v17 oracle tail construction", () => {
  it("returns every configured oracle leg for multi-leg hybrid markets", () => {
    const fallback = pubkey(1);
    const leg0 = pubkey(2);
    const leg1 = pubkey(3);

    const feeds = getV17OracleTailFeeds(
      {
        _rawV17Config: {
          oracleMode: 1,
          oracleLegCount: 2,
          oracleLegFeeds: [leg0, leg1],
        },
      },
      fallback,
    );

    expect(feeds.map((feed) => feed.toBase58())).toEqual([
      leg0.toBase58(),
      leg1.toBase58(),
    ]);
  });

  it("keeps the single fallback oracle for non-hybrid markets", () => {
    const fallback = pubkey(4);
    const feeds = getV17OracleTailFeeds(
      {
        _rawV17Config: {
          oracleMode: 2,
          oracleLegCount: 2,
          oracleLegFeeds: [pubkey(5), pubkey(6)],
        },
      },
      fallback,
    );

    expect(feeds.map((feed) => feed.toBase58())).toEqual([fallback.toBase58()]);
  });
});
