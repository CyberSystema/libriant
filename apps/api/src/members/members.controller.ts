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
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RequiresQuota } from '../plans/decorators.js';
import { QuotaInterceptor } from '../plans/quota.interceptor.js';
import { validateDto } from '../auth/validate-dto.js';
import { parseLimit } from '../platform/query.js';
import { MembersService } from './members.service.js';
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
@UseGuards(TenantGuard)
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

  @Post()
  @RequiresQuota('max_members')
  async create(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateMemberDto, raw);
    return this.svc.create(tenant, dto, session.sub);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @Patch(':id')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateMemberDto, raw);
    return this.svc.update(tenant, id, dto, session.sub);
  }

  @Put(':id/status')
  async setStatus(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetMemberStatusDto, raw);
    return this.svc.setStatus(tenant, id, dto, session.sub);
  }

  @Delete(':id')
  async archive(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
  ) {
    return this.svc.archive(tenant, id, session.sub);
  }
}
