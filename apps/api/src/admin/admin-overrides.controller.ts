import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString } from 'class-validator';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthGuard, AdminSess } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { AdminRoles, AnyAdmin } from './admin-roles.decorator.js';
import type { AdminSessionPayload } from './admin-session.service.js';
import { adminAuditActor, recordAdminAudit } from '../platform/admin-audit.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';

/** Focused JSON-safe snapshot of an override's value fields, for audit diffs. */
function overrideSnapshot(o: {
  valueInt: number | null;
  valueBool: boolean | null;
  valueText: string | null;
  expiresAt: Date | null;
  note: string | null;
}): Record<string, unknown> {
  return {
    valueInt: o.valueInt,
    valueBool: o.valueBool,
    valueText: o.valueText,
    expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
    note: o.note,
  };
}

class UpsertOverrideDto {
  @IsString()
  featureKey!: string;

  @IsOptional()
  @IsInt()
  valueInt?: number | null;

  @IsOptional()
  @IsBoolean()
  valueBool?: boolean | null;

  @IsOptional()
  @IsString()
  valueText?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsString()
  note?: string | null;
}

/**
 *   GET    /admin/tenants/:tenantId/overrides
 *   PUT    /admin/tenants/:tenantId/overrides    — upsert one feature override
 *   DELETE /admin/tenants/:tenantId/overrides/:featureKey
 *
 * Mutating any of these blows the EffectivePlan cache for the tenant so
 * the next request sees the new effective values immediately.
 */
@Controller('admin/tenants/:tenantId/overrides')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminOverridesController {
  constructor(@Inject(EffectivePlanService) private readonly effectivePlan: EffectivePlanService) {}

  @Get()
  @AnyAdmin()
  async list(@Param('tenantId') tenantId: string) {
    const tenant = await controlDb.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    const overrides = await controlDb.tenantPlanOverride.findMany({
      where: { tenantId },
      orderBy: { featureKey: 'asc' },
    });
    return { overrides };
  }

  @Put()
  @AdminRoles('owner')
  async upsert(
    @Param('tenantId') tenantId: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpsertOverrideDto, raw);
    const [tenant, feature] = await Promise.all([
      controlDb.tenant.findUnique({ where: { id: tenantId } }),
      controlDb.planFeature.findUnique({ where: { key: dto.featureKey } }),
    ]);
    if (!tenant) throw new NotFoundException('Tenant not found.');
    if (!feature) throw new NotFoundException(`Unknown feature key "${dto.featureKey}".`);

    if (feature.type === 'integer' && dto.valueInt === undefined) {
      throw new BadRequestException('This feature expects an integer value.');
    }
    if (feature.type === 'boolean' && dto.valueBool === undefined) {
      throw new BadRequestException('This feature expects a boolean value.');
    }
    if (feature.type === 'text' && dto.valueText === undefined) {
      throw new BadRequestException('This feature expects a text value.');
    }

    const existing = await controlDb.tenantPlanOverride.findFirst({
      where: { tenantId, featureKey: dto.featureKey },
    });

    const payload = {
      valueInt: feature.type === 'integer' ? (dto.valueInt ?? null) : null,
      valueBool: feature.type === 'boolean' ? (dto.valueBool ?? null) : null,
      valueText: feature.type === 'text' ? (dto.valueText ?? null) : null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      note: dto.note ?? null,
      createdByAdminId: admin.sub,
    };

    const row = existing
      ? await controlDb.tenantPlanOverride.update({ where: { id: existing.id }, data: payload })
      : await controlDb.tenantPlanOverride.create({
          data: { tenantId, featureKey: dto.featureKey, ...payload },
        });

    await this.effectivePlan.invalidate(tenantId);
    await recordAdminAudit(adminAuditActor(req, admin), {
      tenantId,
      action: 'feature_override.set',
      targetType: 'feature_override',
      targetId: dto.featureKey,
      before: existing ? overrideSnapshot(existing) : undefined,
      after: overrideSnapshot(row),
    });
    return { override: row };
  }

  @Delete(':featureKey')
  @AdminRoles('owner')
  async remove(
    @Param('tenantId') tenantId: string,
    @Param('featureKey') featureKey: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
  ) {
    // Read the row first so the audit can record what was cleared (deleteMany
    // returns only a count).
    const existing = await controlDb.tenantPlanOverride.findFirst({
      where: { tenantId, featureKey },
    });
    if (!existing) throw new NotFoundException('Override not found.');
    await controlDb.tenantPlanOverride.delete({ where: { id: existing.id } });
    await this.effectivePlan.invalidate(tenantId);
    await recordAdminAudit(adminAuditActor(req, admin), {
      tenantId,
      action: 'feature_override.cleared',
      targetType: 'feature_override',
      targetId: featureKey,
      before: overrideSnapshot(existing),
    });
    return { ok: true };
  }
}
