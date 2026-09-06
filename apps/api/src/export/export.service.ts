import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { ExportFormat, ExportJob, ExportScope } from '@libriant/db-control';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { ExportQueueService } from './export-queue.service.js';
import { EXPORT_TTL_HOURS } from './export.constants.js';
import { TENANT_RUNTIME_SELECT, type TenantRuntimeRow } from '../tenancy/tenant-db-url.js';
import {
  discloseAdminExport,
  notifyLibraryOfExport,
  requireTenantExportConsent,
  type ExportConsent,
  type ExportRequester,
} from './export-consent.js';

/**
 * Response shape — never exposes the on-disk `filePath`.
 *
 * `requestedByKind` is part of it (privacy-legal-07). A library's own export
 * list at `GET /t/:slug/exports` selects on `targetTenantId` with no filter on
 * the requester, so a Libriant-staff export of that library already appeared
 * there — but stripped of every attribution, indistinguishable from an export a
 * librarian started themselves. A detection channel that cannot tell you WHO is
 * not a detection channel.
 */
export function publicExportJob(job: ExportJob) {
  return {
    id: job.id,
    format: job.format,
    scope: job.scope,
    targetTenantId: job.targetTenantId,
    requestedByKind: job.requestedByKind,
    status: job.status,
    progressDone: job.progressDone,
    progressTotal: job.progressTotal,
    fileName: job.fileName,
    fileBytes: job.fileBytes,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  };
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @Inject(ExportQueueService) private readonly queue: ExportQueueService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    // EmailModule is @Global, so this needs no import in ExportModule.
    @Inject(EmailService) private readonly emails: EmailService,
  ) {}

  // EXP-004: control/all-scope dumps contain the whole platform's (redacted but
  // still highly sensitive) control data, so they live for a shorter window
  // than a single library's tenant export before the cleanup sweep purges them.
  private static readonly CONTROL_TTL_HOURS = 2;

  private expiry(scope?: ExportScope): Date {
    const hours =
      scope === 'control' || scope === 'all' ? ExportService.CONTROL_TTL_HOURS : EXPORT_TTL_HOURS;
    return new Date(Date.now() + hours * 3_600_000);
  }

  async createForTenant(
    tenantId: string,
    userId: string,
    format: ExportFormat,
  ): Promise<ExportJob> {
    // Per-tenant cap (export-new-No-per-tenant-cap): the export worker runs at
    // concurrency 1 platform-wide, so a single tenant must not be able to flood
    // the queue and starve everyone else. At most one in-flight export per
    // library — they can start another once it finishes.
    const inFlight = await controlDb.exportJob.count({
      where: {
        targetTenantId: tenantId,
        scope: 'tenant',
        status: { in: ['queued', 'running'] },
      },
    });
    if (inFlight > 0) {
      throw new BadRequestException(
        'An export for this library is already in progress — wait for it to finish before starting another.',
      );
    }
    const job = await controlDb.exportJob.create({
      data: {
        format,
        scope: 'tenant',
        targetTenantId: tenantId,
        requestedByKind: 'user',
        requestedById: userId,
        status: 'queued',
        expiresAt: this.expiry(),
      },
    });
    await this.queue.enqueue(job.id);
    return job;
  }

  /**
   * Libriant-staff export: one library, the control DB, or everything.
   *
   * `requester` is a REQUIRED object rather than a bare `adminId` string on
   * purpose. The ip / user-agent it carries are what make the control-plane
   * audit row worth having, and an optional field on the end of the old
   * signature is one the next caller forgets to pass — the whole endpoint would
   * then compile, log, and record nothing about where the request came from.
   *
   * See `export-consent.ts` for the consent model and why a tenant-scoped
   * export is held to the same bar as support impersonation (privacy-legal-07).
   */
  async createForAdmin(
    requester: ExportRequester,
    input: { format: ExportFormat; scope: ExportScope; tenantId?: string },
  ): Promise<ExportJob> {
    let tenant: (TenantRuntimeRow & { slug: string }) | null = null;
    let consent: ExportConsent | null = null;
    if (input.scope === 'tenant') {
      if (!input.tenantId) {
        throw new BadRequestException('A tenant is required when scope is "tenant".');
      }
      const t = await controlDb.tenant.findUnique({
        where: { id: input.tenantId },
        select: TENANT_RUNTIME_SELECT,
      });
      if (!t) throw new NotFoundException('Tenant not found.');
      tenant = t;
      // Gate BEFORE the job row exists: a refused export must leave no trace of
      // having been half-started.
      consent = await requireTenantExportConsent(t.id, requester);
    }
    const job = await controlDb.exportJob.create({
      data: {
        format: input.format,
        scope: input.scope,
        targetTenantId: tenant?.id ?? null,
        requestedByKind: 'admin',
        requestedById: requester.adminId,
        status: 'queued',
        expiresAt: this.expiry(input.scope),
      },
    });

    // Disclose, THEN enqueue. The whole finding is "the export leaves no trace
    // the library can see", so an export that runs while its record failed to
    // write would be the same defect wearing this function's clothes. If the
    // disclosure throws, the job is deleted again and never reaches the queue —
    // it has not started, so nothing is lost by refusing.
    try {
      await discloseAdminExport(this.tenantPrisma, job, requester, consent, tenant);
    } catch (err) {
      await controlDb.exportJob.delete({ where: { id: job.id } }).catch(() => undefined);
      this.logger.error(
        `refusing admin export (scope=${input.scope}, tenant=${tenant?.slug ?? '-'}): ` +
          `could not record it — ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    // Third channel, best-effort by design: EMAIL_DRIVER ships as `console`, so
    // nothing here may decide whether the export runs. See notifyLibraryOfExport.
    await notifyLibraryOfExport(this.emails, job, requester, consent).catch((err: unknown) =>
      this.logger.warn(
        `export disclosure e-mail could not be enqueued for job ${job.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ),
    );

    await this.queue.enqueue(job.id);
    return job;
  }

  listForTenant(tenantId: string): Promise<ExportJob[]> {
    return controlDb.exportJob.findMany({
      where: { targetTenantId: tenantId, scope: 'tenant' },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
  }

  listForAdmin(): Promise<ExportJob[]> {
    return controlDb.exportJob.findMany({ orderBy: { createdAt: 'desc' }, take: 25 });
  }

  async get(id: string): Promise<ExportJob> {
    const job = await controlDb.exportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Export not found.');
    return job;
  }
}
