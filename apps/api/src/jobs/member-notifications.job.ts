import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { Prisma, type TenantPrismaClient } from '@libriant/db-tenant';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  TENANT_CONTEXT_SELECT,
  tenantContextFrom,
  readSchemaMajors,
} from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { RedisService } from '../platform/redis.service.js';
import { EmailService } from '../email/email.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult } from './jobs.types.js';

/**
 * Member circulation reminders — opt-in per library (default OFF), so a library
 * never auto-emails its patrons until an admin enables the switches. Only
 * members with an email address are contacted.
 *
 *   - due-soon   : active loans due within `dueSoonDays`.
 *   - overdue    : active loans already past due.
 *   - hold-ready : reservations that have reached `ready` for pickup.
 *
 * Dedup is the email pipeline's job: each message carries a stable
 * `idempotencyKey`, and EmailService swallows the unique-constraint conflict,
 * so re-running this sweep never double-sends. Emails are composed in the
 * library's own locale.
 */
const MS_PER_DAY = 86_400_000;
const logger = new Logger('MemberNotifications');

type Loc = 'el' | 'en';
const localeOf = (s: string): Loc => (s.toLowerCase().startsWith('el') ? 'el' : 'en');
const fmtDate = (d: Date, loc: Loc) =>
  new Date(d).toLocaleDateString(loc === 'el' ? 'el-GR' : 'en-GB');
const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);

type Tpl = { subject: string; body: string };

function dueSoonTpl(
  loc: Loc,
  v: { member: string; book: string; due: string; library: string },
): Tpl {
  if (loc === 'el') {
    return {
      subject: `Υπενθύμιση: το «${v.book}» λήγει σύντομα`,
      body:
        `Αγαπητέ/ή ${v.member},\n\n` +
        `Υπενθύμιση ότι το «${v.book}» πρέπει να επιστραφεί έως τις ${v.due}. ` +
        `Παρακαλούμε επιστρέψτε ή ανανεώστε το μέχρι τότε.\n\n— ${v.library}`,
    };
  }
  return {
    subject: `Reminder: "${v.book}" is due soon`,
    body:
      `Dear ${v.member},\n\n` +
      `A friendly reminder that "${v.book}" is due back on ${v.due}. ` +
      `Please return or renew it by then.\n\n— ${v.library}`,
  };
}

function overdueTpl(
  loc: Loc,
  v: { member: string; book: string; due: string; library: string },
): Tpl {
  if (loc === 'el') {
    return {
      subject: `Εκπρόθεσμο: «${v.book}»`,
      body:
        `Αγαπητέ/ή ${v.member},\n\n` +
        `Σύμφωνα με τα στοιχεία μας, το «${v.book}» έπρεπε να επιστραφεί στις ${v.due} και είναι πλέον εκπρόθεσμο. ` +
        `Παρακαλούμε επιστρέψτε το το συντομότερο δυνατό.\n\n— ${v.library}`,
    };
  }
  return {
    subject: `"${v.book}" is overdue`,
    body:
      `Dear ${v.member},\n\n` +
      `Our records show "${v.book}" was due on ${v.due} and is now overdue. ` +
      `Please return it as soon as you can.\n\n— ${v.library}`,
  };
}

function holdReadyTpl(
  loc: Loc,
  v: { member: string; book: string; library: string; by: string | null },
): Tpl {
  if (loc === 'el') {
    const byLine = v.by ? ` Παρακαλούμε παραλάβετέ το έως τις ${v.by}.` : '';
    return {
      subject: `Η κράτησή σας για το «${v.book}» είναι έτοιμη`,
      body:
        `Αγαπητέ/ή ${v.member},\n\n` +
        `Καλά νέα — το «${v.book}» είναι έτοιμο προς παραλαβή στη βιβλιοθήκη ${v.library}.${byLine}\n\n— ${v.library}`,
    };
  }
  const byLine = v.by ? ` Please collect it by ${v.by}.` : '';
  return {
    subject: `Your hold on "${v.book}" is ready for pickup`,
    body:
      `Dear ${v.member},\n\n` +
      `Good news — "${v.book}" is ready for you to pick up at ${v.library}.${byLine}\n\n— ${v.library}`,
  };
}

/** Per-library overrides, keyed by reminder kind. */
type TemplateMap = Record<string, { subject?: string; body?: string } | undefined>;

const substitute = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\{(member|book|due|by|library)\}/g, (_, k: string) => vars[k] ?? '');

