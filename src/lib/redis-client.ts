import { Redis } from "@upstash/redis";

export interface RedisLike {
  set(key: string, value: string, opts: { ex: number; nx?: true } | { ex: number; xx?: true }): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  // C2 (CRITICAL): atomic compare-and-pexpire for leader-lease renewal.
  // SET XX is value-blind and allows split-brain on partition-heal; the renew
  // path uses Lua EVAL to verify the stored value still matches our identity
  // before extending the TTL. @upstash/redis exposes `eval(script, keys, args)`
  // over REST natively.
  eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
}

let _client: RedisLike | null | undefined = undefined;

export function getRedisClient(): RedisLike | null {
  if (_client !== undefined) return _client;

  const url = process.env.KEEPER_REDIS_URL;
  if (!url) {
    _client = null;
    return null;
  }

  // A.4 (HIGH): legacy code fell back to `token: ""` when KEEPER_REDIS_TOKEN
  // was unset, which let the keeper connect to Upstash with no auth — an
  // access-control gap. Refuse to construct the client without a real token.
  const token = process.env.KEEPER_REDIS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "KEEPER_REDIS_URL is set but KEEPER_REDIS_TOKEN is missing or empty. " +
        "Set KEEPER_REDIS_TOKEN to the Upstash REST token, or unset KEEPER_REDIS_URL to disable HA.",
    );
  }

  const redis = new Redis({ url, token });
  _client = redis as unknown as RedisLike;
  return _client;
}

export function resetRedisClientForTest(): void {
  _client = undefined;
}
