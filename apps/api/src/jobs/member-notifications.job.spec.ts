import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy, enqueue, emailDestroy, redisDestroy } =
  vi.hoisted(() => ({
    tenantFindMany: vi.fn(),
    tenantGetClient: vi.fn(),
    tenantDestroy: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn(),
    emailDestroy: vi.fn().mockResolvedValue(undefined),
    redisDestroy: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@libriant/db-control', () => ({ controlDb: { tenant: { findMany: tenantFindMany } } }));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantClientCacheSize: 10, tenantClientIdleMs: 60_000 }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));
vi.mock('../platform/redis.service.js', () => ({
  RedisService: vi.fn(function () {
    return { onModuleDestroy: redisDestroy };
  }),
}));
vi.mock('../email/email.service.js', () => ({
  EmailService: vi.fn(function () {
    return { enqueue, onModuleDestroy: emailDestroy };
  }),
}));

import { sendMemberNotifications } from './member-notifications.job.js';

const TENANT = {
  id: 't1',
  slug: 'acme',
  name: 'Acme',
  defaultLocale: 'en',
  status: 'active',
  dbUrl: 'x',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
};

function makeClient(opts: {
  settings: Record<string, unknown> | null;
  dueSoon?: unknown[];
  overdue?: unknown[];
  holds?: unknown[];
}) {
  return {
    tenantSetting: { findUnique: vi.fn(async () => opts.settings) },
    loan: {
      findMany: vi.fn(async (args: { where: { dueAt?: { gt?: Date; lt?: Date } } }) =>
        args.where.dueAt?.gt ? (opts.dueSoon ?? []) : (opts.overdue ?? []),
      ),
    },
    reservation: { findMany: vi.fn(async () => opts.holds ?? []) },
  };
}

const loan = (id: string) => ({
  id,
  dueAt: new Date('2026-06-20'),
  member: { fullName: 'Pat', email: 'pat@example.com' },
  copy: { book: { title: 'Dune' } },
});
const hold = (id: string) => ({
  id,
  expiresAt: new Date('2026-06-22'),
  member: { fullName: 'Pat', email: 'pat@example.com' },
  book: { title: 'Dune' },
});

describe('sendMemberNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantFindMany.mockResolvedValue([TENANT]);
    enqueue.mockResolvedValue({ outboxId: 'o1', alreadyExisted: false });
  });

  it('does nothing when every notification switch is off', async () => {
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: { notifyDueSoon: false, notifyOverdue: false, notifyHoldReady: false },
        dueSoon: [loan('l1')],
      }),
    );
    const res = await sendMemberNotifications();
    expect(enqueue).not.toHaveBeenCalled();
    expect(res.counts?.dueSoon).toBe(0);
  });

  it('queues a due-soon reminder with a stable idempotency key', async () => {
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: {
          notifyDueSoon: true,
          dueSoonDays: 2,
          notifyOverdue: false,
          notifyHoldReady: false,
        },
        dueSoon: [loan('l1')],
      }),
    );
    const res = await sendMemberNotifications();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0]![0] as {
      kind: string;
      idempotencyKey: string;
      toEmail: string;
    };
    expect(arg.kind).toBe('member_due_soon');
    expect(arg.toEmail).toBe('pat@example.com');
    expect(arg.idempotencyKey).toMatch(/^due-soon:t1:l1:/);
    expect(res.counts?.dueSoon).toBe(1);
  });

  it('respects per-type toggles (overdue off ⇒ no overdue mail)', async () => {
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: { notifyDueSoon: false, notifyOverdue: false, notifyHoldReady: true },
        overdue: [loan('l1')],
        holds: [hold('r1')],
      }),
    );
    await sendMemberNotifications();
    const kinds = enqueue.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(['member_hold_ready']);
  });

  it('does not count messages the email pipeline deduped', async () => {
    enqueue.mockResolvedValue({ outboxId: 'o1', alreadyExisted: true });
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: {
          notifyDueSoon: true,
          dueSoonDays: 2,
          notifyOverdue: false,
          notifyHoldReady: false,
        },
        dueSoon: [loan('l1')],
      }),
    );
    const res = await sendMemberNotifications();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(res.counts?.dueSoon).toBe(0);
  });

  it('cleans up the email + redis + tenant clients', async () => {
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: { notifyDueSoon: false, notifyOverdue: false, notifyHoldReady: false },
      }),
    );
    await sendMemberNotifications();
    expect(emailDestroy).toHaveBeenCalled();
    expect(redisDestroy).toHaveBeenCalled();
    expect(tenantDestroy).toHaveBeenCalled();
  });
});
