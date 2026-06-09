import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { MaintenanceKind, MaintenanceRun, MaintenanceScope } from '@libriant/db-control';
import { MaintenanceQueueService } from './maintenance-queue.service.js';

@Injectable()
export class MaintenanceService {
  constructor(@Inject(MaintenanceQueueService) private readonly queue: MaintenanceQueueService) {}

  /** Create + enqueue a maintenance run. The worker picks it up and streams
   *  progress into the same row. */
  async start(input: {
    kind: MaintenanceKind;
    scope: MaintenanceScope;
    tenantId?: string;
    adminId: string;
  }): Promise<MaintenanceRun> {
    let targetTenantId: string | null = null;
    if (input.scope === 'tenant') {
      if (!input.tenantId) {
        throw new BadRequestException('A tenant is required when scope is "tenant".');
      }
      const tenant = await controlDb.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found.');
      targetTenantId = tenant.id;
    }
    const run = await controlDb.maintenanceRun.create({
      data: {
        kind: input.kind,
        scope: input.scope,
        targetTenantId,
        status: 'queued',
        createdByAdminId: input.adminId,
      },
    });
    await this.queue.enqueue(run.id);
    return run;
  }

  async list(limit = 25): Promise<MaintenanceRun[]> {
    const take = Math.max(1, Math.min(100, limit));
    return controlDb.maintenanceRun.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  async get(id: string): Promise<MaintenanceRun> {
    const run = await controlDb.maintenanceRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Maintenance run not found.');
    return run;
  }
}
