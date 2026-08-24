import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BOOT-01 / reliability-02: an unreachable Redis used to take the whole API
 * with it. `SystemModeMiddleware` runs on every request — including /healthz,
 * /readyz and the /admin/system-mode recovery lever — and its cache read was a
 * bare `redis.client.get()`. With `enableOfflineQueue: false` that rejects the
 * moment the socket is down, the rejection escaped the middleware, and the
 * global filter turned a routine `docker restart redis` into a 500 on every
 * path, leaving the operator no in-band way to recover.
 *
 * These specs pin the degraded behaviour: Redis errors are cache misses, not
 * request failures.
 */
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { systemModeEvent: { findFirst } },
}));

import type { Redis } from 'ioredis';
import { SystemModeService } from './system-mode.service.js';

const REDIS_DOWN = () => {
  throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
};

/** A client that fails every command, the way ioredis does with Redis gone. */
function deadRedis() {
  return {
    client: {
      get: vi.fn(REDIS_DOWN),
      set: vi.fn(REDIS_DOWN),
      del: vi.fn(REDIS_DOWN),
    } as unknown as Redis,
  };
}

function liveRedis() {
  const store = new Map<string, string>();
  return {
    client: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        let n = 0;
        for (const k of keys) if (store.delete(k)) n++;
        return n;
      }),
    } as unknown as Redis,
    store,
  };
}

const maintenanceRow = {
  id: 'evt-1',
  mode: 'maintenance',
  messageMarkdown: 'Back in 10.',
  startsAt: new Date('2026-08-24T09:00:00Z'),
  endsAt: null,
  allowAdminBypass: true,
};

describe('SystemModeService with Redis unavailable', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
  });

  it('resolves from the control DB instead of throwing when the cache read fails', async () => {
    const redis = deadRedis();
    const service = new SystemModeService(redis as never);

    const resolved = await service.resolveGlobal();

    expect(resolved.mode).toBe('normal');
    expect(redis.client.get).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('still reports an active maintenance window while Redis is down', async () => {
    findFirst.mockResolvedValue(maintenanceRow);
    const service = new SystemModeService(deadRedis() as never);

    const resolved = await service.resolveGlobal();

    expect(resolved.mode).toBe('maintenance');
    expect(resolved.source).toBe('global');
  });

  it('does not turn the outage into a control-DB query per request', async () => {
    // The write Redis refused is held in-process for a few seconds, so a dead
    // Redis costs one findFirst per key — not one per inbound request.
    const service = new SystemModeService(deadRedis() as never);

    await service.resolveGlobal();
    await service.resolveGlobal();
    await service.resolveGlobal();

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('does not reject the admin write that opens or ends a mode window', async () => {
    // `bust()` runs after the event row is already committed. Rejecting there
    // would 500 the operator's recovery lever for no gain: the 30 s TTL exists
    // precisely so a dropped invalidation self-heals.
    const service = new SystemModeService(deadRedis() as never);

    await expect(service.bust({ global: true })).resolves.toBeUndefined();
  });

  it('resolveGlobalSafe falls back to normal when the control DB is down too', async () => {
    findFirst.mockRejectedValue(new Error("Can't reach database server"));
    const service = new SystemModeService(deadRedis() as never);

    const resolved = await service.resolveGlobalSafe();

    expect(resolved.mode).toBe('normal');
    expect(resolved.source).toBe('default');
  });

  it('resolveGlobalSafe keeps serving the last known window when both deps die', async () => {
    // Flipping the takeover page off mid-maintenance because the dependencies
    // blinked is worse than serving a slightly stale mode.
    findFirst.mockResolvedValue(maintenanceRow);
    const service = new SystemModeService(deadRedis() as never);
    expect((await service.resolveGlobal()).mode).toBe('maintenance');

    // Past the in-process memo, with the DB now unreachable as well.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    findFirst.mockRejectedValue(new Error('connection refused'));
    try {
      expect((await service.resolveGlobalSafe()).mode).toBe('maintenance');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SystemModeService last-known fallbacks', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
  });

  it('remembers a mode it only ever saw as a cache HIT', async () => {
    // `lastKnownGlobal` used to be assigned only after a DB read, and
    // resolveGlobal returns early on a hit. In a multi-process deployment one
    // process keeps the 30 s key warm and the others never miss, so their
    // fallback was never populated at all and their degraded answer was
    // whatever they happened to resolve at boot — or 'normal'.
    const store = new Map<string, string>();
    store.set(
      'system_mode:global',
      JSON.stringify({ ...maintenanceRow, source: 'global', eventId: 'evt-1' }),
    );
    let redisDown = false;
    const client = {
      get: vi.fn(async (k: string) => {
        if (redisDown) REDIS_DOWN();
        return store.get(k) ?? null;
      }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    } as unknown as Redis;
    const service = new SystemModeService({ client } as never);

    expect((await service.resolveGlobal()).mode).toBe('maintenance');
    expect(findFirst).not.toHaveBeenCalled(); // pure cache hit — never touched the DB

    redisDown = true;
    findFirst.mockRejectedValue(new Error('connection refused'));

    expect((await service.resolveGlobalSafe()).mode).toBe('maintenance');
  });

  it('keeps a TENANT window open when the control DB dies mid-maintenance', async () => {
    // The endpoint the web app polls used to be
    // `resolveEffective({tenantId}).catch(() => resolveGlobalSafe())`: a
    // control-DB error on the tenant leg threw the tenant dimension away and
    // answered with the GLOBAL mode, so a library in maintenance reported
    // 'normal' and the takeover page never rendered.
    findFirst.mockImplementation(async (args: { where: { scope: string } }) =>
      args.where.scope === 'tenant' ? maintenanceRow : null,
    );
    const redis = liveRedis();
    const service = new SystemModeService(redis as never);
    expect((await service.resolveEffective({ tenantId: 't-1' })).mode).toBe('maintenance');

    // 30 s later the cached keys are gone and the control DB is unreachable.
    redis.store.clear();
    findFirst.mockRejectedValue(new Error("Can't reach database server"));

    const resolved = await service.resolveEffectiveSafe({ tenantId: 't-1' });

    expect(resolved.mode).toBe('maintenance');
    expect(resolved.source).toBe('tenant');
  });

  it('never throws, even for a tenant it has never resolved', async () => {
    // No evidence either way. We report the global answer rather than
    // fabricating a window — inventing maintenance for a library we know
    // nothing about would take a healthy one offline on a transient blip.
    findFirst.mockRejectedValue(new Error('connection refused'));
    const service = new SystemModeService(deadRedis() as never);

    const resolved = await service.resolveEffectiveSafe({ tenantId: 'never-seen' });

    expect(resolved.mode).toBe('normal');
    expect(await service.resolveTenantSafe('never-seen')).toBeNull();
  });
});

describe('SystemModeService with Redis healthy', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
  });

  it('caches the resolution in Redis and serves the next read from it', async () => {
    const redis = liveRedis();
    const service = new SystemModeService(redis as never);

    await service.resolveGlobal();
    await service.resolveGlobal();

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(redis.store.has('system_mode:global')).toBe(true);
  });

  it('busts the cached key so an admin write takes effect immediately', async () => {
    const redis = liveRedis();
    const service = new SystemModeService(redis as never);
    await service.resolveGlobal();

    await service.bust({ global: true });

    expect(redis.store.has('system_mode:global')).toBe(false);
  });
});
