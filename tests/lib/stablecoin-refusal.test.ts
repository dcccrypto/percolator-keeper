import { afterEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { STABLECOIN_MINTS, isRefusedStablecoinUnderlying, isStablecoinRefusalEnabled } from "../../src/lib/stablecoin-refusal.js";

const USDS = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
const FDUSD = "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u";
const USDE = "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT";
const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_PORTAL = "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM";
const EURC = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";

afterEach(() => {
  delete process.env.REFUSE_STABLECOIN_UNDERLYINGS;
});

describe("stablecoin refusal (opt-in)", () => {
  it("the list is 32 unique valid mints", () => {
    expect(STABLECOIN_MINTS.size).toBe(32);
    for (const m of STABLECOIN_MINTS) expect(new PublicKey(m).toBase58()).toBe(m);
  });

  it("is off by default: nothing is refused", () => {
    expect(isStablecoinRefusalEnabled()).toBe(false);
    for (const m of [USDS, FDUSD, USDC]) expect(isRefusedStablecoinUnderlying(m)).toBe(false);
  });

  it.each(["1", "true", " TRUE "])("REFUSE_STABLECOIN_UNDERLYINGS=%j refuses the whole class", (v) => {
    process.env.REFUSE_STABLECOIN_UNDERLYINGS = v;
    for (const m of [USDS, FDUSD, USDE, USDG, USDC, USDC_PORTAL, ` ${USDC} `]) expect(isRefusedStablecoinUnderlying(m), m).toBe(true);
  });

  it("does not refuse a normal token, EURC (not USD), or a missing mainnetCA", () => {
    process.env.REFUSE_STABLECOIN_UNDERLYINGS = "1";
    for (const m of [CONTROL, EURC, "", undefined, null]) expect(isRefusedStablecoinUnderlying(m)).toBe(false);
  });

  it.each(["0", "false", ""])("REFUSE_STABLECOIN_UNDERLYINGS=%j keeps it off", (v) => {
    process.env.REFUSE_STABLECOIN_UNDERLYINGS = v;
    expect(isRefusedStablecoinUnderlying(USDS)).toBe(false);
  });
});
