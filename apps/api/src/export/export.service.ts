import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { ExportFormat, ExportJob, ExportScope } from '@libriant/db-control';
import { ExportQueueService } from './export-queue.service.js';
import { EXPORT_TTL_HOURS } from './export.constants.js';

/** Response shape — never exposes the on-disk `filePath`. */
export function publicExportJob(job: ExportJob) {
  return {
    id: job.id,
    format: job.format,
    scope: job.scope,
    targetTenantId: job.targetTenantId,
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
  constructor(@Inject(ExportQueueService) private readonly queue: ExportQueueService) {}

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

  async createForAdmin(
    adminId: string,
    input: { format: ExportFormat; scope: ExportScope; tenantId?: string },
  ): Promise<ExportJob> {
    let targetTenantId: string | null = null;
    if (input.scope === 'tenant') {
      if (!input.tenantId) {
        throw new BadRequestException('A tenant is required when scope is "tenant".');
      }
      const t = await controlDb.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true },
      });
      if (!t) throw new NotFoundException('Tenant not found.');
      targetTenantId = t.id;
    }
    const job = await controlDb.exportJob.create({
      data: {
        format: input.format,
        scope: input.scope,
        targetTenantId,
        requestedByKind: 'admin',
        requestedById: adminId,
        status: 'queued',
        expiresAt: this.expiry(input.scope),
      },
    });
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
