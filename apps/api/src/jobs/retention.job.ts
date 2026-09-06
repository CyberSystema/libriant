import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { applicationNotifyKey } from '../applications/applications.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { RedisService } from '../platform/redis.service.js';
import { LONGEST_ONE_TIME_LINK_TTL_SEC } from '../auth/one-time-link-ttl.js';
import { EffectivePlanService, isUnlimitedInt } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult } from './jobs.types.js';

/**
 * Retention sweep — deletes personal data once the period we PUBLISHED for it
 * has run out (privacy-legal-05, GDPR Art. 5(1)(e)).
 *
 * The audit found nine scheduled jobs, none of which deleted anything on age:
 * a library-site applicant's name, e-mail and phone stayed in the control plane
 * forever, and `audit_log_retention_days` — a plan feature that is seeded per
 * plan (7 / 90 / 365 / 1095 / 3650 days), sold on the pricing page, and
 * described in the tenant schema as "enforced by a background job" — had no
 * reader anywhere in the tree.
 *
 * WHAT THIS ENFORCES, AND WHY ONLY THIS
 *
 * A retention job may only enforce a period somebody has actually promised;
 * inventing one is how you end up deleting a library's records on a schedule
 * nobody agreed to. There are exactly three written-down periods in this
 * product:
 *
 *   1. **Applications — 12 months.** apps/site/content/privacy.{el,en}.md §5,
 *      live on libriant.com: «διαγράφουμε τα στοιχεία σας το αργότερο 12 μήνες
 *      μετά την επικοινωνία μας» / "we delete your details at the latest 12
 *      months after we have been in touch", and — the other half of the same
 *      sentence — "if we do go ahead, the details move into your library's
 *      account and are governed by the service agreement". So: everything that
 *      did not become a partnership goes at 12 months; `accepted` rows stay,
 *      because those are the ones the notice says move on to the contract. The
 *      admin notification the submission raised goes with the row it describes
 *      (privacy-legal-14) — it is a second copy of the same applicant.
 *
 *   2. **Tenant audit_log — the plan's `audit_log_retention_days`.** Resolved
 *      per tenant through the same EffectivePlanService the rest of the product
 *      reads, so what gets deleted is exactly what was sold. Note that with
 *      subscriptions OFF — the shipped configuration — every int feature
 *      resolves to the `UNLIMITED_INT` sentinel, which means retention is
 *      LIFTED, not zero: the job skips those tenants and says so. Deleting a
 *      library's own audit history while the product tells them their retention
 *      is unlimited would be the same class of bug as not deleting at all.
 *
 *   3. **Stripe webhook bodies — 30 days.** performance-07. Three places in the
 *      tree assert this and none of them did it: schema.prisma on
 *      `StripeWebhookEvent.payloadJson` ("Raw event body for replay / debug.
 *      Pruned after 30 days."), and stripe-retry.job.ts twice ("Rows are
 *      bounded: the table is cleaned at 30 days", and "a table that is pruned
 *      at 30 days" — which is that job's stated justification for running an
 *      unindexed COUNT over it every five minutes). The body is ~99% of a
 *      row's bytes and it lands in the control database every library shares.
 *      The period is stated on the BODY, and only the body is pruned — see
 *      `pruneStripeWebhookPayloads` for why the row itself has to stay.
 *
 *   4. **The three §6 tables — the period is an env var, and it is UNSET.**
 *      performance-07 named six append-only tables. The three above cover half
 *      of them; the rest are the control-plane `audit_log`, the `email_outbox`
 *      body, and `support_redemption_attempts` (IP addresses). Those fall under
 *      Privacy Policy §6, whose periods are still unresolved placeholders —
 *      `[30]` days, `[14]`-day backups, `[up to 5–10]` years, `[a limited
 *      period, e.g. 90 days]`.
 *
 *      A previous round left them out entirely on the grounds that inventing a
 *      number is worse than unbounded growth. That is right about the NUMBER
 *      and wrong about the SWEEP: a period nobody has published is the owner's
 *      to supply, but the machinery that enforces it is ours, and "we could not
 *      pick a number" is not a reason to ship a control database that grows
 *      forever with no way to stop it. So each of those three limbs is written,
 *      wired and tested here, governed by an environment variable that is unset
 *      today. Unset means the limb does nothing and SAYS SO in the run message,
 *      which is what turns "somebody must write §6" into something an operator
 *      reading job output can see. When §6 is filled in, set the variable — no
 *      deploy of new code, no migration.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH, AND WHY
 *
 * `announcement_deliveries`: CASCADEs from announcement, tenant AND user and
 * holds only ids plus four timestamps, so it is bounded by announcements ×
 * users rather than unbounded. `stripe_webhook_events` ROWS: ~100 bytes each,
 * and `processedAt` on them is the durable replay guard — see
 * `pruneStripeWebhookPayloads`. `support_sessions`: bounded by admin activity,
 * a handful of rows a month, and each one is the parent of the action log that
 * evidences what support did inside a library. `users.legalAcceptedIp`: that is
 * the Art. 7(1) evidence privacy-legal-09 exists to create, not spare data.
 *
 * SAFE TO RE-RUN. Every limb is age-bounded and self-emptying: running twice in
 * a row changes nothing the second time, and a crash mid-sweep loses nothing but
 * the remainder of that tick.
 */
