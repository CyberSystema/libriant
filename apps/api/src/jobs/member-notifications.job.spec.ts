import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  tenantFindMany,
  tenantGetClient,
  tenantDestroy,
  enqueue,
  emailDestroy,
  redisDestroy,
  redisReady,
  getBool,
  outboxFindMany,
} = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
  enqueue: vi.fn(),
  emailDestroy: vi.fn().mockResolvedValue(undefined),
  redisDestroy: vi.fn().mockResolvedValue(undefined),
  redisReady: vi.fn().mockResolvedValue(undefined),
  // Member notifications are a paid feature; the job asks the plan first.
  getBool: vi.fn().mockResolvedValue(true),
  // performance-08: the sweep now pre-filters each page against the outbox
  // instead of letting every already-queued message fail an INSERT.
  outboxFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock('@libriant/db-control', async (importOriginal) => ({
  // Spread the real module: since phase 4 the sweep composes each tenant's
  // runtime connection string from its sealed credential, so the sealing
  // helpers have to be the real ones (tenant-isolation-02).
  ...(await importOriginal<typeof import('@libriant/db-control')>()),
  controlDb: {
    tenant: { findMany: tenantFindMany },
    emailOutbox: { findMany: outboxFindMany },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    tenantClientCacheSize: 10,
    tenantClientIdleMs: 60_000,
    ...TEST_TENANT_DB_ENV,
  }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));
vi.mock('../platform/redis.service.js', () => ({
  RedisService: vi.fn(function () {
    return { ready: redisReady, onModuleDestroy: redisDestroy };
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
import {
  TEST_TENANT_DB_ENV,
  testSealedCredential,
} from '../tenancy/__fixtures__/tenant-credential.js';

import { sendMemberNotifications } from './member-notifications.job.js';
import { RedisService } from '../platform/redis.service.js';
import { EmailService } from '../email/email.service.js';
import type { JobContext } from './jobs.types.js';

const TENANT = {
  id: 't1',
  slug: 'acme',
  name: 'Acme',
  defaultLocale: 'en',
  status: 'active',
  // A real-shaped ADMIN url: `runtimeDbUrl` composes the tenant's own
  // credential onto this endpoint, so 'x' is no longer parseable input.
  dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t1',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
  dbCredentials: testSealedCredential('t1'),
};

function makeClient(opts: {
  settings: Record<string, unknown> | null;
  dueSoon?: unknown[];
  overdue?: unknown[];
  holds?: unknown[];
}) {
  return {
    tenantSetting: { findUnique: vi.fn(async () => opts.settings) },
    // performance-08: the two loan sweeps are keyset-paged raw SQL now (the
    // Prisma-expressible `dueAt > x OR (dueAt = x AND id > y)` form is not a
    // btree start key, so paging that way was slower than not paging at all).
    // The due-soon page carries a LOWER bound on dueAt; the overdue page does
    // not — that is what tells the two apart here.
    $queryRaw: vi.fn(async (sql: { text: string }) =>
      sql.text.includes('"dueAt" >') ? (opts.dueSoon ?? []) : (opts.overdue ?? []),
    ),
    reservation: { findMany: vi.fn(async () => opts.holds ?? []) },
  };
}

// The flat row shape the paged SELECT returns (loan JOIN member JOIN book).
const loan = (id: string) => ({
  id,
  dueAt: new Date('2026-06-20'),
  memberName: 'Pat',
  memberEmail: 'pat@example.com',
  bookTitle: 'Dune',
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
    redisReady.mockResolvedValue(undefined);
    getBool.mockResolvedValue(true);
    tenantFindMany.mockResolvedValue([TENANT]);
    enqueue.mockResolvedValue({ outboxId: 'o1', alreadyExisted: false });
    outboxFindMany.mockResolvedValue([]);
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

  it('never re-offers a message the outbox already holds', async () => {
    // performance-08. `EmailService.enqueue` dedups by INSERTing and swallowing
    // the P2002, so an hourly sweep over 15,000 overdue loans spent ~14 of
    // every 15 attempts on a failed INSERT (full body and all) plus a re-read,
    // against the control database every library shares. The sweep now asks
    // once per page which keys are already there.
    //
    // The key is spelled out here rather than read back from the job, so a
    // change to how the job builds it fails this test instead of passing it.
    outboxFindMany.mockResolvedValue([{ idempotencyKey: 'due-soon:t1:l1:2026-06-20' }]);
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
    expect(outboxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: { in: ['due-soon:t1:l1:2026-06-20'] } },
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
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

  it('waits for the Redis socket before issuing the first per-tenant command', async () => {
    // reliability-01: the sweep constructed a RedisService and issued its first
    // GET on the next tick. `enableOfflineQueue: false` rejects a command on a
    // still-connecting socket, so EVERY tenant threw on EVERY hourly tick and
    // no library ever received a reminder — while the job reported success.
    let socketReady = false;
    redisReady.mockImplementation(async () => {
      socketReady = true;
    });
    getBool.mockImplementation(async () => {
      if (!socketReady) {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return true;
    });
    tenantGetClient.mockReturnValue(
      makeClient({
        settings: { notifyDueSoon: false, notifyOverdue: false, notifyHoldReady: false },
      }),
    );

    const res = await sendMemberNotifications();

    expect(redisReady).toHaveBeenCalled();
    expect(res.counts?.tenantsFailed).toBe(0);
  });

  it("borrows the runner's long-lived clients and does not close them", async () => {
    // The structural half of the same fix: a job handed a warm client must not
    // mint its own, and must not quit one the whole worker is sharing.
    tenantGetClient.mockReturnValue(makeClient({ settings: null }));
    const shared = {
      redis: { ready: vi.fn().mockResolvedValue(undefined), onModuleDestroy: vi.fn() },
      emails: { enqueue, onModuleDestroy: vi.fn() },
    };

    await sendMemberNotifications(shared as unknown as JobContext);

    expect(shared.redis.ready).toHaveBeenCalled();
    expect(shared.redis.onModuleDestroy).not.toHaveBeenCalled();
    expect(shared.emails.onModuleDestroy).not.toHaveBeenCalled();
    expect(vi.mocked(RedisService)).not.toHaveBeenCalled();
    expect(vi.mocked(EmailService)).not.toHaveBeenCalled();
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
