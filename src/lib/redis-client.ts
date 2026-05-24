import { Redis } from "@upstash/redis";

export interface RedisLike {
  set(key: string, value: string, opts: { ex: number; nx?: true } | { ex: number; xx?: true }): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

let _client: RedisLike | null | undefined = undefined;

export function getRedisClient(): RedisLike | null {
  if (_client !== undefined) return _client;

  const url = process.env.KEEPER_REDIS_URL;
  if (!url) {
    _client = null;
    return null;
  }

  const token = process.env.KEEPER_REDIS_TOKEN;

  let redis: Redis;
  if (token) {
    redis = new Redis({ url, token });
  } else {
    redis = new Redis({ url, token: "" });
  }

  _client = redis as unknown as RedisLike;
  return _client;
}

export function resetRedisClientForTest(): void {
  _client = undefined;
}
