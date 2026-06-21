import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { MemberStatus } from '@libriant/db-tenant';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RequiresQuota } from '../plans/decorators.js';
import { QuotaInterceptor } from '../plans/quota.interceptor.js';
import { validateDto } from '../auth/validate-dto.js';
import { parseLimit } from '../platform/query.js';
import { MembersService } from './members.service.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { StaffWrite } from '../tenancy/roles.decorator.js';
import {
  CreateMemberDto,
  MEMBER_STATUSES,
  SetMemberStatusDto,
  UpdateMemberDto,
} from './members.dto.js';

/**
 *   GET    /t/:slug/members?q=&status=&after=&limit=&includeArchived=
 *   POST   /t/:slug/members              [quota: max_members]
 *   GET    /t/:slug/members/:id
 *   PATCH  /t/:slug/members/:id
 *   PUT    /t/:slug/members/:id/status   (active ↔ suspended)
 *   DELETE /t/:slug/members/:id          (archive — refuses if active loans/holds)
 *
 * customFields validated against active FieldDefinitions for entity_kind='member'.
 */
@Controller('t/:slug/members')
@UseGuards(TenantGuard, RolesGuard)
@UseInterceptors(QuotaInterceptor)
export class MembersController {
  constructor(@Inject(MembersService) private readonly svc: MembersService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('q') q?: string,
    @Query('status') statusRaw?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    let status: MemberStatus | undefined;
    if (statusRaw && statusRaw.length) {
      if (!(MEMBER_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new BadRequestException(
          `Unknown status "${statusRaw}". Use one of: ${MEMBER_STATUSES.join(', ')}.`,
        );
      }
      status = statusRaw as MemberStatus;
    }
    return this.svc.list(tenant, {
      q: q && q.length ? q : undefined,
      status,
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    });
  }

  /**
   * Resolve a scanned/typed membership number → the member. Drives
   * scan-to-checkout. Declared before `:id` so the literal `lookup` segment
   * isn't captured as a member id.
   */
  @Get('lookup')
  async lookup(@TenantCtx() tenant: TenantContext, @Query('memberNumber') memberNumber?: string) {
    const value = (memberNumber ?? '').trim();
    if (!value) throw new BadRequestException('A membership number is required.');
    if (value.length > 128) {
      throw new BadRequestException('A membership number is at most 128 characters.');
    }
    return this.svc.getByMemberNumber(tenant, value);
  }

  @StaffWrite()
  @Post()
  @RequiresQuota('max_members')
  async create(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateMemberDto, raw);
    return this.svc.create(tenant, dto, actor);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @StaffWrite()
  @Patch(':id')
  async update(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateMemberDto, raw);
    return this.svc.update(tenant, id, dto, actor);
  }

  @StaffWrite()
  @Put(':id/status')
  async setStatus(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetMemberStatusDto, raw);
    return this.svc.setStatus(tenant, id, dto, actor);
  }

  @StaffWrite()
  @Delete(':id')
  async archive(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
  ) {
    return this.svc.archive(tenant, id, actor);
  }
}
