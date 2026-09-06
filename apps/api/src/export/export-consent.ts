import { ForbiddenException, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { ExportJob, Prisma } from '@libriant/db-control';
import type { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  TENANT_RUNTIME_SELECT,
  runtimeDbUrl,
  type TenantRuntimeRow,
} from '../tenancy/tenant-db-url.js';

const logger = new Logger('ExportConsent');

/**
 * Consent + disclosure for a Libriant-staff (owner-admin) database export.
 *
 * ## The failure this exists for (privacy-legal-07)
 *
 * `POST /admin/exports` was gated on `@AdminRoles('owner')` and nothing else.
 * `createForAdmin` inserted an `export_jobs` row and enqueued the job: no
 * control-plane `audit_log` row, no row in the library's own `audit_log`, no
 * notice. The same platform can only IMPERSONATE a library user after the
 * library itself issues a `SupportKey` — bcrypt-hashed, single-use, expiring —
 * and every impersonated request is written to `support_action_log` *and* the
 * library's own audit log. Export sat beside that model and yielded strictly
 * more data than impersonation does: the complete members / loans /
 * reservations / fines tables in one file, in one request.
 *
 * ## Why export is NOT held to a weaker bar than impersonation
 *
 * The obvious counter-argument — the one the audit's own verification makes —
 * is that a platform owner-admin already holds the control-plane and per-tenant
 * database credentials, so `/admin/exports` is a convenience over `psql` rather
 * than a privilege they otherwise lack. That is true, and it is exactly why the
 * defect is a governance gap rather than an access-control breach. It is not a
 * reason to gate the endpoint more weakly:
 *
 *   - Under DPA §3.1 we may process Controller Personal Data only on the
 *     library's documented instructions. A tenant-issued support key IS a
 *     documented instruction; an admin's own initiative is not. The gate is
 *     what turns "we could" into "they asked".
 *   - DPA §9 promises the information necessary to demonstrate Art. 28
 *     compliance. For an unlogged export there is nothing to give.
 *   - `psql` remains available to whoever holds the credentials. Nothing here
 *     claims to stop a determined operator — it removes the *unrecorded,
 *     one-click* path, which is the one that gets used casually.
 *
 * So `scope: 'tenant'` — one named library's whole database — requires the same
 * tenant-issued consent as impersonation, and is disclosed in the same two
 * ledgers. `scope: 'control'` and `scope: 'all'` cannot be consented to by any
 * single library and are handled below on their own terms.
 *
 * ## This is not in tension with the `export-write` impersonation deny rule
 *
 * `impersonation-policy.ts` REFUSES `POST /t/:slug/exports` inside a support
 * window ("the archive would outlive this window"). It refuses that because an
 * impersonated export is indistinguishable from one a librarian started: it
 * lands in `export_jobs` as `requestedByKind: 'user'` against a tenant user id,
 * so nobody could later tell who took it. The admin path here is the opposite —
 * `requestedByKind: 'admin'`, a named `AdminUser`, two audit rows, an e-mail,
 * and a second audit row when the file is actually fetched. Same window, but
 * attributable. The two rules together say: Libriant staff may take a copy
 * during a consented window, and may never take one anonymously.
 */

/** Who asked for the export, and from where. */
export type ExportRequester = {
  adminId: string;
  ip?: string;
  userAgent?: string;
};

/** The tenant-issued support session that authorises a `scope: 'tenant'` export. */
export type ExportConsent = {
  supportSessionId: string;
  supportSessionExpiresAt: Date;
};

/**
 * Refuse a single-library export unless the library has an active support
 * session open for THIS admin — i.e. a librarian generated a support key and
 * this admin redeemed it, which is the product's existing, tested expression of
 * "the library asked us to look".
 *
 * Deliberately queried here rather than through `SupportSessionService`: that
 * service resolves a session by id (it is built for the impersonation cookie),
 * and export needs the inverse lookup — "is there one for this tenant+admin".
 * Adding a method there would put the export gate in another module's file,
 * where the next reader of `createForAdmin` would not find it.
 */
export async function requireTenantExportConsent(
  tenantId: string,
  requester: ExportRequester,
): Promise<ExportConsent> {
  const session = await controlDb.supportSession.findFirst({
    where: {
      tenantId,
      adminId: requester.adminId,
      endedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { startedAt: 'desc' },
    select: { id: true, expiresAt: true },
  });
  if (!session) {
    throw new ForbiddenException(
      'Exporting a library’s database needs that library’s consent. Ask the library to ' +
        'generate a support key (Settings → Support access), redeem it, then start the ' +
        'export from inside the support session. The export is recorded in the library’s ' +
        'own audit log either way.',
    );
  }
  return { supportSessionId: session.id, supportSessionExpiresAt: session.expiresAt };
}

/** The tenant-visible audit action. Same verb both sides of the fence. */
export const EXPORT_AUDIT_ACTION = 'tenant.exported';
/** Control-plane action for a `control` / `all` scoped dump (no single tenant). */
export const PLATFORM_EXPORT_AUDIT_ACTION = 'platform.exported';

type Notified = { tenantId: string; slug: string; ok: boolean; error?: string };

/**
 * Write the row the LIBRARY can see, into the library's own `audit_log`.
 *
 * Not `TenantAuditService`: that writer is best-effort by design (a failed
 * audit row must never turn a successful checkout into a 500) and this call
 * site needs the opposite posture. Losing the row here means a copy of a
 * library's member registry was taken and the library was never told — the
 * precise defect being fixed — so the caller treats a throw as fatal for
 * `scope: 'tenant'` and refuses to enqueue the export.
 */
async function recordTenantSideExport(
  tenantPrisma: TenantPrismaService,
  tenant: TenantRuntimeRow & { slug: string },
  job: ExportJob,
  requester: ExportRequester,
  consent: ExportConsent | null,
  adminLabel: string | null,
): Promise<void> {
  const client = tenantPrisma.getClient({ id: tenant.id, dbUrl: runtimeDbUrl(tenant) });
  await client.auditEvent.create({
    data: {
      actorType: 'admin',
      actorId: requester.adminId,
      action: EXPORT_AUDIT_ACTION,
      targetType: 'export',
      targetId: job.id,
      afterJson: {
        // Everything a librarian needs to challenge this without asking us:
        // what was taken, by whom, under which consent, and how long the file
        // lives before the cleanup sweep purges it.
        scope: job.scope,
        format: job.format,
        requestedBy: 'libriant_staff',
        requestedByName: adminLabel,
        supportSessionId: consent?.supportSessionId ?? null,
        fileExpiresAt: job.expiresAt?.toISOString() ?? null,
        requestedFromIp: requester.ip ?? null,
      } as Prisma.InputJsonValue,
      // Stamps the row `viaSupport: true` in GET /t/:slug/audit. NULL for a
      // platform-wide dump, which no single library consented to.
      supportSessionId: consent?.supportSessionId ?? null,
    },
  });
}

/**
 * Tell every library included in a `scope: 'all'` dump.
 *
 * `all` copies the control database AND every non-archived tenant database into
 * one artifact, so every one of those libraries has had its member registry
 * taken — but no single library can consent on behalf of the others, and there
 * is no support session to attach. The honest position is: keep the capability
 * (the operator holds the credentials regardless), and make it visible in every
 * audit log it touches.
 *
 * Best-effort PER TENANT, unlike the single-tenant path: one unreachable tenant
 * database must not veto a platform-wide operation that has already been
 * recorded in the control plane. Which libraries could not be told is itself
 * recorded, in the control-plane row, so a silent partial notification is not
 * possible.
 */
async function fanOutPlatformExport(
  tenantPrisma: TenantPrismaService,
  job: ExportJob,
  requester: ExportRequester,
  adminLabel: string | null,
): Promise<Notified[]> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: { not: 'archived' } },
    select: TENANT_RUNTIME_SELECT,
    orderBy: { slug: 'asc' },
  });
  const results: Notified[] = [];
  for (const t of tenants) {
    try {
      await recordTenantSideExport(tenantPrisma, t, job, requester, null, adminLabel);
      results.push({ tenantId: t.id, slug: t.slug, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`could not record export ${job.id} in tenant ${t.slug}: ${message}`);
      results.push({ tenantId: t.id, slug: t.slug, ok: false, error: message });
    }
  }
  return results;
}

