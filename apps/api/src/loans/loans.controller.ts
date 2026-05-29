import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { LoanStatus } from '@libriant/db-tenant';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { parseLimit } from '../platform/query.js';
import {
  CheckoutDto,
  MarkLostDto,
  RenewLoanDto,
  ReturnLoanDto,
  UpdateLoanDto,
} from './loans.dto.js';
import { LOAN_STATUSES, LoansService } from './loans.service.js';

/**
 * Circulation — the actual lend/return flow.
 *
 *   GET    /t/:slug/loans?memberId=&copyId=&status=&overdue=&after=&limit=
 *   POST   /t/:slug/loans                     — checkout
 *   GET    /t/:slug/loans/:id
 *   PATCH  /t/:slug/loans/:id                 — notes / customFields only
 *   POST   /t/:slug/loans/:id/return          — return the copy
 *   POST   /t/:slug/loans/:id/renew           — extend due date
 *   POST   /t/:slug/loans/:id/mark-lost       — copy gone; optionally bill member
 *
 * State transitions (active → returned | lost) are POSTed because they're
 * non-idempotent: returning twice would create two fines, renewing twice
 * would double the period, etc.
 *
 * customFields validated against active FieldDefinitions for entity_kind='loan'.
 */
@Controller('t/:slug/loans')
@UseGuards(TenantGuard)
export class LoansController {
  constructor(@Inject(LoansService) private readonly svc: LoansService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('memberId') memberId?: string,
    @Query('copyId') copyId?: string,
    @Query('status') statusRaw?: string,
    @Query('overdue') overdue?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    let status: LoanStatus | undefined;
    if (statusRaw && statusRaw.length) {
      if (!(LOAN_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new BadRequestException(
          `Unknown status "${statusRaw}". Use one of: ${LOAN_STATUSES.join(', ')}.`,
        );
      }
      status = statusRaw as LoanStatus;
    }
    return this.svc.list(tenant, {
      memberId: memberId && memberId.length ? memberId : undefined,
      copyId: copyId && copyId.length ? copyId : undefined,
      status,
      overdue: overdue === '1' || overdue === 'true',
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
    });
  }

  @Post()
  async checkout(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CheckoutDto, raw);
    return this.svc.checkout(tenant, dto, session.sub);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateLoanDto, raw);
    return this.svc.update(tenant, id, dto);
  }

  @Post(':id/return')
  async returnLoan(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ReturnLoanDto, raw ?? {});
    return this.svc.returnLoan(tenant, id, dto, session.sub);
  }

  @Post(':id/renew')
  async renew(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(RenewLoanDto, raw ?? {});
    return this.svc.renew(tenant, id, dto);
  }

  @Post(':id/mark-lost')
  async markLost(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(MarkLostDto, raw ?? {});
    return this.svc.markLost(tenant, id, dto, session.sub);
  }
}
