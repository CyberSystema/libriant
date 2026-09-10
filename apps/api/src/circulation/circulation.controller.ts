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
} from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { TenantActor as TenantActorParam } from '../tenancy/tenant-actor.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantCtx } from '../tenancy/tenant-context.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { CheckinService } from './checkin.service.js';
import { CheckoutService } from './checkout.service.js';
import { LoanReadService } from './loan-read.service.js';
import { RenewService } from './renew.service.js';
import { CheckinDto, CheckoutDto, RenewDto, RenewManyDto } from './circulation.dto.js';

/**
 * The circulation desk (2.0 phase 16).
 *
 * `t/:slug/circulation/...`, beside the 1.0 `t/:slug/loans/...` which phase 20
 * deletes. Both surfaces exist against two different Postgres schemas until
 * then, and the URL is how you tell which one you are on — exactly as `patrons`
 * sits beside `members` and `items` beside `catalog/copies`.
 *
 * The permission keys are the ones phase 3 already minted — `circ.loan.read`,
 * `circ.loan.checkout`, `circ.loan.return`, `circ.loan.renew` — so this phase
 * adds none, and `docs/api/openapi.v1.json` is unchanged. That is worth saying
 * out loud: a phase that builds the busiest surface in the product and needs no
 * new capability is a phase whose access model was designed before it, which is
 * what §6 phase 3 landing in M0 was for.
 *
 * OVERRIDING a block is NOT here. §6 phase 21 owns `override_reasons`,
 * `circulation_overrides` and `override_permissions`; every refusal this
 * controller returns already carries the permission key an override will need,
 * so a client can grey the button out today rather than discovering the refusal
 * after the click.
 */
@Controller('t/:slug/circulation')
@UseGuards(TenantGuard, PermissionGuard)
export class CirculationController {
  constructor(
    @Inject(CheckoutService) private readonly checkouts: CheckoutService,
    @Inject(CheckinService) private readonly checkins: CheckinService,
    @Inject(RenewService) private readonly renewals: RenewService,
    @Inject(LoanReadService) private readonly loans: LoanReadService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
  ) {}

  @RequirePermission('circ.loan.checkout')
  @Post('checkout')
  @HttpCode(201)
  async checkout(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CheckoutDto, raw ?? {});
    if (dto.itemBarcode === undefined && dto.itemId === undefined) {
      throw new BadRequestException('Give an item barcode or an item id.');
    }
    if (dto.patronBarcode === undefined && dto.patronId === undefined) {
      throw new BadRequestException('Give a card barcode or a patron id.');
    }
    const { effectiveAt, ...rest } = dto;
    return this.checkouts.checkout(tenant, actor, {
      ...rest,
      // Through `clock.at`, never `new Date(...)`: `apps/api/src/circulation/**`
      // is under phase 13's clock ban, and the seam is the point — one place
      // decides how a caller's string becomes an instant.
      ...(effectiveAt === undefined ? {} : { effectiveAt: this.clock.at(effectiveAt) }),
    });
  }

  @RequirePermission('circ.loan.return')
  @Post('checkin')
  @HttpCode(200)
  async checkin(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CheckinDto, raw ?? {});
    if (dto.itemBarcode === undefined && dto.itemId === undefined) {
      throw new BadRequestException('Give an item barcode or an item id.');
    }
    const { effectiveAt, ...rest } = dto;
    return this.checkins.checkin(tenant, actor, {
      ...rest,
      ...(effectiveAt === undefined ? {} : { effectiveAt: this.clock.at(effectiveAt) }),
    });
  }

  /**
   * Batch and whole-shelf renewal. Declared BEFORE `loans/:id/renew` so Nest,
   * which matches in declaration order, does not read `renew-many` as a loan id.
   */
  @RequirePermission('circ.loan.renew')
  @Post('renew-many')
  @HttpCode(200)
  async renewMany(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(RenewManyDto, raw ?? {});
    if ((dto.loanIds === undefined) === (dto.patronId === undefined)) {
      throw new BadRequestException(
        'Give either loanIds or patronId. "Renew these four" and "renew everything this reader ' +
          'has" are different acts, and a request that says both has not decided which.',
      );
    }
    const { effectiveAt, ...rest } = dto;
    const results = await this.renewals.renewMany(tenant, actor, {
      ...rest,
      ...(effectiveAt === undefined ? {} : { effectiveAt: this.clock.at(effectiveAt) }),
    });
    return {
      renewed: results.filter((r) => r.ok).length,
      refused: results.filter((r) => !r.ok).length,
      results,
    };
  }

  @RequirePermission('circ.loan.renew')
  @Post('loans/:id/renew')
  @HttpCode(200)
  async renew(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(RenewDto, raw ?? {});
    const { effectiveAt, ...rest } = dto;
    return this.renewals.renew(tenant, actor, {
      loanId: id,
      ...rest,
      ...(effectiveAt === undefined ? {} : { effectiveAt: this.clock.at(effectiveAt) }),
    });
  }

  /** What a reader has out. The desk's first screen after a card scan. */
  @RequirePermission('circ.loan.read')
  @Get('patrons/:patronId/loans')
  async openLoans(@TenantCtx() tenant: TenantContext, @Param('patronId') patronId: string) {
    return this.loans.openLoansFor(tenant, patronId);
  }

  /** Everything overdue, oldest first. The morning list. */
  @RequirePermission('circ.loan.read')
  @Get('overdue')
  async overdue(@TenantCtx() tenant: TenantContext, @Query('branchId') branchId?: string) {
    return this.loans.overdue(tenant, this.clock.now(), branchId);
  }

  @RequirePermission('circ.loan.read')
  @Get('loans/:id')
  async loan(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.loans.get(tenant, id);
  }

  /**
   * What has happened to this loan — the `occurred_at`/`effective_at` log.
   *
   * The question a librarian asks when a reader disputes a fine: not "when did
   * we hear about the return" but "when did the return HAPPEN", and the two are
   * different for every book that went through a drop box or a synced wand.
   */
  @RequirePermission('circ.loan.read')
  @Get('loans/:id/events')
  async events(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.loans.events(tenant, id);
  }
}
