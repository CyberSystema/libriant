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
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ReservationStatus } from '@libriant/db-tenant';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { LoansService } from '../loans/loans.service.js';
import { RequiresFeature } from '../plans/decorators.js';
import { PlanGuard } from '../plans/plan.guard.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { parseLimit } from '../platform/query.js';
import {
  FulfillReservationDto,
  PlaceHoldDto,
  RESERVATION_STATUSES,
  UpdateReservationDto,
} from './reservations.dto.js';
import { ReservationsService } from './reservations.service.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { StaffWrite } from '../tenancy/roles.decorator.js';

/**
 * Holds queue.
 *
 *   GET    /t/:slug/reservations?bookId=&memberId=&status=&includeResolved=&after=&limit=
 *   POST   /t/:slug/reservations                       [feature: reservations_enabled]  — place hold
 *   GET    /t/:slug/reservations/:id
 *   PATCH  /t/:slug/reservations/:id                   — notes / customFields only
 *   DELETE /t/:slug/reservations/:id                   — cancel
 *   POST   /t/:slug/reservations/:id/expire            — force-expire a ready hold (cron + admin)
 *   POST   /t/:slug/reservations/:id/fulfill           [feature: reservations_enabled]  — pick up
 *
 * Cancel / expire / list / get are NOT plan-gated — downgraded libraries
 * still need to wind down their existing queue gracefully.
 *
 * customFields validated against active FieldDefinitions for entity_kind='reservation'.
 */
@Controller('t/:slug/reservations')
@UseGuards(TenantGuard, RolesGuard, PlanGuard)
export class ReservationsController {
  constructor(
    @Inject(ReservationsService) private readonly svc: ReservationsService,
    @Inject(LoansService) private readonly loans: LoansService,
  ) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('bookId') bookId?: string,
    @Query('memberId') memberId?: string,
    @Query('status') statusRaw?: string,
    @Query('includeResolved') includeResolved?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    let status: ReservationStatus | undefined;
    if (statusRaw && statusRaw.length) {
      if (!(RESERVATION_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new BadRequestException(
          `Unknown status "${statusRaw}". Use one of: ${RESERVATION_STATUSES.join(', ')}.`,
        );
      }
      status = statusRaw as ReservationStatus;
    }
    return this.svc.list(tenant, {
      bookId: bookId && bookId.length ? bookId : undefined,
      memberId: memberId && memberId.length ? memberId : undefined,
      status,
      includeResolved: includeResolved === '1' || includeResolved === 'true',
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
    });
  }

  @StaffWrite()
  @Post()
  @RequiresFeature('reservations_enabled')
  async placeHold(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(PlaceHoldDto, raw);
    return this.svc.placeHold(tenant, dto, session.sub);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @StaffWrite()
  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateReservationDto, raw);
    return this.svc.update(tenant, id, dto);
  }

  @StaffWrite()
  @Delete(':id')
  async cancel(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.cancel(tenant, id);
  }

  @StaffWrite()
  @Post(':id/expire')
  async expire(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.expire(tenant, id);
  }

  /**
   * Pick up a ready hold. The reservation already knows which copy it's
   * tied to (`fulfilledByCopyId`), so we forward to LoansService.checkout
   * with that copy + the reservation id. Loans handles the atomic flip
   * inside its own transaction; this controller is a thin wrapper so the
   * librarian's UI button has a clear name.
   */
  @StaffWrite()
  @Post(':id/fulfill')
  @RequiresFeature('reservations_enabled')
  async fulfill(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(FulfillReservationDto, raw ?? {});
    const reservation = await this.svc.get(tenant, id);
    if (reservation.status !== 'ready' || !reservation.fulfilledByCopyId) {
      throw new BadRequestException(
        reservation.status === 'queued'
          ? "This hold isn't ready yet — wait for it to reach the front of the queue."
          : `This hold is ${reservation.status} and can't be picked up.`,
      );
    }
    return this.loans.checkout(
      tenant,
      {
        copyId: reservation.fulfilledByCopyId,
        memberId: reservation.memberId,
        dueAt: dto.dueAt,
        notes: dto.notes,
        customFields: dto.customFields,
        reservationId: id,
      },
      actor,
    );
  }
}
