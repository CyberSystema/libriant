import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  tenantFindMany,
  tenantGetClient,
  tenantDestroy,
  enqueue,
  emailDestroy,
  redisDestroy,
  getBool,
} = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn(),
  emailDestroy: vi.fn().mockResolvedValue(undefined),
  redisDestroy: vi.fn().mockResolvedValue(undefined),
  // Member notifications are a paid feature; the job asks the plan first.
  getBool: vi.fn().mockResolvedValue(true),
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
vi.mock('../plans/effective-plan.service.js', () => ({
  EffectivePlanService: vi.fn(function () {
    return { getBool };
  }),
}));
vi.mock('../platform-settings/platform-settings.service.js', () => ({
  PlatformSettingsService: vi.fn(function () {
    return {};
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
    getBool.mockResolvedValue(true);
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

  it('applies a custom template with placeholder substitution', async () => {
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: {
          notifyDueSoon: true,
          dueSoonDays: 2,
          notifyOverdue: false,
          notifyHoldReady: false,
          notificationTemplates: {
            dueSoon: { subject: 'Hi {member}', body: '{book} is due on {due} — {library}' },
          },
        },
        dueSoon: [loan('l1')],
      }),
    );
    await sendMemberNotifications();
    const arg = enqueue.mock.calls[0]![0] as { subject: string; bodyMarkdown: string };
    expect(arg.subject).toBe('Hi Pat');
    expect(arg.bodyMarkdown).toContain('Dune is due on');
    expect(arg.bodyMarkdown).toContain('Acme');
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

  it('sends nothing when the plan does not include email notifications', async () => {
    // The pricing table has always advertised member notifications as a paid
    // feature; until this gate existed, nothing enforced it and a free-plan
    // library that switched reminders on got them.
    getBool.mockResolvedValue(false);
    tenantFindMany.mockResolvedValue([TENANT]);
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: {
          notifyDueSoon: true,
          notifyOverdue: true,
          notifyHoldReady: true,
          dueSoonDays: 3,
          notificationTemplates: {},
        },
        dueSoon: [loan('l1')],
      }),
    );

    const res = await sendMemberNotifications();

    expect(enqueue).not.toHaveBeenCalled();
    expect(getBool).toHaveBeenCalledWith('t1', 'email_notifications_enabled');
    expect(res.counts).toMatchObject({ dueSoon: 0, overdue: 0, holdReady: 0 });
  });

  it('checks the plan before touching the tenant database', async () => {
    // Cheap check first: a free-plan tenant should cost one cached plan read,
    // not a connection and a query against its database.
    getBool.mockResolvedValue(false);
    tenantFindMany.mockResolvedValue([TENANT]);
    tenantGetClient.mockReturnValue(makeClient({ settings: null }));

    await sendMemberNotifications();

    expect(tenantGetClient).not.toHaveBeenCalled();
  });
});
