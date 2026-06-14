import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { AdminRoles } from './admin-roles.decorator.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';

class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  stripePriceId?: string | null;

  @IsOptional()
  @IsInt()
  monthlyPriceCents?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

class SetPlanFeatureDto {
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
}

/**
 *   GET   /admin/plans
 *   GET   /admin/plans/:slug
 *   PATCH /admin/plans/:slug
 *   PUT   /admin/plans/:slug/features        — upsert one feature value
 *   GET   /admin/feature-keys                — catalog with defaults
 *
 * Plan editing is the headline owner-managed surface. Step 16's
 * `EffectivePlanService` cache is invalidated for every affected tenant
 * whenever a plan value changes — otherwise existing tenants would keep
 * seeing the old values until their cache row expires.
 */
@Controller('admin')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPlansController {
  constructor(@Inject(EffectivePlanService) private readonly effectivePlan: EffectivePlanService) {}

  @Get('feature-keys')
  async featureKeys() {
    const rows = await controlDb.planFeature.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
    return { features: rows };
  }

  @Get('plans')
  async list() {
    const plans = await controlDb.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { values: true },
    });
    return { plans };
  }

  @Get('plans/:slug')
  async get(@Param('slug') slug: string) {
    const plan = await controlDb.plan.findUnique({
      where: { slug },
      include: { values: true },
    });
    if (!plan) throw new NotFoundException('Plan not found.');
    return { plan };
  }

  @Patch('plans/:slug')
  @AdminRoles('owner')
  async update(@Param('slug') slug: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdatePlanDto, raw);
    const existing = await controlDb.plan.findUnique({ where: { slug } });
    if (!existing) throw new NotFoundException('Plan not found.');
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.stripePriceId !== undefined) data.stripePriceId = dto.stripePriceId;
    if (dto.monthlyPriceCents !== undefined) data.monthlyPriceCents = dto.monthlyPriceCents;
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.isPublic !== undefined) data.isPublic = dto.isPublic;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    const plan = await controlDb.plan.update({
      where: { id: existing.id },
      data,
      include: { values: true },
    });
    await this.invalidatePlan(plan.id);
    return { plan };
  }

  @Put('plans/:slug/features')
  @AdminRoles('owner')
  async setFeature(@Param('slug') slug: string, @Body() raw: unknown) {
    const dto = await validateDto(SetPlanFeatureDto, raw);
    const plan = await controlDb.plan.findUnique({ where: { slug } });
    if (!plan) throw new NotFoundException('Plan not found.');

    const feature = await controlDb.planFeature.findUnique({ where: { key: dto.featureKey } });
    if (!feature) throw new NotFoundException(`Unknown feature key "${dto.featureKey}".`);

    // Enforce that the right value column matches the feature's type so we
    // don't store nonsense (a bool feature with a number value, etc.).
    if (feature.type === 'integer' && dto.valueInt === undefined) {
      throw new BadRequestException('This feature expects an integer value.');
    }
    if (feature.type === 'boolean' && dto.valueBool === undefined) {
      throw new BadRequestException('This feature expects a boolean value.');
    }
    if (feature.type === 'text' && dto.valueText === undefined) {
      throw new BadRequestException('This feature expects a text value.');
    }

    await controlDb.planFeatureValue.upsert({
      where: { planId_featureKey: { planId: plan.id, featureKey: dto.featureKey } },
      create: {
        planId: plan.id,
        featureKey: dto.featureKey,
        valueInt: feature.type === 'integer' ? (dto.valueInt ?? null) : null,
        valueBool: feature.type === 'boolean' ? (dto.valueBool ?? null) : null,
        valueText: feature.type === 'text' ? (dto.valueText ?? null) : null,
      },
      update: {
        valueInt: feature.type === 'integer' ? (dto.valueInt ?? null) : null,
        valueBool: feature.type === 'boolean' ? (dto.valueBool ?? null) : null,
        valueText: feature.type === 'text' ? (dto.valueText ?? null) : null,
      },
    });
    await this.invalidatePlan(plan.id);
    const fresh = await controlDb.plan.findUnique({
      where: { id: plan.id },
      include: { values: true },
    });
    return { plan: fresh };
  }

  /** Invalidate `EffectivePlanService` cache for every tenant on this plan. */
  private async invalidatePlan(planId: string): Promise<void> {
    const tenants = await controlDb.subscription.findMany({
      where: { planId },
      select: { tenantId: true },
    });
    await Promise.all(tenants.map((s) => this.effectivePlan.invalidate(s.tenantId)));
  }
}
