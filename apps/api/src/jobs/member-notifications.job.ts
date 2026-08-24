import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { RedisService } from '../platform/redis.service.js';
import { EmailService } from '../email/email.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { pinWorkerConnLimit } from './fine-accrual.job.js';
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
    select: {
      id: true,
      slug: true,
      name: true,
      defaultLocale: true,
      status: true,
      dbUrl: true,
      storageUrl: true,
      customSubdomain: true,
      tags: true,
    },
  });

  const tenantPrisma = new TenantPrismaService();
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
      // PER-JOB-TENANTPRISMA-CONN-MULTIPLY: pin a 1-connection pool for the
      // worker's per-tenant client so overlapping hourly sweeps don't march
      // toward Postgres max_connections.
      const tenantCtx: TenantContext = {
        ...t,
        dbUrl: pinWorkerConnLimit(t.dbUrl),
        resolvedFrom: 'path',
      };
      try {
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
    const loans = await client.loan.findMany({
      where: {
        status: 'active',
        dueAt: { gt: now, lte: horizon },
        member: { email: { not: null }, archivedAt: null },
      },
      select: {
        id: true,
        dueAt: true,
        member: { select: { fullName: true, email: true } },
        copy: { select: { book: { select: { title: true } } } },
      },
    });
    for (const loan of loans) {
      if (!loan.member.email) continue;
      const vars = {
        member: loan.member.fullName,
        book: loan.copy.book.title,
        due: fmtDate(loan.dueAt, loc),
        library: ctx.name,
      };
      const tpl = pickTemplate(templates.dueSoon, dueSoonTpl(loc, vars), vars);
      const res = await emails.enqueue({
        kind: 'member_due_soon',
        toEmail: loan.member.email,
        subject: tpl.subject,
        bodyMarkdown: tpl.body,
        tenantId: ctx.id,
        idempotencyKey: `due-soon:${ctx.id}:${loan.id}:${dayKey(loan.dueAt)}`,
        metadata: { loanId: loan.id },
      });
      if (!res.alreadyExisted) dueSoon++;
    }
  }

  if (settings.notifyOverdue) {
    const loans = await client.loan.findMany({
      where: {
        status: 'active',
        dueAt: { lt: now },
        member: { email: { not: null }, archivedAt: null },
      },
      select: {
        id: true,
        dueAt: true,
        member: { select: { fullName: true, email: true } },
        copy: { select: { book: { select: { title: true } } } },
      },
    });
    for (const loan of loans) {
      if (!loan.member.email) continue;
      const vars = {
        member: loan.member.fullName,
        book: loan.copy.book.title,
        due: fmtDate(loan.dueAt, loc),
        library: ctx.name,
      };
      const tpl = pickTemplate(templates.overdue, overdueTpl(loc, vars), vars);
      const res = await emails.enqueue({
        kind: 'member_overdue',
        toEmail: loan.member.email,
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
      });
      if (!res.alreadyExisted) overdue++;
    }
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
    for (const hold of holds) {
      if (!hold.member.email) continue;
      const by = hold.expiresAt ? fmtDate(hold.expiresAt, loc) : '';
      const vars = { member: hold.member.fullName, book: hold.book.title, library: ctx.name, by };
      const tpl = pickTemplate(
        templates.holdReady,
        holdReadyTpl(loc, { ...vars, by: by || null }),
        vars,
      );
      const res = await emails.enqueue({
        kind: 'member_hold_ready',
        toEmail: hold.member.email,
        subject: tpl.subject,
        bodyMarkdown: tpl.body,
        tenantId: ctx.id,
        idempotencyKey: `hold-ready:${ctx.id}:${hold.id}`,
        metadata: { reservationId: hold.id },
      });
      if (!res.alreadyExisted) holdReady++;
    }
  }

  return { dueSoon, overdue, holdReady };
}
