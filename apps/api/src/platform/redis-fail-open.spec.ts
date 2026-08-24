import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Redis outage must not take request paths down with it.
 *
 * boot-and-config-01 / reliability-02 were fixed once, verified, and then
 * REFUTED: the middleware, the tenant resolver and the plan resolver had all
 * been made resilient, but five other services still called `redis.client`
 * bare. With Redis unreachable, `GET /t/:slug/billing` (fetched by the tenant
 * home page), the announcements banner, the ISBN lookup behind barcode
 * scanning, and both token-issuing endpoints returned HTTP 500 with an opaque
 * support code.
 *
 * The rule is not "catch everything". It is:
 *
 *   • a CACHE that cannot be read is a MISS — read through to the source, which
 *     is still reachable, and do not fail the request;
 *   • a STORE that cannot be written must FAIL, loudly and by name — Redis is
 *     where a password-reset token actually lives, so a swallowed write means a
 *     link that can never be redeemed, which is worse than an error.
 *
 * These pin the first half per service. The second half is pinned by the shape
 * of the guard (a `ping()` before the account lookup, so a 503 cannot become an
 * account-enumeration oracle) and was verified end to end by killing Redis
 * under a running API — see the remediation notes.
 */
const DEAD = () =>
  Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));

const { platformSettingFindUnique } = vi.hoisted(() => ({
  platformSettingFindUnique: vi.fn(),
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: { platformSetting: { findUnique: platformSettingFindUnique } },
}));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ billingEnabled: false }) }));

import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';

function deadRedis() {
  return {
    client: { get: vi.fn(DEAD), set: vi.fn(DEAD), del: vi.fn(DEAD) },
    ping: vi.fn().mockResolvedValue(false),
  } as never;
}

describe('PlatformSettingsService.billingEnabled with Redis down', () => {
  beforeEach(() => {
    platformSettingFindUnique.mockReset();
  });

  it('reads through to the control plane instead of throwing', async () => {
    platformSettingFindUnique.mockResolvedValue({ value: 'true' });
    const svc = new PlatformSettingsService(deadRedis());

    // The tenant home page and the whole billing screen depend on this call.
    await expect(svc.billingEnabled()).resolves.toBe(true);
    expect(platformSettingFindUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to the env default when there is no row either', async () => {
    platformSettingFindUnique.mockResolvedValue(null);
    const svc = new PlatformSettingsService(deadRedis());
    await expect(svc.billingEnabled()).resolves.toBe(false);
  });

  it('does not turn the outage into one control-plane read per request', async () => {
    // The memo exists so a Redis outage costs a DB read per TTL, not per
    // request — otherwise the fail-open converts a cache outage into a
    // control-plane load spike, which is its own incident.
    platformSettingFindUnique.mockResolvedValue({ value: 'true' });
    const svc = new PlatformSettingsService(deadRedis());

    await svc.billingEnabled();
    await svc.billingEnabled();
    await svc.billingEnabled();

    expect(platformSettingFindUnique).toHaveBeenCalledTimes(1);
  });

  it('still reports the right answer after the memo is populated', async () => {
    platformSettingFindUnique.mockResolvedValue({ value: 'false' });
    const svc = new PlatformSettingsService(deadRedis());
    await expect(svc.billingEnabled()).resolves.toBe(false);
    await expect(svc.billingEnabled()).resolves.toBe(false);
  });
});
