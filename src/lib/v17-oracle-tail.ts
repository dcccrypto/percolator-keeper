import { PublicKey, type Connection } from "@solana/web3.js";
import { resolveExternalOracleAccount } from "./oracle-account.js";

export type V17OracleTailMarket = {
  _rawV17Config?: {
    oracleMode: number;
    oracleLegCount: number;
    oracleLegFeeds: PublicKey[];
  };
};

export function getV17OracleTailFeeds(
  market: V17OracleTailMarket,
  fallbackOracle: PublicKey,
): PublicKey[] {
  const rawCfg = market._rawV17Config;
  if (rawCfg && rawCfg.oracleMode === 1 && rawCfg.oracleLegCount > 1) {
    const feeds: PublicKey[] = [];
    for (let i = 0; i < rawCfg.oracleLegCount; i++) {
      feeds.push(rawCfg.oracleLegFeeds[i] ?? fallbackOracle);
    }
    return feeds;
  }
  return [fallbackOracle];
}

export async function resolveV17OracleTail(
  market: V17OracleTailMarket,
  fallbackOracle: PublicKey,
  connection: Connection,
): Promise<PublicKey[]> {
  const feeds = getV17OracleTailFeeds(market, fallbackOracle);
  const fallbackKey = fallbackOracle.toBase58();
  return Promise.all(
    feeds.map((feed) => (
      // Compare by base58 (not PublicKey.equals) so the single-oracle fallback
      // path resolves to the fallback without dereferencing .equals — keeps the
      // hot path allocation-free AND matches how keys are compared elsewhere in
      // the keeper (toBase58), which the test fixtures rely on.
      feed.toBase58() === fallbackKey
        ? fallbackOracle
        : resolveExternalOracleAccount(feed, connection)
    )),
  );
}
