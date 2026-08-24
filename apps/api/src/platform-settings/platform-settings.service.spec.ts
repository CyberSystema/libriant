import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * billing-02, guard 3. The master subscriptions switch is a `platform_settings`
 * row an owner flips from the admin panel — no redeploy, no .env change — so
 * neither boot-time guard is on that path. A5-03 only logged a warning here,
 * which is exactly how "enforcement on" and "no driver that can take a
 * payment" were able to be true at the same time.
 *
 * Wave 2 also reconciled this guard's NODE_ENV exemption with the two boot
 * guards': it exempted `development` only, they exempt `development` and
 * `test`. The asymmetry made the service's own path untestable (see
 * test/integration/storage-quota.spec.ts, which arms enforcement by writing the
 * DB row by hand). Aligned on the wider pair; the trade is documented at the
 * guard.
 */
const { upsert, del } = vi.hoisted(() => ({
  upsert: vi.fn().mockResolvedValue({}),
  del: vi.fn().mockResolvedValue(1),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { platformSetting: { upsert } },
}));

import { PlatformSettingsService } from './platform-settings.service.js';

function makeService() {
  return new PlatformSettingsService({ client: { del } } as never);
}

const SAVED = { ...process.env };

function setEnv(vars: { NODE_ENV?: string; STRIPE_DRIVER?: string }) {
  for (const key of ['NODE_ENV', 'STRIPE_DRIVER', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    delete process.env[key];
  }
  Object.assign(process.env, vars);
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'none' });
});

afterEach(() => {
  for (const key of ['NODE_ENV', 'STRIPE_DRIVER', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    delete process.env[key];
    if (SAVED[key] !== undefined) process.env[key] = SAVED[key];
  }
});

describe('PlatformSettingsService.setBillingEnabled', () => {
  it.each(['production', 'staging'])(
    'refuses to enable subscriptions with no usable driver under NODE_ENV=%s',
    async (nodeEnv) => {
      setEnv({ NODE_ENV: nodeEnv, STRIPE_DRIVER: 'none' });
      await expect(makeService().setBillingEnabled(true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('refuses on a legacy host that still says STRIPE_DRIVER=fake', async () => {
    // The resolver downgrades that to `disabled`, so there is nothing that can
    // take a payment — arming enforcement would gate every library forever.
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'fake' });
    await expect(makeService().setBillingEnabled(true)).rejects.toThrow(/disabled/);
  });

  it('does not persist the row when it refuses — the switch must not half-flip', async () => {
    await expect(makeService().setBillingEnabled(true)).rejects.toThrow(/STRIPE_DRIVER/);
    expect(upsert).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('always allows DISABLING, whatever the driver — the off switch must never jam', async () => {
    await expect(makeService().setBillingEnabled(false)).resolves.toBe(false);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 'false' } }));
  });

  it('allows enabling once the driver is real', async () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'real' });
    await expect(makeService().setBillingEnabled(true)).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 'true' } }));
  });

  it.each(['development', 'test'])(
    'allows enabling against the stand-in under NODE_ENV=%s, matching the two boot guards',
    async (nodeEnv) => {
      setEnv({ NODE_ENV: nodeEnv, STRIPE_DRIVER: 'fake' });
      await expect(makeService().setBillingEnabled(true)).resolves.toBe(true);
      expect(upsert).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses even on a dev box when the driver is DISABLED rather than the stand-in', async () => {
    // The dev/test exemption exists because the fake can actually run the
    // flows. `none` cannot run anything, so enforcement would gate the
    // developer's own tenants behind a 503.
    setEnv({ NODE_ENV: 'development', STRIPE_DRIVER: 'none' });
    await expect(makeService().setBillingEnabled(true)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PlatformSettingsService.stripeReady', () => {
  it('is false for the disabled posture (nothing can transact)', () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'none' });
    expect(makeService().stripeReady()).toBe(false);
  });

  it('is false for the stand-in', () => {
    setEnv({ NODE_ENV: 'development', STRIPE_DRIVER: 'fake' });
    expect(makeService().stripeReady()).toBe(false);
  });

  it('is true only for the real driver', () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'real' });
    expect(makeService().stripeReady()).toBe(true);
  });
});
