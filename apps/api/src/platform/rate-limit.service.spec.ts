import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitService } from './rate-limit.service.js';
import type { RedisService } from './redis.service.js';

/**
 * Minimal in-memory stand-in for the single counter under test. INCR + the
 * first-hit PEXPIRE are now done atomically inside a Lua script
 * (`client.eval`), so the fake models the post-INCR count `eval` returns and
 * tracks how often the TTL was armed (AUTH-04).
 */
function fakeRedis(initial = 0) {
  let value = initial;
  let armed = 0;
  const ttl = vi.fn(async () => 42);
  // The script INCRs then PEXPIREs on the first hit / when TTL is missing.
  const evalFn = vi.fn(async () => {
    value++;
    if (value === 1) armed++;
    return value;
  });
  return {
    client: { eval: evalFn, ttl },
    armedCount: () => armed,
  } as unknown as RedisService & {
    client: { eval: typeof evalFn; ttl: typeof ttl };
    armedCount: () => number;
  };
}

describe('RateLimitService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let svc: RateLimitService;

  beforeEach(() => {
    redis = fakeRedis();
    svc = new RateLimitService(redis);
  });

  const origNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    delete process.env.RATE_LIMIT_DISABLED;
    process.env.NODE_ENV = origNodeEnv;
  });

  it('arms the TTL atomically only on the first hit of a window', async () => {
    await svc.hit('k', 3, 60);
    expect(redis.armedCount()).toBe(1);
    await svc.hit('k', 3, 60);
    expect(redis.armedCount()).toBe(1);
  });

  it('passes the window (in ms) to PEXPIRE via the Lua ARGV', async () => {
    await svc.hit('k', 3, 60);
    // eval(script, numKeys, key, windowMs)
    expect(redis.client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'rl:k', '60000');
  });

  it('allows up to the limit and blocks beyond it', async () => {
    expect((await svc.hit('k', 2, 60)).allowed).toBe(true); // count 1
    expect((await svc.hit('k', 2, 60)).allowed).toBe(true); // count 2
    const third = await svc.hit('k', 2, 60); // count 3
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBe(42);
  });

  it('fails OPEN for non-signup buckets when Redis errors', async () => {
    const broken = {
      client: {
        eval: vi.fn(async () => {
          throw new Error('redis down');
        }),
        ttl: vi.fn(),
      },
    } as unknown as RedisService;
    const s = new RateLimitService(broken);
    const r = await s.hit('login:ip:1.2.3.4', 1, 60);
    expect(r.allowed).toBe(true);
  });

  it('fails CLOSED for signup buckets when Redis errors (REM-2)', async () => {
    const broken = {
      client: {
        eval: vi.fn(async () => {
          throw new Error('redis down');
        }),
        ttl: vi.fn(),
      },
    } as unknown as RedisService;
    const s = new RateLimitService(broken);
    expect((await s.hit('signup:global', 60, 600)).allowed).toBe(false);
    expect((await s.hit('signup:ip:1.2.3.4', 5, 600)).allowed).toBe(false);
  });

  it('honours RATE_LIMIT_DISABLED outside production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.RATE_LIMIT_DISABLED = 'true';
    const r = await svc.hit('k', 1, 60);
    expect(r.allowed).toBe(true);
    expect(redis.client.eval).not.toHaveBeenCalled();
  });
});