const logger = new Logger('RetentionSweep');

/**
 * Published on libriant.com. Not a tunable — changing it changes what we told
 * applicants, so the notice has to change with it.
 */
export const APPLICATION_RETENTION_MONTHS = 12;

/**
 * Audit rows are deleted in bounded batches rather than one `DELETE … WHERE
 * occurredAt < cutoff`: the first run against a library that has been writing
 * audit rows for three years would otherwise take one enormous transaction and
 * hold locks on the table the whole time. Whatever is left over is reported and
 * picked up by the next tick.
 */
const AUDIT_DELETE_BATCH = 5_000;
const AUDIT_MAX_BATCHES = 40;

/**
 * A retention of 0 (or a negative) would wipe a library's entire audit log.
 * Nothing seeds such a value today, but a bad plan_feature_value or a typo'd
 * override is one UPDATE away, and this job is the one thing standing between
 * that typo and the data. Refuse to act on it and shout instead.
 */
const MIN_ENFORCEABLE_RETENTION_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/**
 * The three periods Privacy Policy §6 has not yet fixed (performance-07).
 *
 * Read straight off `process.env` rather than through `loadEnv()`, which is the
 * house pattern for an opt-in knob that has no default and no validation the
 * app can do at boot (`SIGNUP_MAX_CONCURRENT_PROVISIONING` in
 * auth.controller.ts, `TRUSTED_PROXY_CIDRS` in platform/client-ip.ts). Unset is
 * the shipped state and is not an error: it means "nobody has published a
 * period for this table yet", and the run message says exactly that.
 */
const CONTROL_AUDIT_RETENTION_ENV = 'CONTROL_AUDIT_RETENTION_DAYS';
const EMAIL_BODY_RETENTION_ENV = 'EMAIL_OUTBOX_BODY_RETENTION_DAYS';
const SUPPORT_ATTEMPT_RETENTION_ENV = 'SUPPORT_ATTEMPT_RETENTION_DAYS';

/**
 * Blanking an e-mail body destroys the only copy of whatever link it carried.
 * With `EMAIL_DRIVER=console` — the shipped configuration — `AdminOutboxService`
 * is the ONLY way a librarian ever receives a verification or reset link, so
 * the body IS the delivery. Floor the period above the longest of those links
 * so a typo'd `EMAIL_OUTBOX_BODY_RETENTION_DAYS=0` cannot strand somebody
 * mid-verification. `+ 1` because the cutoff is measured from `createdAt` and a
 * whole-day period must clear a whole-day TTL.
 */
const EMAIL_BODY_MIN_RETENTION_DAYS =
  Math.ceil(LONGEST_ONE_TIME_LINK_TTL_SEC / (MS_PER_DAY / 1000)) + 1;