/**
 * Record an admin export in BOTH ledgers, and refuse the export if the record
 * cannot be written.
 *
 * The control-plane row is mandatory for every scope. That is safe to make
 * mandatory rather than best-effort — the house style elsewhere — because it
 * goes to the same database as the `export_jobs` row the caller just created:
 * if this write is failing, the job row could not have been created either, so
 * no new failure domain is introduced.
 *
 * Returns nothing; throws if the mandatory part could not be recorded. The
 * caller is responsible for not enqueueing the job in that case.
 */
export async function discloseAdminExport(
  tenantPrisma: TenantPrismaService,
  job: ExportJob,
  requester: ExportRequester,
  consent: ExportConsent | null,
  tenant: (TenantRuntimeRow & { slug: string }) | null,
): Promise<void> {
  // Resolved once so the librarian's audit row names a human, not a cuid they
  // have no way to look up.
  const admin = await controlDb.adminUser.findUnique({
    where: { id: requester.adminId },
    select: { fullName: true, email: true },
  });
  const adminLabel = admin?.fullName || admin?.email || null;

  let notified: Notified[] | null = null;
  if (job.scope === 'tenant') {
    if (!tenant) throw new Error('tenant-scoped export disclosed without a tenant');
    // Mandatory: see recordTenantSideExport's docblock.
    await recordTenantSideExport(tenantPrisma, tenant, job, requester, consent, adminLabel);
    notified = [{ tenantId: tenant.id, slug: tenant.slug, ok: true }];
  } else if (job.scope === 'all') {
    notified = await fanOutPlatformExport(tenantPrisma, job, requester, adminLabel);
  }
  // scope === 'control' touches no tenant database, so there is nobody to tell
  // beyond the control-plane row written below.

  await controlDb.auditEvent.create({
    data: {
      tenantId: job.targetTenantId,
      actorType: 'admin',
      actorId: requester.adminId,
      action: job.scope === 'tenant' ? EXPORT_AUDIT_ACTION : PLATFORM_EXPORT_AUDIT_ACTION,
      targetType: 'export',
      targetId: job.id,
      afterJson: {
        scope: job.scope,
        format: job.format,
        targetTenantId: job.targetTenantId,
        supportSessionId: consent?.supportSessionId ?? null,
        fileExpiresAt: job.expiresAt?.toISOString() ?? null,
        // Which libraries were told, and which could not be. A partial
        // notification that nobody can see would put the finding straight back.
        tenantsNotified: notified ? notified.filter((n) => n.ok).length : 0,
        tenantsNotFound: notified ? notified.filter((n) => !n.ok).map((n) => n.slug) : [],
      } as Prisma.InputJsonValue,
      ip: requester.ip ?? null,
      userAgent: requester.userAgent ?? null,
    },
  });
}

