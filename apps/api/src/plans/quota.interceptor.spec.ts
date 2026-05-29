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
});
