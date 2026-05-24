import { LRUCache } from "lru-cache";

const DEFAULT_MAX_SIZE = 16_384;
const DEFAULT_TTL_SLOTS = 32;

export interface AccountEntry {
  data: Uint8Array;
  owner: string;
  slot: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  ttlSlots: number;
  hits: number;
  misses: number;
  evictions: number;
}

export class AccountCache {
  private readonly cache: LRUCache<string, AccountEntry>;
  private readonly maxSize: number;
  private readonly ttlSlots: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor() {
    this.maxSize =
      parseInt(process.env.KEEPER_ACCOUNT_CACHE_SIZE ?? "", 10) ||
      DEFAULT_MAX_SIZE;
    this.ttlSlots =
      parseInt(process.env.KEEPER_ACCOUNT_CACHE_TTL_SLOTS ?? "", 10) ||
      DEFAULT_TTL_SLOTS;

    this.cache = new LRUCache<string, AccountEntry>({
      max: this.maxSize,
      dispose: () => {
        this.evictions++;
      },
    });
  }

  set(pubkey: string, data: Uint8Array, owner: string, slot: number): void {
    this.cache.set(pubkey, { data, owner, slot });
  }

  /** Returns the cached entry only if its slot age is within the TTL. */
  get(pubkey: string, currentSlot: number): AccountEntry | null {
    const entry = this.cache.get(pubkey);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (currentSlot - entry.slot > this.ttlSlots) {
      this.misses++;
      return null;
    }
    this.hits++;
    return entry;
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  stats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlSlots: this.ttlSlots,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