/**
 * E-mail the library's registered contact that Libriant took a copy.
 *
 * The finding's fix asks for this, and it is worth having, but it is
 * deliberately the WEAKEST of the three channels and nothing depends on it:
 * `EMAIL_DRIVER` ships as `console`, so today this enqueues an outbox row that
 * is logged and never delivered. The record the library can actually rely on is
 * the row in its own `audit_log`, which is written first and is mandatory.
 *
 * Best-effort, therefore, and after the mandatory disclosure: an outbox hiccup
 * must not refuse an export that has already been properly recorded.
 *
 * Uses the generic `transactional` kind rather than a new `EmailMessageKind`
 * value: adding one is a control-plane enum migration, and the disclosure does
 * not need its own kind to be delivered.
 */
export async function notifyLibraryOfExport(
  emails: { enqueue: (input: NotifyInput) => Promise<unknown> },
  job: ExportJob,
  requester: ExportRequester,
  consent: ExportConsent | null,
): Promise<void> {
  if (job.scope === 'control') return;
  const tenants = await controlDb.tenant.findMany({
    where:
      job.scope === 'tenant' ? { id: job.targetTenantId ?? '' } : { status: { not: 'archived' } },
    select: { id: true, name: true, slug: true, primaryEmail: true, defaultLocale: true },
  });
  const admin = await controlDb.adminUser.findUnique({
    where: { id: requester.adminId },
    select: { fullName: true, email: true },
  });
  const who = admin?.fullName ? `${admin.fullName} (${admin.email})` : 'A Libriant administrator';

  for (const t of tenants) {
    if (!t.primaryEmail) continue;
    const what =
      job.scope === 'tenant'
        ? `a complete copy of ${t.name}'s database`
        : `a platform-wide backup that includes ${t.name}'s database`;
    const body = [
      `Hi,`,
      ``,
      `${who} exported ${what} from Libriant.`,
      ``,
      `  Format:  ${job.format}`,
      `  Scope:   ${job.scope}`,
      `  Started: ${job.createdAt.toUTCString()}`,
      consent
        ? `  Consent: your support session ${consent.supportSessionId}`
        : `  Consent: platform-wide operation — no support session`,
      ``,
      `This is also recorded in your library's own activity log, where you can`,
      `see it at any time. If you were not expecting it, reply to this message`,
      `and end any open support session from Settings → Support access.`,
      ``,
      `— Libriant`,
    ].join('\n');
    await emails.enqueue({
      // One mail per export per library, so a retried request cannot spam them.
      idempotencyKey: `export.disclosed:${job.id}:${t.id}`,
      kind: 'transactional',
      toEmail: t.primaryEmail,
      tenantId: t.id,
      subject: `[${t.name}] Libriant exported your library's data`,
      bodyMarkdown: body,
      metadata: { exportJobId: job.id, scope: job.scope, adminId: requester.adminId },
    });
  }
}

/** Structural shape of `EmailService.enqueue`'s input — see the note above. */
type NotifyInput = {
  kind: 'transactional';
  toEmail: string;
  subject: string;
  bodyMarkdown: string;
  idempotencyKey?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Record an admin DOWNLOAD of a produced export file.
 *
 * Creating the job and fetching the bytes are separate acts, hours apart, and
 * the artifact outlives the support session that authorised it (24 h for a
 * tenant export, 2 h for control/all). Awaited before the stream starts, so a
 * download that happened is a download that is on the record.
 */
export async function recordAdminExportDownload(
  job: ExportJob,
  requester: ExportRequester,
): Promise<void> {
  await controlDb.auditEvent.create({
    data: {
      tenantId: job.targetTenantId,
      actorType: 'admin',
      actorId: requester.adminId,
      action: 'export.downloaded',
      targetType: 'export',
      targetId: job.id,
      afterJson: {
        scope: job.scope,
        format: job.format,
        fileName: job.fileName,
        fileBytes: job.fileBytes,
      } as Prisma.InputJsonValue,
      ip: requester.ip ?? null,
      userAgent: requester.userAgent ?? null,
    },
  });
}
