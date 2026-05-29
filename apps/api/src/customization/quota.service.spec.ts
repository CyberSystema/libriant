import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaService } from './quota.service.js';

/**
 * Unit tests for the race-safe quota gate. We don't hit a real DB: the
 * `tx` is a stub whose only job is to record that the advisory lock SQL ran
 * (and that it ran BEFORE the count), and `EffectivePlanService` is mocked
 * to return a fixed limit. The end-to-end "20 parallel creates cap at the
 * limit" behaviour is covered by the live race drill.
 */
describe('QuotaService.enforceWithinTx', () => {
  const calls: string[] = [];
  let tx: { $executeRaw: ReturnType<typeof vi.fn> };
  let effective: { getInt: ReturnType<typeof vi.fn>; getEffectivePlan: ReturnType<typeof vi.fn> };
  let svc: QuotaService;

  beforeEach(() => {
    calls.length = 0;
    tx = {
      $executeRaw: vi.fn(async () => {
        calls.push('lock');
        return 1;
      }),
    };
    effective = {
      getInt: vi.fn(async () => 5),
      getEffectivePlan: vi.fn(async () => ({ plan: { slug: 'starter' } })),
    };
    // QuotaService only uses `effective`; cast the stub in.
    svc = new QuotaService(effective as never);
  });

  const count = (n: number) => async () => {
    calls.push('count');
    return n;
  };

  it('acquires the advisory lock BEFORE counting', async () => {
    await svc.enforceWithinTx(tx as never, {
      tenantId: 't1',
      featureKey: 'max_books',
      count: count(0),
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['lock', 'count']);
  });

  it('passes when usage is below the limit', async () => {
    await expect(
      svc.enforceWithinTx(tx as never, {
        tenantId: 't1',
        featureKey: 'max_books',
        count: count(4),
      }),
    ).resolves.toBeUndefined();
  });

  it('throws 402 when usage is AT the limit', async () => {
    await expect(
      svc.enforceWithinTx(tx as never, {
        tenantId: 't1',
        featureKey: 'max_books',
        count: count(5),
      }),
    ).rejects.toMatchObject({ status: 402 });
  });

  it('throws 402 when usage is OVER the limit, with feature/limit/used payload', async () => {
    try {
      await svc.enforceWithinTx(tx as never, {
        tenantId: 't1',
        featureKey: 'max_members',
        context: { entityKind: 'member' },
        count: count(9),
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const body = (err as HttpException).getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        statusCode: 402,
        feature: 'max_members',
        limit: 5,
        used: 9,
        currentPlan: 'starter',
        context: { entityKind: 'member' },
      });
    }
  });

  it('includes lockContext in the advisory-lock key (distinct keys do not collide)', async () => {
    await svc.enforceWithinTx(tx as never, {
      tenantId: 't1',
      featureKey: 'max_records_per_collection',
      lockContext: 'col-123',
      count: count(0),
    });
    // The tagged-template values are passed as the 2nd arg onward; the first
    // interpolated value is our lock key string.
    const firstCall = tx.$executeRaw.mock.calls[0] ?? [];
    expect(firstCall.slice(1)).toContain('quota:t1:max_records_per_collection:col-123');
  });
});
