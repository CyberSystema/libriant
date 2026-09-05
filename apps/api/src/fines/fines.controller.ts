import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { parseLimit } from '../platform/query.js';
import { FINE_STATUSES, PayFineDto, VoidFineDto, WaiveFineDto } from './fines.dto.js';
import type { FineStatusValue } from './fines.dto.js';
import { FinesService } from './fines.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { ActorPermissions } from '../authz/permission-context.js';
import type { EffectivePermissions } from '../authz/permissions.service.js';

/**
 * Fines — the desk's money drawer.
 *
 *   GET  /t/:slug/fines?status=&memberId=&loanId=&after=&limit=
 *   GET  /t/:slug/fines/:id
 *   POST /t/:slug/fines/:id/pay     — record a payment (full settlement)
 *   POST /t/:slug/fines/:id/waive   — write off a real debt
 *   POST /t/:slug/fines/:id/void    — cancel a fine raised in error
 *
 * ROLES, and why they differ:
 *
 *   • Reads carry `circ.fee.read`, which every staff role holds —
 *     a volunteer on the desk has to be able to SEE that a member owes €2.40.
 *   • `pay` is `circ.fee.pay` (owner/admin/librarian, never volunteer).
 *     Recording a payment is clerical: the money is already in the drawer and
 *     the library is only writing down what happened. Whoever can check a book
 *     out can take the €2.40 that comes back with it.
 *   • `waive` and `void` are `circ.fee.waive` / `circ.fee.void` — deliberately
 *     HIGHER, and the only two keys in the catalog that carry a numeric
 *     ceiling, so a library can hand fee forgiveness to the desk up to a
 *     limit instead of all-or-nothing.
 *     They are the only calls in the product that turn money the library is
 *     owed into money it is not owed, they leave nothing behind to inspect
 *     except an audit row, and there is no undo. That is the same reasoning
 *     that puts member erasure on owner/admin. A library that wants its senior
 *     librarian to write off fines promotes them to `admin` — no code change,
 *     and the promotion is itself recorded.
 *
 * IDEMPOTENCY: all three mutations take `Idempotency-Key`, exactly as the
 * circulation routes do. The desk is a place where people click twice and the
 * offline queue replays what it buffered; a replayed key returns the ORIGINAL
 * response (tagged `X-Idempotent-Replay`) and never re-enters the service. The
 * service additionally CASes on `status = 'outstanding'`, so two different keys
 * racing each other still resolve a fine exactly once.
 *
 * NOT plan-gated. Collecting money a member owes must keep working on a
 * lapsed subscription — refusing it would strand the library's own cash.
 */
@Controller('t/:slug/fines')
@UseGuards(TenantGuard, PermissionGuard)
export class FinesController {
  constructor(@Inject(FinesService) private readonly svc: FinesService) {}

  @RequirePermission('circ.fee.read')
  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('status') statusRaw?: string,
    @Query('memberId') memberId?: string,
    @Query('loanId') loanId?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    let status: FineStatusValue | undefined;
    if (statusRaw && statusRaw.length) {
      if (!(FINE_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new BadRequestException(
          `Unknown status "${statusRaw}". Use one of: ${FINE_STATUSES.join(', ')}.`,
        );
      }
      status = statusRaw as FineStatusValue;
    }
    return this.svc.list(tenant, {
      status,
      memberId: memberId && memberId.length ? memberId : undefined,
      loanId: loanId && loanId.length ? loanId : undefined,
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
    });
  }

  @RequirePermission('circ.fee.read')
  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  /**
   * 200, not the POST default of 201: nothing is created. The fine already
   * existed; this closes it.
   */
  @RequirePermission('circ.fee.pay')
  @Post(':id/pay')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async pay(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(PayFineDto, raw ?? {});
    return this.svc.pay(tenant, id, dto, actor);
  }

  @RequirePermission('circ.fee.waive')
  @Post(':id/waive')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async waive(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @ActorPermissions() held: EffectivePermissions | undefined,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(WaiveFineDto, raw);
    return this.svc.waive(tenant, id, dto, actor, held);
  }

  @RequirePermission('circ.fee.void')
  @Post(':id/void')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async voidFine(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @ActorPermissions() held: EffectivePermissions | undefined,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(VoidFineDto, raw);
    return this.svc.voidFine(tenant, id, dto, actor, held);
  }
}
