import { randomUUID } from 'node:crypto';
import redis from './redis';

/** Redis-backed, renewable lease for long-running mutations that must not overlap across API instances. */
export async function acquireRedisLease(key: string, ttlMs: number): Promise<null | (() => Promise<void>)> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;
  const renewal = setInterval(() => {
    void redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1, key, token, ttlMs,
    ).catch(() => undefined);
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  renewal.unref();
  return async () => {
    clearInterval(renewal);
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
  };
}
