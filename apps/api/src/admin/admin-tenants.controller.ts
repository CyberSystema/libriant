import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthGuard, AdminSess } from './admin-auth.guard.js';
import type { AdminSessionPayload } from './admin-session.service.js';
import { DeleteTenantDto } from './admin-tenants.dto.js';

/**
 *   GET    /admin/tenants?status=&planSlug=&q=&limit=
 *   GET    /admin/tenants/:id
 *   POST   /admin/tenants/:id/delete   — HARD delete (drop DB + cascade rows)
 *
 * Read endpoints are metadata only — admin must redeem a support key (Step 18a)
 * to see a tenant's actual library data. Delete is the one mutation here: it is
 * owner break-glass and irreversible (see the method comment).
 */
@Controller('admin/tenants')
@UseGuards(AdminAuthGuard)
export class AdminTenantsController {
  private readonly logger = new Logger(AdminTenantsController.name);

  constructor(
    @Inject(TenantProvisioningService) private readonly provisioning: TenantProvisioningService,
    @Inject(EffectivePlanService) private readonly effectivePlan: EffectivePlanService,
  ) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('planSlug') planSlug?: string,
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (q && q.length) {
      where.OR = [
        { slug: { contains: q.toLowerCase() } },
        { name: { contains: q, mode: 'insensitive' } },
        { primaryEmail: { contains: q.toLowerCase() } },
      ];
    }
    if (planSlug) {
      where.subscription = { plan: { slug: planSlug } };
    }
    const rows = await controlDb.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
        primaryEmail: true,
        createdAt: true,
        cellId: true,
        subscription: {
          select: {
            status: true,
            billingMode: true,
            plan: { select: { slug: true, name: true } },
          },
        },
      },
    });
    return {
      tenants: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        defaultLocale: t.defaultLocale,
        status: t.status,
        primaryEmail: t.primaryEmail,
        createdAt: t.createdAt,
        cellId: t.cellId,
        plan: t.subscription?.plan
          ? { slug: t.subscription.plan.slug, name: t.subscription.plan.name }
          : null,
        billingStatus: t.subscription?.status ?? null,
        billingMode: t.subscription?.billingMode ?? null,
      })),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
        primaryEmail: true,
        customSubdomain: true,
        cellId: true,
        dbUrl: true,
        storageUrl: true,
        createdAt: true,
        updatedAt: true,
        subscription: {
          include: { plan: true },
        },
        billingAccount: {
          select: {
            billingEmail: true,
            billingName: true,
            stripeCustomerId: true,
            country: true,
          },
        },
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    return { tenant };
  }

  /**
   * Hard-delete a tenant. IRREVERSIBLE — owner break-glass, no undo. In order:
   *   1. drop the tenant's Postgres database (provisioning.teardown),
   *   2. best-effort purge the tenant's local storage directory,
   *   3. delete the control-plane Tenant row, which CASCADES to its users,
   *      subscription, billing account, support keys/sessions, deliveries, etc.
   * Recorded as a platform-level audit event (tenantId NULL — the row is gone).
   * The caller must echo the exact slug as a typed confirmation.
   */
  @Post(':id/delete')
  @HttpCode(200)
  async remove(
    @AdminSess() admin: AdminSessionPayload,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(DeleteTenantDto, raw);
    const tenant = await controlDb.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, name: true, storageUrl: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    if (dto.confirmSlug.trim().toLowerCase() !== tenant.slug.toLowerCase()) {
      throw new BadRequestException("The typed slug doesn't match this library.");
    }

    // 1) Drop the tenant DB first. teardown() is idempotent (DROP DATABASE IF
    //    EXISTS), so a failure here aborts before we touch the control row,
    //    leaving the delete safe to retry.
    await this.provisioning.teardown(tenant.id);

    // 2) Best-effort storage purge (local file driver). S3/SMB cleanup is a
    //    follow-up; we never block the delete on it.
    await this.purgeStorage(tenant.id, tenant.storageUrl);

    // 3) Remove the control-plane row → cascades users, subscription, billing
    //    account, support keys/sessions, announcement deliveries, etc.
    await controlDb.tenant.delete({ where: { id: tenant.id } });

    await this.effectivePlan.invalidate(tenant.id).catch(() => {});

    await controlDb.auditEvent.create({
      data: {
        tenantId: null, // the tenant row no longer exists
        actorType: 'admin',
        actorId: admin.sub,
        action: 'tenant.deleted',
        targetType: 'tenant',
        targetId: tenant.id,
        beforeJson: { slug: tenant.slug, name: tenant.name },
      },
    });
    this.logger.warn(`Admin ${admin.sub} HARD-deleted tenant ${tenant.slug} (${tenant.id}).`);
    return { deleted: true, id: tenant.id, slug: tenant.slug };
  }

  /** Best-effort removal of a tenant's local storage dir. file:// only. */
  private async purgeStorage(tenantId: string, storageUrl: string): Promise<void> {
    if (!storageUrl.startsWith('file:')) {
      this.logger.warn(
        `Storage for ${tenantId} is ${storageUrl.split(':')[0]}://-backed — skipping purge; clean it up out-of-band.`,
      );
      return;
    }
    try {
      const dir = fileURLToPath(storageUrl);
      // Safety: only remove a path that actually ends with this tenant's id, so
      // a malformed URL can't delete an unrelated directory.
      if (!dir.replace(/\/+$/, '').endsWith(tenantId)) {
        this.logger.error(`Refusing to purge storage path ${dir} — doesn't end with ${tenantId}.`);
        return;
      }
      await fs.rm(dir, { recursive: true, force: true });
      this.logger.warn(`Purged storage dir ${dir} for tenant ${tenantId}.`);
    } catch (err) {
      this.logger.error(`Storage purge failed for ${tenantId}: ${(err as Error).message}`);
    }
  }
}
