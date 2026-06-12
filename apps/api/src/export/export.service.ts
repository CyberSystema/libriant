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

  private expiry(): Date {
    return new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000);
  }

  async createForTenant(
    tenantId: string,
    userId: string,
    format: ExportFormat,
  ): Promise<ExportJob> {
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
        expiresAt: this.expiry(),
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
