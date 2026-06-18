import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { LiquidationService } from "../src/services/liquidation.js";

function pubkey(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

function makeHarness(): {
  service: LiquidationService & {
    gatedLiquidate: (
      market: unknown,
      candidate: {
        slabAddress: string;
        accountIdx: number;
        owner: string;
        v17PortfolioPubkey?: PublicKey;
        scanPriceE6: bigint;
      },
    ) => Promise<string | null>;
    _cycleSeenPositions: Set<string>;
    _cycleOwnerCounts: Map<string, number>;
    liquidate: ReturnType<typeof vi.fn>;
  };
} {
  const service = Object.create(LiquidationService.prototype);
  service._cycleSeenPositions = new Set<string>();
  service._cycleOwnerCounts = new Map<string, number>();
  service.liquidate = vi.fn(async () => `sig-${service.liquidate.mock.calls.length}`);
  return { service };
}

describe("PoC: v17 liquidation dedup must key by portfolio pubkey", () => {
  it("does not suppress a second v17 portfolio with the same single-asset accountIdx", async () => {
    const { service } = makeHarness();
    const slabAddress = pubkey(1).toBase58();

    const first = await service.gatedLiquidate({} as never, {
      slabAddress,
      accountIdx: 0,
      owner: pubkey(2).toBase58(),
      v17PortfolioPubkey: pubkey(10),
      scanPriceE6: 100_000_000n,
    });

    const second = await service.gatedLiquidate({} as never, {
      slabAddress,
      accountIdx: 0,
      owner: pubkey(3).toBase58(),
      v17PortfolioPubkey: pubkey(11),
      scanPriceE6: 100_000_000n,
    });

    expect(first).toBe("sig-1");
    expect(second).toBe("sig-2");
    expect(service.liquidate).toHaveBeenCalledTimes(2);
  });

  it("still dedups the same legacy slab slot within one cycle", async () => {
    const { service } = makeHarness();
    const slabAddress = pubkey(4).toBase58();
    const owner = pubkey(5).toBase58();

    const first = await service.gatedLiquidate({} as never, {
      slabAddress,
      accountIdx: 42,
      owner,
      scanPriceE6: 100_000_000n,
    });

    const second = await service.gatedLiquidate({} as never, {
      slabAddress,
      accountIdx: 42,
      owner,
      scanPriceE6: 100_000_000n,
    });

    expect(first).toBe("sig-1");
    expect(second).toBeNull();
    expect(service.liquidate).toHaveBeenCalledTimes(1);
  });
});
