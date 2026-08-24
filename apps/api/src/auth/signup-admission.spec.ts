import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@libriant/db-control', () => ({ controlDb: {} }));

import { AuthController } from './auth.controller.js';

/** A valid signup body — the admission gate has to run before any of it matters. */
const BODY = {
  libraryName: 'Test Library',
  slug: 'test-library',
  fullName: 'Test Owner',
  email: 'owner@example.test',
  password: 'a-long-enough-password',
  libraryType: 'public',
  addressStreet: '1 Test Street',
  addressCity: 'Athens',
  addressPostalCode: '10431',
  addressCountry: 'GR',
  acceptLegal: true,
};

function makeController(opts: { admitted?: number } = {}) {
  const redis = {
    client: {
      eval: vi.fn(async () => opts.admitted ?? 1),
      zrem: vi.fn(async () => 1),
    },
  };
  const signupSvc = {
    signup: vi.fn(async () => ({
      token: 't',
      expiresAt: new Date(),
      remember: true,
      tenant: { id: 'tnt', slug: 'test-library', name: 'Test Library', defaultLocale: 'el' },
      user: { id: 'u', email: BODY.email, fullName: BODY.fullName, role: 'owner' as const },
    })),
  };
  const ctrl = new AuthController(
    { setSession: vi.fn() } as never,
    signupSvc as never,
    {} as never,
    {} as never,
    {} as never,
    { invalidate: vi.fn() } as never,
    { hit: vi.fn(async () => ({ allowed: true, count: 1, retryAfterSec: 0 })) } as never,
    redis as never,
  );
  return { ctrl, redis, signupSvc };
}

const req = { headers: {}, socket: { remoteAddress: '172.18.0.4' } } as unknown as Request;
const res = { cookie: vi.fn() } as unknown as Response;

describe('signup provisioning admission control (input-and-files-03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admits a signup and hands the slot back afterwards', async () => {
    const { ctrl, redis, signupSvc } = makeController();
    await ctrl.signup(BODY, req, res);
    expect(signupSvc.signup).toHaveBeenCalledTimes(1);
    expect(redis.client.eval).toHaveBeenCalledTimes(1);
    expect(redis.client.zrem).toHaveBeenCalledTimes(1);
  });

  it('refuses with 429 — not a 500 — when every provisioning slot is taken', async () => {
    const { ctrl, signupSvc } = makeController({ admitted: 0 });
    await expect(ctrl.signup(BODY, req, res)).rejects.toMatchObject({ status: 429 });
    // The whole point: CREATE DATABASE is never reached.
    expect(signupSvc.signup).not.toHaveBeenCalled();
  });

  it('fails CLOSED when Redis is unreachable rather than provisioning unmetered', async () => {
    const { ctrl, redis, signupSvc } = makeController();
    redis.client.eval.mockRejectedValue(new Error('Redis down'));

    // 503, NOT the 429 used for a genuinely full queue. A prospective customer
    // arriving during the launch campaign must not be told "we are busy right
    // now" when the truth is that our own metering store is down — that reads
    // as traction to us and as a broken product to them, and it sends the
    // operator looking at capacity instead of at Redis.
    await expect(ctrl.signup(BODY, req, res)).rejects.toMatchObject({ status: 503 });
    await expect(ctrl.signup(BODY, req, res)).rejects.toMatchObject({
      response: { message: expect.stringContaining('Nothing was created') },
    });
    expect(signupSvc.signup).not.toHaveBeenCalled();
  });

  it('releases the slot when the signup itself fails', async () => {
    const { ctrl, redis, signupSvc } = makeController();
    signupSvc.signup.mockRejectedValue(new Error('slug taken'));
    await expect(ctrl.signup(BODY, req, res)).rejects.toThrow('slug taken');
    expect(redis.client.zrem).toHaveBeenCalledTimes(1);
  });

  it('never spends a slot on a malformed body — validation runs first', async () => {
    const { ctrl, redis } = makeController();
    await expect(ctrl.signup({ ...BODY, email: 'nope' }, req, res)).rejects.toThrow();
    expect(redis.client.eval).not.toHaveBeenCalled();
  });
});