/**
 * Control-plane audit rows that are never swept, whatever the period says.
 *
 * `tenant.legal_accepted` is the Art. 7(1) evidence privacy-legal-09 exists to
 * create — who accepted which documents, at which digests, from which address.
 * Deleting it on a retention schedule would close one finding by re-opening
 * another, and it is the one row a regulator or a contract dispute actually
 * asks for. `tenant.deleted` is the same shape for the other direction: the
 * schema comment on `AuditEvent.tenant` (a `BEFORE DELETE` trigger redacts its
 * payload rather than cascading) calls it "the one event you most need to be
 * able to prove". Both are single rows per library, so keeping them forever
 * costs nothing the growth this limb is about.
 */
const CONTROL_AUDIT_KEEP_FOREVER = ['tenant.legal_accepted', 'tenant.deleted'];

/**
 * What a pruned `email_outbox` body is replaced with. `bodyMarkdown` is NOT
 * NULL, and an empty string in the admin outbox viewer reads as "this message
 * was blank", which is a different and wrong story.
 */
const EMAIL_BODY_PRUNED_MARKER = '_(Body removed by the retention sweep.)_';

/**
 * Resolve one of the §6 periods, or `null` for "not configured".
 *
 * Refuses anything that is not a whole number of days at or above `floorDays`,
 * loudly, and treats the limb as unconfigured — the same posture
 * `sweepTenantAuditLog` takes for a nonsense `audit_log_retention_days`. A
 * retention job acting on a value it does not understand is the one way it can
 * do more damage than not running at all.
 */
function configuredRetentionDays(envKey: string, floorDays: number): number | null {
  const raw = process.env[envKey]?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < floorDays) {
    logger.error(
      `refusing to enforce ${envKey}="${raw}": it must be a whole number of days, ` +
        `at least ${floorDays}. Nothing was deleted for that limb.`,
    );
    return null;
  }
  return days;
}

/** "N deleted past D days" / "not configured — see Privacy Policy §6". */
function limbReport(label: string, envKey: string, days: number | null, n: number): string {
  return days === null
    ? `${label}: not configured (${envKey} unset — Privacy Policy §6)`
    : `${label}: ${n} past ${days} days`;
}

/**
 * `n` months before `from`, in UTC. Month arithmetic, not `n * 30 * DAY`: the
 * notice says "12 months", and a librarian checking our arithmetic against the
 * published sentence should get the same date we did.
 */