/** Use the admin's custom subject/body when set (non-empty), else the default. */
function pickTemplate(
  custom: { subject?: string; body?: string } | undefined,
  def: Tpl,
  vars: Record<string, string>,
): Tpl {
  return {
    subject: custom?.subject?.trim() ? substitute(custom.subject, vars) : def.subject,
    body: custom?.body?.trim() ? substitute(custom.body, vars) : def.body,
  };
}

export async function sendMemberNotifications(ctx?: JobContext): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  // 2.0 phase 20f: which of these libraries have been cut over, in one query.
  // A sweep that assumed `lbr2` would query a schema a promoted tenant no
  // longer has.
  const schemaMajors = await readSchemaMajors(tenants.map((x) => x.id));

  const tenantPrisma = new TenantPrismaService('worker');
  // reliability-01: this sweep used to construct its own RedisService here and
  // issue its first Redis GET microseconds later, on the first line of
  // notifyOneTenant. The client is built with `enableOfflineQueue: false`, so
  // that command rejected while the socket was still `connecting` — every
  // tenant fell into the catch below on every hourly tick, and no library ever
  // received a single reminder. Prefer the runner's long-lived client; when
  // running without a context, wait for our own to come up before using it.
  const redis = ctx?.redis ?? new RedisService();
  /** Non-null only when this call created the client and therefore owns it. */
  const ownedRedis = ctx?.redis ? null : redis;
  const counts = { dueSoon: 0, overdue: 0, holdReady: 0 };
  let failed = 0;
  let ownedEmails: EmailService | null = null;
  try {
    await redis.ready();
    const emails = ctx?.emails ?? new EmailService(redis);
    ownedEmails = ctx?.emails ? null : emails;
    // Member notifications are a paid feature, and until now nothing enforced
    // that: this job gated only on the tenant's own settings, so a free-plan
    // library that switched reminders on got them — while the pricing table said
    // otherwise. Sending email costs real money per message, so the free tier
    // cannot have an open tap.
    const plans = new EffectivePlanService(redis, new PlatformSettingsService(redis));
    for (const t of tenants) {
      // PER-JOB-TENANTPRISMA-CONN-MULTIPLY: the one-connection-per-tenant pin
      // lives in the service's 'worker' role now, not in this URL
      // (performance-06: the old `connection_limit=1`
      // query parameter was silently ignored by Prisma 7's driver adapter).
      // Constructed INSIDE the per-tenant try. `tenantContextFrom` throws for a
      // tenant with no sealed database credential (tenant-isolation-02), and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one — turning a single tenant's missing row into a
      // fleet-wide outage of the nightly job. The counter below is what that
      // case is for.
      try {
        const tenantCtx: TenantContext = tenantContextFrom(t, 'path', schemaMajors.get(t.id));
        const c = await notifyOneTenant(tenantCtx, tenantPrisma, emails, plans);
        counts.dueSoon += c.dueSoon;
        counts.overdue += c.overdue;
        counts.holdReady += c.holdReady;
      } catch (err) {
        failed++;
        logger.warn(`member notifications failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    // Only tear down what this call created — a client that came in through
    // the context outlives the tick and is shared with the other jobs.
    await ownedEmails?.onModuleDestroy().catch(() => undefined);
    await ownedRedis?.onModuleDestroy().catch(() => undefined);
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  const sent = counts.dueSoon + counts.overdue + counts.holdReady;
  return {
    message:
      sent === 0
        ? `${tenants.length} tenant(s) scanned; no member reminders due`
        : `queued ${sent} member reminder(s) across ${tenants.length} tenant(s)`,
    counts: { ...counts, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

async function notifyOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
  emails: EmailService,
  plans: EffectivePlanService,
): Promise<{ dueSoon: number; overdue: number; holdReady: number }> {
  // Checked before any tenant-DB work: with subscriptions disabled this
  // resolves true for everyone, so nothing changes until billing is switched on.
  if (!(await plans.getBool(ctx.id, 'email_notifications_enabled'))) {
    return { dueSoon: 0, overdue: 0, holdReady: 0 };
  }

  const client = tenantPrisma.getClient(ctx);
  const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
  if (!settings) return { dueSoon: 0, overdue: 0, holdReady: 0 };
  if (!settings.notifyDueSoon && !settings.notifyOverdue && !settings.notifyHoldReady) {
    return { dueSoon: 0, overdue: 0, holdReady: 0 };
  }

  const loc = localeOf(ctx.defaultLocale);
  const templates = (settings.notificationTemplates ?? {}) as TemplateMap;
  const now = new Date();
  let dueSoon = 0;
  let overdue = 0;
  let holdReady = 0;

  if (settings.notifyDueSoon) {
    const horizon = new Date(now.getTime() + Math.max(1, settings.dueSoonDays) * MS_PER_DAY);
    dueSoon = await sweepLoanNotices(client, emails, {
      // Due-soon is a forward window: strictly after now, up to the horizon.
      lower: now,
      upper: horizon,
      run: async (loan) => {
        const vars = {
          member: loan.memberName,
          book: loan.bookTitle,
          due: fmtDate(loan.dueAt, loc),
          library: ctx.name,
        };
        const tpl = pickTemplate(templates.dueSoon, dueSoonTpl(loc, vars), vars);
        return {
          kind: 'member_due_soon',
          toEmail: loan.memberEmail,
          subject: tpl.subject,
          bodyMarkdown: tpl.body,
          tenantId: ctx.id,
          idempotencyKey: `due-soon:${ctx.id}:${loan.id}:${dayKey(loan.dueAt)}`,
          metadata: { loanId: loan.id },
        };
      },
    });
  }

  if (settings.notifyOverdue) {
    overdue = await sweepLoanNotices(client, emails, {
      // Overdue is everything already past due.
      lower: null,
      upper: now,
      run: async (loan) => {
        const vars = {
          member: loan.memberName,
          book: loan.bookTitle,
          due: fmtDate(loan.dueAt, loc),
          library: ctx.name,
        };
        const tpl = pickTemplate(templates.overdue, overdueTpl(loc, vars), vars);
        return {
          kind: 'member_overdue',
          toEmail: loan.memberEmail,
          subject: tpl.subject,
          bodyMarkdown: tpl.body,
          tenantId: ctx.id,
          // OVERDUE-REMINDER-ONCE-EVER: key on TODAY, not the loan's fixed dueAt.
          // Keying on dueAt sent exactly one overdue nag ever per loan, defeating
          // the recovery purpose of the reminder. `dayKey(now)` re-reminds at most
          // once per calendar day (re-runs within a day still dedup as the
          // registry comment promises) until the book comes back.
          idempotencyKey: `overdue:${ctx.id}:${loan.id}:${dayKey(now)}`,
          metadata: { loanId: loan.id },
        };
      },
    });
  }

  if (settings.notifyHoldReady) {
    const holds = await client.reservation.findMany({
      where: {
        status: 'ready',
        readyAt: { not: null },
        member: { email: { not: null }, archivedAt: null },
      },
      select: {
        id: true,
        expiresAt: true,
        member: { select: { fullName: true, email: true } },
        book: { select: { title: true } },
      },
    });
    // Deliberately NOT keyset-paged, unlike the two loan sweeps above. No
    // reservations index leads with `status`, so paging this would turn one seq
    // scan into one seq scan PER PAGE. The ready set is also bounded by the
    // pickup window rather than by library size — reservation-pickup-expiry
    // drains it every 60 s — so there is nothing here to bound. What this DOES
    // get is the batched dedup pre-filter, which is where the cost was.
    const pending = holds.filter((h) => h.member.email);
    const queued = await alreadyQueued(pending.map((h) => `hold-ready:${ctx.id}:${h.id}`));
    for (const hold of pending) {
      const key = `hold-ready:${ctx.id}:${hold.id}`;
      if (queued.has(key)) continue;
      const by = hold.expiresAt ? fmtDate(hold.expiresAt, loc) : '';
      const vars = { member: hold.member.fullName, book: hold.book.title, library: ctx.name, by };
      const tpl = pickTemplate(
        templates.holdReady,
        holdReadyTpl(loc, { ...vars, by: by || null }),
        vars,
      );
      const res = await emails.enqueue({
        kind: 'member_hold_ready',
        toEmail: hold.member.email!,
        subject: tpl.subject,
        bodyMarkdown: tpl.body,
        tenantId: ctx.id,
        idempotencyKey: key,
        metadata: { reservationId: hold.id },
      });
      if (!res.alreadyExisted) holdReady++;
    }
  }

  return { dueSoon, overdue, holdReady };
}

/** One page of loans-with-member-and-title, ready to render into a notice. */
type LoanNotice = {
  id: string;
  dueAt: Date;
  memberName: string;
  memberEmail: string;
  bookTitle: string;
};

/**
 * Page size for the two loan-notice sweeps (performance-08).
 *
 * The old sweeps had no `take` at all: an Institutional library with 15,000
 * overdue loans pulled 15,000 rows — each carrying the member's name, e-mail
 * and the book title — into one JS array in the worker, which is the same
 * process that runs the export, import and every other cron.
 */
const NOTICE_PAGE_SIZE = 500;

/**
 * Which of these idempotency keys are already in the outbox (performance-08).
 *
 * `EmailService.enqueue` deduplicates by INSERTing and swallowing the P2002,
 * then re-reading the row to return its id. That is the right design for a
 * producer sending one message; it is the wrong one for a sweep that re-offers
 * the SAME 15,000 messages every hour, because 14 of every 15 attempts are a
 * failed INSERT (carrying the full rendered body) plus a `findUniqueOrThrow`,
 * against the control database every library shares. One indexed `IN` per page
 * replaces the whole failed-insert storm; `idempotencyKey` is `@unique`, so
 * this is an index scan.
 *
 * This does NOT move the dedup lever — enqueue still owns it, and still
 * absorbs the residual race between this read and the insert. It only stops
 * the sweep from re-offering what it can already see is there.
 */
async function alreadyQueued(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await controlDb.emailOutbox.findMany({
    where: { idempotencyKey: { in: keys } },
    select: { idempotencyKey: true },
  });
  const out = new Set<string>();
  for (const r of rows) if (r.idempotencyKey) out.add(r.idempotencyKey);
  return out;
}

/**
 * Keyset-paged sweep over active loans in a `dueAt` window, joined to the
 * member and the book title, skipping anything already in the outbox.
 *
 * Raw, and with a row-value `("dueAt","id") > ($1,$2)` predicate, for the
 * reason measured in fine-accrual.job.ts: the equivalent Prisma-expressible
 * form `dueAt > x OR (dueAt = x AND id > y)` is NOT a btree start key. On the
 * audit's 2M-row loans table the OR form re-walked the range from the
 * beginning on every page — `Index Scan using loans_status_dueAt_id_idx …
 * Rows Removed by Filter: 14500, Buffers: shared hit=9094` for page 30 — so
 * paging that way would have been slower than the unbounded query it replaced.
 * The row-value form seeks: `Buffers: shared hit=2239` for a 500-row page,
 * flat with depth.
 *
 * The relation predicates are an INNER JOIN rather than Prisma's
 * `member: { email: { not: null }, archivedAt: null }`, which is the same set
 * (`memberId`/`copyId` are NOT NULL FKs) in one round trip instead of one plus
 * a relation batch per level.
 */
async function sweepLoanNotices(
  client: TenantPrismaClient,
  emails: EmailService,
  opts: {
    /** Exclusive lower bound on dueAt, or null for "no lower bound". */
    lower: Date | null;
    /** Exclusive-below/inclusive-at upper bound on dueAt. */
    upper: Date;
    run: (loan: LoanNotice) => Promise<EnqueueSpec>;
  },
): Promise<number> {
  let sent = 0;
  let cursor: { dueAt: Date; id: string } | null = null;
  for (;;) {
    const lower: Prisma.Sql = opts.lower ? Prisma.sql`AND l."dueAt" > ${opts.lower}` : Prisma.empty;
    const upper: Prisma.Sql = opts.lower
      ? Prisma.sql`AND l."dueAt" <= ${opts.upper}`
      : Prisma.sql`AND l."dueAt" < ${opts.upper}`;
    const after: Prisma.Sql = cursor
      ? Prisma.sql`AND (l."dueAt", l."id") > (${cursor.dueAt}, ${cursor.id})`
      : Prisma.empty;
    const page = await client.$queryRaw<LoanNotice[]>(
      Prisma.sql`SELECT l."id",
                        l."dueAt",
                        m."fullName" AS "memberName",
                        m."email"::text AS "memberEmail",
                        b."title"   AS "bookTitle"
                   FROM "loans" l
                   JOIN "members" m     ON m."id" = l."memberId"
                   JOIN "book_copies" c ON c."id" = l."copyId"
                   JOIN "books" b       ON b."id" = c."bookId"
                  WHERE l."status" = 'active'::"LoanStatus"
                    ${lower}
                    ${upper}
                    AND m."email" IS NOT NULL
                    AND m."archivedAt" IS NULL
                    ${after}
                  ORDER BY l."dueAt" ASC, l."id" ASC
                  LIMIT ${NOTICE_PAGE_SIZE}`,
    );
    if (page.length === 0) break;

    const specs: EnqueueSpec[] = [];
    for (const loan of page) specs.push(await opts.run(loan));
    const queued = await alreadyQueued(specs.map((s) => s.idempotencyKey));
    for (const spec of specs) {
      if (queued.has(spec.idempotencyKey)) continue;
      const res = await emails.enqueue(spec);
      if (!res.alreadyExisted) sent++;
    }

    if (page.length < NOTICE_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { dueAt: last.dueAt, id: last.id };
  }
  return sent;
}

/** What `sweepLoanNotices` hands to {@link EmailService.enqueue}. */
type EnqueueSpec = {
  kind: 'member_due_soon' | 'member_overdue';
  toEmail: string;
  subject: string;
  bodyMarkdown: string;
  tenantId: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
};
