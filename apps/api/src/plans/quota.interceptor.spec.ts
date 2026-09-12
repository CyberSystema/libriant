import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the counter registry + the controlDb the interceptor receives —
// the interceptor calls `countUsage(feature, {...})` which dispatches
// per feature key.
const { countUsage } = vi.hoisted(() => ({ countUsage: vi.fn() }));
vi.mock('./quota-counters.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./quota-counters.js');
  return {
    ...actual,
    countUsage,
    QUOTA_COUNTERS: { max_books: actual.QUOTA_COUNTERS as never } as Record<string, unknown>,
  };
});
vi.mock('@libriant/db-control', () => ({
  controlDb: {},
}));

import { QuotaInterceptor } from './quota.interceptor.js';
import { UNLIMITED_INT } from './effective-plan.service.js';

function makeCtx(req: object): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class Fake {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next = { handle: () => of('handler-result') } as never;

function makeInterceptor(featureValue: { type: 'int'; value: number } | undefined) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('max_books');
  const effective = {
    getEffectivePlan: vi.fn().mockResolvedValue({
      tenantId: 'tnt-1',
      plan: { slug: 'starter' },
      features: featureValue ? { max_books: featureValue } : {},
    }),
  } as unknown as import('./effective-plan.service.js').EffectivePlanService;
  const tenantPrisma = {
    getClient: vi.fn().mockReturnValue({}),
    // 2.0 phase 20g: `max_books` and `max_members` count the 2.0 tables now, so
    // the interceptor hands the counter both clients.
    getClientV2: vi.fn().mockReturnValue({}),
  } as unknown as import('../tenancy/tenant-prisma.service.js').TenantPrismaService;
  return new QuotaInterceptor(reflector, effective, tenantPrisma);
}

describe('QuotaInterceptor.intercept', () => {
  beforeEach(() => {
    countUsage.mockReset();
  });

  it('passes through when no @RequiresQuota metadata is present', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const interceptor = new QuotaInterceptor(reflector, {} as never, {} as never);
    const ctx = makeCtx({});

    const result = await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(result).toBe('handler-result');
  });

  it('passes through under impersonation', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: 0 });
    const ctx = makeCtx({
      tenant: { id: 'tnt-1' },
      impersonation: { adminId: 'a', tenantId: 'tnt-1', sessionId: 's' },
    });

    const result = await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(result).toBe('handler-result');
    expect(countUsage).not.toHaveBeenCalled();
  });

  it('throws 400 when no tenant is on the request', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: 500 });
    const ctx = makeCtx({});

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('throws 500 when the feature does not resolve to an integer', async () => {
    const interceptor = makeInterceptor(undefined);
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  });

  it('allows when used < limit', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: 500 });
    countUsage.mockResolvedValue(42);
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    const result = await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(result).toBe('handler-result');
  });

  it('throws 402 with structured payload at the limit', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: 500 });
    countUsage.mockResolvedValue(500);
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected intercept to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const e = err as HttpException;
      expect(e.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(e.getResponse()).toMatchObject({
        statusCode: 402,
        feature: 'max_books',
        limit: 500,
        used: 500,
        currentPlan: 'starter',
      });
    }
  });

  it('throws 402 when usage exceeds the limit (limit lowered after creation)', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: 100 });
    countUsage.mockResolvedValue(150);
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });

  // performance-05. The counters are not cheap — `max_books` is
  // `book.count({ where: { archivedAt: null } })`, a full scan of the
  // catalogue (13,333 shared buffers on the audit's 400,000-title fixture).
  // With subscriptions off — the configuration the product SHIPS in —
  // `unlimitedPlan()` rewrites every int feature to UNLIMITED_INT, so every
  // quota'd create used to pay that scan to compare the answer against
  // Number.MAX_SAFE_INTEGER. `countUsage` must not be reached at all.
  it('does not count anything when the limit is the unlimited sentinel', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: UNLIMITED_INT });
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    const result = await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(result).toBe('handler-result');
    expect(countUsage).not.toHaveBeenCalled();
  });

  // `isUnlimitedInt` is `>=`, not `===`, so a value at or above the sentinel
  // reads as "no ceiling" instead of overflowing whatever it is compared or
  // multiplied into next (data-integrity-01). Prove the interceptor inherits
  // that, rather than only matching the exact sentinel.
  it('treats a value above the sentinel as unlimited too', async () => {
    const interceptor = makeInterceptor({ type: 'int', value: UNLIMITED_INT + 1000 });
    const ctx = makeCtx({ tenant: { id: 'tnt-1' } });

    await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(countUsage).not.toHaveBeenCalled();
  });

  // The short-circuit must not swallow the bug guard: an unregistered counter
  // is still a 500, whether or not the ceiling is finite. Otherwise a typo'd
  // feature key would silently become "no quota" in the shipped posture.
  it('still 500s on an unregistered counter even when the limit is unlimited', async () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('max_widgets');
    const interceptor = new QuotaInterceptor(reflector, {} as never, {} as never);

    await expect(
      interceptor.intercept(makeCtx({ tenant: { id: 'tnt-1' } }), next),
    ).rejects.toMatchObject({ status: HttpStatus.INTERNAL_SERVER_ERROR });
  });
});