function monthsBefore(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export async function sweepRetention(ctx?: JobContext): Promise<JobResult> {
  const now = new Date();
  let tenantsFailed = 0;

  // --- 1. Site applications (control plane) --------------------------------
  const applicationsPurged = await purgeExpiredApplications(now);

  // --- 1b. Stripe webhook bodies (control plane) ---------------------------
  const stripePayloadsPruned = await pruneStripeWebhookPayloads(now);

  // --- 1c. The three §6 tables (control plane) -----------------------------
  // Each resolves to `null` until the owner publishes a period; a null limb
  // runs no statement at all and reports itself as unconfigured.
  const controlAuditDays = configuredRetentionDays(
    CONTROL_AUDIT_RETENTION_ENV,
    MIN_ENFORCEABLE_RETENTION_DAYS,
  );
  const controlAuditRowsDeleted =
    controlAuditDays === null ? 0 : await sweepControlAuditLog(now, controlAuditDays);

  const emailBodyDays = configuredRetentionDays(
    EMAIL_BODY_RETENTION_ENV,
    EMAIL_BODY_MIN_RETENTION_DAYS,
  );
  const emailBodiesPruned =
    emailBodyDays === null ? 0 : await pruneEmailOutboxBodies(now, emailBodyDays);

  const supportAttemptDays = configuredRetentionDays(
    SUPPORT_ATTEMPT_RETENTION_ENV,
    MIN_ENFORCEABLE_RETENTION_DAYS,
  );
  const supportAttemptsDeleted =
    supportAttemptDays === null ? 0 : await sweepSupportRedemptionAttempts(now, supportAttemptDays);

  // --- 2. Per-tenant audit log ---------------------------------------------
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  // Same rule as every other sweep: never mint a Redis client and use it in the
  // same breath. The client is built with `enableOfflineQueue: false`, so the
  // first command on a still-connecting socket rejects and the whole tick falls
  // into the catch (reliability-01 / -16). Prefer the runner's warm client.
  const redis = ctx?.redis ?? new RedisService();
  const ownedRedis = ctx?.redis ? null : redis;

  let auditRowsDeleted = 0;
  let tenantsUnlimited = 0;
  let tenantsDeferred = 0;
  try {
    await redis.ready();
    const plans = new EffectivePlanService(redis, new PlatformSettingsService(redis));
    for (const t of tenants) {
      // The one-connection-per-tenant pin lives in the service's 'worker' role
      // now, not in this URL (performance-06: the old `connection_limit=1`
      // query parameter was silently ignored by Prisma 7's driver adapter).
      // Constructed INSIDE the per-tenant try. `tenantContextFrom` throws for a
      // tenant with no sealed database credential (tenant-isolation-02), and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one — turning a single tenant's missing row into a
      // fleet-wide outage of the nightly job. The counter below is what that
      // case is for.
      try {
        const tenantCtx: TenantContext = tenantContextFrom(t);
        const res = await sweepTenantAuditLog(tenantCtx, tenantPrisma, plans, now);
        auditRowsDeleted += res.deleted;
        if (res.unlimited) tenantsUnlimited++;
        if (res.deferred) tenantsDeferred++;
      } catch (err) {
        // Counted under a `…Failed` key so a tenant whose DB is unreachable
        // makes the run NOT ok on /healthz, instead of the sweep reporting a
        // clean "0 rows" forever.
        tenantsFailed++;
        logger.warn(`retention sweep failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await ownedRedis?.onModuleDestroy().catch(() => undefined);
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  const parts: string[] = [
    `applications: ${applicationsPurged} deleted past ${APPLICATION_RETENTION_MONTHS} months`,
    `stripe payloads: ${stripePayloadsPruned} pruned past ${STRIPE_PAYLOAD_RETENTION_DAYS} days`,
    `audit_log: ${auditRowsDeleted} row(s) across ${tenants.length} tenant(s)`,
    limbReport(
      'control audit_log',
      CONTROL_AUDIT_RETENTION_ENV,
      controlAuditDays,
      controlAuditRowsDeleted,
    ),
    limbReport('email bodies', EMAIL_BODY_RETENTION_ENV, emailBodyDays, emailBodiesPruned),
    limbReport(
      'support attempts',
      SUPPORT_ATTEMPT_RETENTION_ENV,
      supportAttemptDays,
      supportAttemptsDeleted,
    ),
  ];
  if (tenantsUnlimited > 0) {
    parts.push(`${tenantsUnlimited} tenant(s) on unlimited retention — nothing to enforce`);
  }
  if (tenantsDeferred > 0) {
    parts.push(`${tenantsDeferred} tenant(s) hit the per-tick batch cap; resuming next run`);
  }

  return {
    message: parts.join('; '),
    counts: {
      applicationsPurged,
      stripePayloadsPruned,
      auditRowsDeleted,
      controlAuditRowsDeleted,
      emailBodiesPruned,
      supportAttemptsDeleted,
      tenantsScanned: tenants.length,
      tenantsUnlimited,
      tenantsDeferred,
      tenantsFailed,
    },
  };
}

/**
 * Enforce `CONTROL_AUDIT_RETENTION_DAYS` on the platform-wide `audit_log`
 * (performance-07).
 *
 * This is the control-plane table, not the per-tenant one `sweepTenantAuditLog`
 * handles — every library on the box writes into it, nothing ever removed a row,
 * and it carries `ip` and `userAgent` on each. Batched raw DELETE for the same
 * reason as the tenant sweep: Prisma cannot put a LIMIT on a delete, and the
 * first run after a period is finally published could be the whole history.
 *
 * `CONTROL_AUDIT_KEEP_FOREVER` is subtracted in the statement rather than
 * filtered afterwards, so the rows it names are never even selected as
 * candidates.
 */
async function sweepControlAuditLog(now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
  let deleted = 0;
  for (let batch = 0; batch < AUDIT_MAX_BATCHES; batch++) {
    const n = await controlDb.$executeRaw`
      DELETE FROM "audit_log"
       WHERE "id" IN (
         SELECT "id" FROM "audit_log"
          WHERE "occurredAt" < ${cutoff}
            AND NOT ("action" = ANY (${CONTROL_AUDIT_KEEP_FOREVER}::text[]))
          ORDER BY "occurredAt"
          LIMIT ${AUDIT_DELETE_BATCH}
       )`;
    deleted += n;
    if (n < AUDIT_DELETE_BATCH) break;
  }
  if (deleted > 0) {
    logger.log(
      `deleted ${deleted} control-plane audit row(s) older than ${days} day(s) ` +
        `(before ${cutoff.toISOString()})`,
    );
  }
  return deleted;
}

/**
 * Enforce `EMAIL_OUTBOX_BODY_RETENTION_DAYS` (performance-07).
 *
 * THE BODY, NOT THE ROW — and this one is not a preference. `idempotencyKey` is
 * `@unique` and IS the deduplication ledger: `member-notifications.job.ts` keys
 * the overdue reminder on `dayKey(now)` and relies on the insert failing when
 * the row already exists. Delete the row and the next hourly tick re-sends every
 * notice it has ever sent, to real patrons. So the envelope stays and only
 * `bodyMarkdown` — which is ~all of the bytes, and the reason this is the
 * fastest-growing table in the control plane at one full-body row per overdue
 * loan per day — is replaced.
 *
 * ONLY `delivered` AND `dead`. A `failed` row is one the worker will pick up
 * again and the body is what it would send; a `pending` / `sending` row has not
 * been sent at all. Blanking either would turn a retry into a delivery of the
 * marker text.
 *
 * The `<> marker` term is what makes a second run a no-op.
 */
async function pruneEmailOutboxBodies(now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
  let pruned = 0;
  for (let batch = 0; batch < AUDIT_MAX_BATCHES; batch++) {
    const n = await controlDb.$executeRaw`
      UPDATE "email_outbox"
         SET "bodyMarkdown" = ${EMAIL_BODY_PRUNED_MARKER}
       WHERE "id" IN (
         SELECT "id" FROM "email_outbox"
          WHERE "createdAt" < ${cutoff}
            AND "status" IN ('delivered', 'dead')
            AND "bodyMarkdown" <> ${EMAIL_BODY_PRUNED_MARKER}
          ORDER BY "createdAt"
          LIMIT ${AUDIT_DELETE_BATCH}
       )`;
    pruned += n;
    if (n < AUDIT_DELETE_BATCH) break;
  }
  if (pruned > 0) {
    logger.log(
      `removed the body of ${pruned} sent e-mail(s) created before ` +
        `${cutoff.toISOString().slice(0, 10)}`,
    );
  }
  return pruned;
}

/**
 * Enforce `SUPPORT_ATTEMPT_RETENTION_DAYS` (performance-07).
 *
 * `support_redemption_attempts` records one row per support-key redemption
 * attempt, successful or not, each carrying the admin's IP address. It exists so
 * scanning behaviour is visible; once a period has passed it is personal data
 * with no remaining purpose. Rows are tiny and the table only grows with
 * operator activity, so this is the smallest of the three limbs — it is here
 * because the finding named it and because an IP address with no purpose is a
 * §6 matter, not because of disk.
 */
async function sweepSupportRedemptionAttempts(now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
  let deleted = 0;
  for (let batch = 0; batch < AUDIT_MAX_BATCHES; batch++) {
    const n = await controlDb.$executeRaw`
      DELETE FROM "support_redemption_attempts"
       WHERE "id" IN (
         SELECT "id" FROM "support_redemption_attempts"
          WHERE "ts" < ${cutoff}
          ORDER BY "ts"
          LIMIT ${AUDIT_DELETE_BATCH}
       )`;
    deleted += n;
    if (n < AUDIT_DELETE_BATCH) break;
  }
  if (deleted > 0) {
    logger.log(
      `deleted ${deleted} support redemption attempt(s) older than ${days} day(s) ` +
        `(before ${cutoff.toISOString()})`,
    );
  }
  return deleted;
}

/**
 * Delete site applications that never became a partnership, 12 months after our
 * last contact with them.
 *
 * `reviewedAt` is "when we last acted on it" and is the notice's «μετά την
 * επικοινωνία μας»; a row nobody ever touched falls back to `createdAt`, which
 * is the outer bound the same sentence promises ("at the latest"). `accepted`
 * rows are kept on purpose — the notice says those details move into the
 * library's account and live under the service agreement instead.
 */
async function purgeExpiredApplications(now: Date): Promise<number> {
  const cutoff = monthsBefore(now, APPLICATION_RETENTION_MONTHS);
  const where = {
    status: { not: 'accepted' as const },
    OR: [
      { reviewedAt: { not: null, lt: cutoff } },
      { reviewedAt: null, createdAt: { lt: cutoff } },
    ],
  };

  // privacy-legal-14, the half the first pass left behind. Submitting the form
  // writes the applicant TWICE: the `applications` row, and an admin
  // notification in `email_outbox` whose body restates their name, e-mail,
  // phone and message and whose envelope keeps their address in `replyToEmail`.
  // Deleting only the first left the second sitting in the control plane —
  // inside every nightly backup — after we had published that their details
  // would be gone. So the ids are read first and their notifications go with
  // them, in that order: a crash between the two statements leaves the
  // application row present and the sweep simply finishes the job next tick,
  // whereas the reverse order would leave a row we can no longer find the
  // notification for.
  const doomed = await controlDb.application.findMany({ where, select: { id: true } });
  if (doomed.length === 0) return 0;

  const notifications = await controlDb.emailOutbox.deleteMany({
    where: { idempotencyKey: { in: doomed.map((a) => applicationNotifyKey(a.id)) } },
  });
  const res = await controlDb.application.deleteMany({
    where: { id: { in: doomed.map((a) => a.id) } },
  });
  if (res.count > 0) {
    logger.log(
      `deleted ${res.count} application(s) last contacted before ${cutoff.toISOString().slice(0, 10)}, ` +
        `with ${notifications.count} admin notification(s)`,
    );
  }
  return res.count;
}

/**
 * Clear the raw Stripe event body once the 30 days the schema promises have
 * run out (performance-07).
 *
 * WHY THE BODY AND NOT THE ROW. `persistEvent` in stripe-webhook.controller.ts
 * reads `processedAt` off this row as the durable "have we finished this one
 * before?" guard — the one that still works when Redis is down, since the
 * `stripe:event:<id>` lock expires at 30 days too. Delete the row and a
 * >30-day-old redelivery (an operator's "Resend" from the Stripe Dashboard)
 * would be dispatched a second time, writing a stale subscription payload over
 * the current one. Keeping a ~100-byte ledger row forever is a much better
 * trade than re-arming that, and it still removes the growth the finding is
 * about: the body is the other ~2 KB.
 *
 * WHY ONLY PROCESSED ROWS. A row with `processedAt IS NULL` past the retry
 * sweep's give-up budget is counted as `abandoned` — it is money work that
 * never completed, sitting on an operator's to-do list, and its payload is the
 * only thing they can replay from. Those keep their body until somebody deals
 * with them. That means the table is bounded by its processed rows, not
 * absolutely; the unprocessed ones are already surfaced by
 * stripe-retry.job.ts's `abandoned` count.
 *
 * Batched and idempotent. The `payloadJson <> '{}'` term is what makes a second
 * run a no-op, and it is also the partial-index predicate
 * (`stripe_webhook_events_prunable_idx`, migration
 * 20260826113000_stripe_webhook_payload_retention), so a pruned row leaves the
 * work queue: steady state is a 2-buffer Bitmap Index Scan instead of a
 * 12,902-buffer sequential scan of the shared control database.
 */
export const STRIPE_PAYLOAD_RETENTION_DAYS = 30;
const STRIPE_PAYLOAD_BATCH = 5_000;
const STRIPE_PAYLOAD_MAX_BATCHES = 40;

async function pruneStripeWebhookPayloads(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STRIPE_PAYLOAD_RETENTION_DAYS * MS_PER_DAY);
  let pruned = 0;
  for (let batch = 0; batch < STRIPE_PAYLOAD_MAX_BATCHES; batch++) {
    const n = await controlDb.$executeRaw`
      UPDATE "stripe_webhook_events"
         SET "payloadJson" = '{}'::jsonb
       WHERE "id" IN (
         SELECT "id" FROM "stripe_webhook_events"
          WHERE "receivedAt" < ${cutoff}
            AND "processedAt" IS NOT NULL
            AND "payloadJson" <> '{}'::jsonb
          ORDER BY "receivedAt"
          LIMIT ${STRIPE_PAYLOAD_BATCH}
       )`;
    pruned += n;
    if (n < STRIPE_PAYLOAD_BATCH) break;
  }
  if (pruned > 0) {
    logger.log(
      `pruned the body of ${pruned} stripe webhook event(s) received before ` +
        `${cutoff.toISOString().slice(0, 10)}`,
    );
  }
  return pruned;
}

/**
 * Enforce one tenant's `audit_log_retention_days`.
 *
 * Raw batched DELETE rather than `deleteMany`: Prisma cannot put a LIMIT on a
 * delete, and the first sweep of a long-lived library can be millions of rows.
 */
async function sweepTenantAuditLog(
  tenant: TenantContext,
  tenantPrisma: TenantPrismaService,
  plans: EffectivePlanService,
  now: Date,
): Promise<{ deleted: number; unlimited: boolean; deferred: boolean }> {
  const days = await plans.getInt(tenant.id, 'audit_log_retention_days');
  // The sentinel means "no ceiling" — ASK, never do arithmetic on it (a
  // `now - UNLIMITED_INT * MS_PER_DAY` cutoff is a NaN date away from a
  // `WHERE occurredAt < Invalid Date` that deletes nothing, or everything).
  if (isUnlimitedInt(days)) return { deleted: 0, unlimited: true, deferred: false };
  if (!Number.isFinite(days) || days < MIN_ENFORCEABLE_RETENTION_DAYS) {
    logger.error(
      `refusing to enforce audit_log_retention_days=${days} for tenant=${tenant.slug}: ` +
        `a retention under ${MIN_ENFORCEABLE_RETENTION_DAYS} day would erase the whole audit log. ` +
        `Fix the plan feature value.`,
    );
    return { deleted: 0, unlimited: false, deferred: false };
  }

  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
  const client = tenantPrisma.getClient(tenant);
  let deleted = 0;
  let batches = 0;
  for (; batches < AUDIT_MAX_BATCHES; batches++) {
    const n = await client.$executeRaw`
      DELETE FROM "audit_log"
       WHERE "id" IN (
         SELECT "id" FROM "audit_log"
          WHERE "occurredAt" < ${cutoff}
          ORDER BY "occurredAt"
          LIMIT ${AUDIT_DELETE_BATCH}
       )`;
    deleted += n;
    if (n < AUDIT_DELETE_BATCH) break;
  }
  if (deleted > 0) {
    logger.log(
      `tenant=${tenant.slug}: deleted ${deleted} audit row(s) older than ${days} day(s) ` +
        `(before ${cutoff.toISOString()})`,
    );
  }
  return { deleted, unlimited: false, deferred: batches >= AUDIT_MAX_BATCHES };
}
