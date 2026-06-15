import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';

function makeCtx(headerVal: string | undefined, res = { setHeader: vi.fn() }) {
  const req = {
    header: (h: string) => (h.toLowerCase() === 'idempotency-key' ? headerVal : undefined),
    tenant: { id: 't1' },
    method: 'POST',
    path: '/t/acme/loans/L1/return',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}
function handlerOf(value: unknown): CallHandler {
  return { handle: vi.fn(() => of(value)) };
}

describe('IdempotencyInterceptor', () => {
  let redis: {
    client: {
      set: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };
  };
  let interceptor: IdempotencyInterceptor;
  beforeEach(() => {
    // Defaults return thenables — the interceptor calls `.catch()` on store/del.
    redis = {
      client: {
        set: vi.fn().mockResolvedValue('OK'),
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(1),
      },
    };
    interceptor = new IdempotencyInterceptor(redis as never);
  });

  it('passes through when no Idempotency-Key header is present', async () => {
    const next = handlerOf({ ok: 1 });
    const obs = await interceptor.intercept(makeCtx(undefined), next);
    expect(await firstValueFrom(obs)).toEqual({ ok: 1 });
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('rejects an over-long key', async () => {
    await expect(
      interceptor.intercept(makeCtx('x'.repeat(201)), handlerOf({})),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('on first request: claims, runs the handler, and stores the result', async () => {
    redis.client.set.mockResolvedValueOnce('OK'); // claim wins
    redis.client.set.mockResolvedValueOnce('OK'); // store
    const next = handlerOf({ loan: { id: 'L1' } });
    const obs = await interceptor.intercept(makeCtx('key-123'), next);
    const result = await firstValueFrom(obs);
    expect(result).toEqual({ loan: { id: 'L1' } });
    expect(next.handle).toHaveBeenCalledTimes(1);
    // 1st set = claim (NX), 2nd = store the body
    const store = redis.client.set.mock.calls[1]!;
    expect(store[0]).toMatch(/^idem:t1:POST:\/t\/acme\/loans\/L1\/return:key-123$/);
    expect(JSON.parse(store[1] as string)).toEqual({ body: { loan: { id: 'L1' } } });
  });

  it('REPLAYS the stored result on a duplicate, without re-running the handler', async () => {
    redis.client.set.mockResolvedValueOnce(null); // claim fails — already exists
    redis.client.get.mockResolvedValueOnce(JSON.stringify({ body: { loan: { id: 'L1' } } }));
    const res = { setHeader: vi.fn() };
    const next = handlerOf({ should: 'not run' });
    const obs = await interceptor.intercept(makeCtx('key-123', res), next);
    expect(await firstValueFrom(obs)).toEqual({ loan: { id: 'L1' } });
    expect(next.handle).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
  });

  it('returns 409 while an identical request is still in flight', async () => {
    redis.client.set.mockResolvedValueOnce(null);
    redis.client.get.mockResolvedValueOnce('__pending__');
    await expect(interceptor.intercept(makeCtx('key-123'), handlerOf({}))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('releases the key when the handler errors, so a retry can proceed', async () => {
    redis.client.set.mockResolvedValueOnce('OK');
    const next: CallHandler = { handle: vi.fn(() => throwError(() => new Error('boom'))) };
    const obs = await interceptor.intercept(makeCtx('key-123'), next);
    await expect(firstValueFrom(obs)).rejects.toThrow('boom');
    expect(redis.client.del).toHaveBeenCalledTimes(1);
  });

  it('fails OPEN (processes normally) if Redis is unavailable', async () => {
    redis.client.set.mockRejectedValueOnce(new Error('redis down'));
    const next = handlerOf({ ok: 2 });
    const obs = await interceptor.intercept(makeCtx('key-123'), next);
    expect(await firstValueFrom(obs)).toEqual({ ok: 2 });
    expect(next.handle).toHaveBeenCalledTimes(1);
  });
});
