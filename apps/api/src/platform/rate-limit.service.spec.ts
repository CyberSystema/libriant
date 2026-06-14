import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitService } from './rate-limit.service.js';
import type { RedisService } from './redis.service.js';

/** Minimal in-memory stand-in for the single counter under test. */
function fakeRedis(initial = 0) {
  let value = initial;
  const expire = vi.fn(async () => 1);
  const ttl = vi.fn(async () => 42);
  const incr = vi.fn(async () => ++value);
  return { client: { incr, expire, ttl } } as unknown as RedisService & {
    client: { incr: typeof incr; expire: typeof expire; ttl: typeof ttl };
  };
}

describe('RateLimitService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let svc: RateLimitService;

  beforeEach(() => {
    redis = fakeRedis();
    svc = new RateLimitService(redis);
  });

  it('arms the TTL only on the first hit of a window', async () => {
    await svc.hit('k', 3, 60);
    expect(redis.client.expire).toHaveBeenCalledTimes(1);
    await svc.hit('k', 3, 60);
    expect(redis.client.expire).toHaveBeenCalledTimes(1);
  });

  it('allows up to the limit and blocks beyond it', async () => {
    expect((await svc.hit('k', 2, 60)).allowed).toBe(true); // count 1
    expect((await svc.hit('k', 2, 60)).allowed).toBe(true); // count 2
    const third = await svc.hit('k', 2, 60); // count 3
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBe(42);
  });

  it('fails OPEN when Redis errors (availability over strict limiting)', async () => {
    const broken = {
      client: {
        incr: vi.fn(async () => {
          throw new Error('redis down');
        }),
        expire: vi.fn(),
        ttl: vi.fn(),
      },
    } as unknown as RedisService;
    const s = new RateLimitService(broken);
    const r = await s.hit('k', 1, 60);
    expect(r.allowed).toBe(true);
  });
});
