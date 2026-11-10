/**
 * Stablecoin-underlying refusal (Council r5 #2). Dollar stablecoins are not perp underlyings on v2.2; the launch app refuses them at
 * every create / register route. This is the keeper-side backstop for the two places a market's token identity (`mainnetCA`) enters
 * the keeper: POST /register (CrankService.registerMarket) and Supabase-driven discovery (CrankService.discover). A script-built market
 * (InitMarket is permissionless) registered before the app gate existed, or one that reached the keeper by another route, is then
 * never tracked, priced or cranked by this keeper.
 *
 * OPT-IN: `REFUSE_STABLECOIN_UNDERLYINGS=1` (or `true`). Off by default because this keeper also serves non-v2.2 devnet deployments
 * whose existing markets must keep their behaviour; set it only on the v2.2 keeper. It is NOT an on-chain rule.
 *
 * Mint list: Solana mainnet, 32 verified addresses (each checked on-chain and against an independent source: issuer docs, CoinGecko,
 * Jupiter, solana-labs/token-list). Same list as percolator-launch app/lib/v22/stablecoin-mints.ts (exported to
 * stablecoin-mints.json). USD only: EURC and other non-USD fiat stables are intentionally not here. Limits: this keeper only sees
 * `mainnetCA`; a pool-only market (no mainnetCA) carries no token identity here, so that case is closed at the app's server routes,
 * which read the pool's mints from mainnet.
 */
export const STABLECOIN_MINTS: ReadonlySet<string> = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", // USDS
  "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", // FDUSD
  "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT", // USDe
  "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", // sUSDe
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9", // AUSD
  "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", // USDY
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX", // USDH
  "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT", // UXD
  "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E", // hyUSD
  "GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw", // frxUSD
  "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o", // DAI
  "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM", // USDCet
  "Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1", // USDTet
  "E2VmbootbVCBkMNNxKQgCLMS1X3NoGMaYAsufaAsf7M", // USDCpo
  "5goWRao6a3yNC4d6UjMdQxonkCMvKBwdpubU3qhfcdf1", // USDTpo
  "FCqfQSujuPxy6V42UvafBhsysWtEq1vhjfMN1PUbgaxA", // USDCbs
  "8qJSyQprMC57TWKaYEmetUR3UUiTP2M3hXdcvFhkZdmv", // USDTbs
  "9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i", // UST
  "DdFPRnccQqLD4zCHrBqdY95D6hvw6PLWp9DEXj1fLCL9", // aeUSDC
  "eqKJTf1Do4MDPyKisMYqVaUFpkEFAs3riGF3ceDH2Ca", // apUSDC
  "8XSsNvaKU9FDhYWAv7Yc7qSNwuJSzVrXBNEk7AFiWF69", // abUSDC
  "8Yv9Jz4z7BUHP68dz8E8m3tMe6NKgpMUKn8KVqrPA6Fr", // aaUSDC
  "DHpoYejUDqzByb6HAdaLWF7KZvwUv2vWYDY9cTENNZui", // acUSDC
  "Bn113WT6rbdgwrm12UJtnmNqGqZjY4it2WoUQuQopFVn", // aeUSDT
  "DNhZkUaxHXYvpxZ7LNnHtss8sQgdAfd1ZYS1fB7LKWUZ", // apUSDT
  "E77cpQ4VncGmcAXX16LHFFzNBEBb2U7Ar7LBmZNfCgwL", // abUSDT
  "FwEHs3kJEdMa2qZHv7SgzCiFXUQPEycEXksfBkwmS8gj", // aaUSDT
]);

/** True when the refusal is switched on for this deployment. Read per call so tests (and an operator restart-free env change in tests) see it. */
export function isStablecoinRefusalEnabled(): boolean {
  const v = (process.env.REFUSE_STABLECOIN_UNDERLYINGS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** True when the refusal is on AND `mainnetCA` (trimmed) is a listed stablecoin mint. */
export function isRefusedStablecoinUnderlying(mainnetCA: string | null | undefined): boolean {
  if (!isStablecoinRefusalEnabled() || typeof mainnetCA !== "string") return false;
  return STABLECOIN_MINTS.has(mainnetCA.trim());
}
