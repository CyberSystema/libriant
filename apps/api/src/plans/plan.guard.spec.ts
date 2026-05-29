import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanGuard } from './plan.guard.js';
import type { EffectivePlanService } from './effective-plan.service.js';

/**
 * Build a `ExecutionContext` that satisfies the bits PlanGuard uses:
 * the handler/class identity (so Reflector can read metadata) and a
 * `switchToHttp().getRequest()` that returns the tenant + impersonation
 * we want to test against.
 */
function makeCtx(handler: object | undefined, req: object): ExecutionContext {
  return {
    getHandler: () => handler ?? (() => undefined),
    getClass: () => class Fake {},
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

function makeEffective(plan: {
  features: Record<string, { type: 'bool'; value: boolean }>;
  plan?: { slug: string };
}) {
  return {
    getEffectivePlan: vi.fn().mockResolvedValue({
      tenantId: 'tnt-1',
      plan: plan.plan ?? null,
      features: plan.features,
    }),
  } as unknown as EffectivePlanService;
}

describe('PlanGuard.canActivate', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  it('passes through when the route has no @RequiresFeature metadata', async () => {
    const guard = new PlanGuard(reflector, makeEffective({ features: {} }));
    const ctx = makeCtx(() => undefined, { tenant: { id: 'tnt-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects with 400 when the route is gated but no tenant is on the request', async () => {
    const handler = () => undefined;
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('reservations_enabled');
    const guard = new PlanGuard(reflector, makeEffective({ features: {} }));
    const ctx = makeCtx(handler, {});

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('passes through under impersonation regardless of plan state', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('reservations_enabled');
    const effective = makeEffective({
      features: { reservations_enabled: { type: 'bool', value: false } },
    });
    const guard = new PlanGuard(reflector, effective);
    const ctx = makeCtx(() => undefined, {
      tenant: { id: 'tnt-1' },
      impersonation: { adminId: 'a', tenantId: 'tnt-1', sessionId: 's' },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // Short-circuit: the plan was never consulted.
    expect(effective.getEffectivePlan).not.toHaveBeenCalled();
  });

  it('allows when the gated feature is enabled', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('reservations_enabled');
    const guard = new PlanGuard(
      reflector,
      makeEffective({
        features: { reservations_enabled: { type: 'bool', value: true } },
        plan: { slug: 'community' },
      }),
    );
    const ctx = makeCtx(() => undefined, { tenant: { id: 'tnt-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws 402 with structured payload when the gated feature is off', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('reservations_enabled');
    const guard = new PlanGuard(
      reflector,
      makeEffective({
        features: { reservations_enabled: { type: 'bool', value: false } },
        plan: { slug: 'starter' },
      }),
    );
    const ctx = makeCtx(() => undefined, { tenant: { id: 'tnt-1' } });

    try {
      await guard.canActivate(ctx);
      throw new Error('expected canActivate to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const e = err as HttpException;
      expect(e.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(e.getResponse()).toMatchObject({
        statusCode: 402,
        feature: 'reservations_enabled',
        currentPlan: 'starter',
      });
    }
  });

  it('also throws 402 when the feature is missing from the plan entirely', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue('reservations_enabled');
    const guard = new PlanGuard(
      reflector,
      makeEffective({ features: {}, plan: { slug: 'starter' } }),
    );
    const ctx = makeCtx(() => undefined, { tenant: { id: 'tnt-1' } });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });
});
