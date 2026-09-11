import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { TenantActor as TenantActorParam } from '../tenancy/tenant-actor.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantCtx } from '../tenancy/tenant-context.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { CashDrawerService } from './cash-drawer.service.js';
import { FeesService } from './fees.service.js';
import { ReceiptsService } from './receipts.service.js';
import {
  ChargeFeeDto,
  CloseDrawerDto,
  OpenDrawerDto,
  RefundFeesDto,
  SettleFeesDto,
} from './fees.dto.js';

/**
 * The money surface (2.0 phase 18).
 *
 * ## The permissions are four verbs, not one
 *
 * `circ.fee.pay` is the desk's. `circ.fee.waive`, `circ.fee.write_off` and
 * `circ.fee.refund` each carry a numeric ceiling and none of them is the same
 * act: forgiving a debt correctly owed, giving up on collecting one, and handing
 * money back are three different lines in a library's accounts and the first
 * question an auditor asks is which one happened. Collapsing them into one
 * permission would make the answer unavailable at exactly the moment it matters.
 *
 * ## Amounts are strings on the wire
 *
 * Every amount in and out of these routes is a decimal string of MINOR units.
 * See `fees.dto.ts` — a JSON number is a double, and a ledger that balances on a
 * double balances until it does not.
 */
@Controller('t/:slug/fees')
@UseGuards(TenantGuard, PermissionGuard)
export class FeesController {
  constructor(
    @Inject(FeesService) private readonly fees: FeesService,
    @Inject(CashDrawerService) private readonly drawers: CashDrawerService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  /** What a patron owes, PER CURRENCY. A set of rows, never a scalar. */
  @RequirePermission('circ.fee.read')
  @Get('balances/:patronId')
  async balances(@TenantCtx() tenant: TenantContext, @Param('patronId') patronId: string) {
    const rows = await this.fees.balances(tenant, patronId);
    return {
      balances: rows.map((r) => ({ currency: r.currency, owedCents: String(r.owedCents) })),
    };
  }

  @RequirePermission('circ.fee.pay')
  @Post('charges')
  @HttpCode(201)
  async charge(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ChargeFeeDto, raw ?? {});
    const out = await this.fees.charge(tenant, actor, {
      patronId: dto.patronId,
      feeTypeId: dto.feeTypeId,
      branchId: dto.branchId,
      currency: dto.currency,
      amountCents: BigInt(dto.amountCents),
      reason: dto.reason,
      loanId: dto.loanId ?? null,
      itemId: dto.itemId ?? null,
      holdId: dto.holdId ?? null,
    });
    return out;
  }

  /**
   * Take money, forgive a debt, or give up on one — THREE ROUTES.
   *
   * They differ only in which account the other leg lands on, and they are three
   * endpoints rather than one with a `kind` in the body because the permission
   * IS the route. `@RequirePermission` carries one key and one ceiling, so a
   * single endpoint switching on a body field could only be guarded by the
   * weakest of the three, and `circ.fee.waive`'s limit would be unreachable.
   *
   * `limitFrom: 'amountCents'` reads the field from the body and refuses when it
   * exceeds what the caller was granted — so a desk can be trusted to forgive
   * EUR 5.00 without being trusted with the balance sheet.
   */
  @RequirePermission('circ.fee.pay')
  @Post('payments')
  @HttpCode(201)
  async pay(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    return this.settleAs(tenant, actor, raw, 'payment');
  }

  @RequirePermission('circ.fee.waive', { limitFrom: 'amountCents' })
  @Post('waivers')
  @HttpCode(201)
  async waive(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    return this.settleAs(tenant, actor, raw, 'waiver');
  }

  @RequirePermission('circ.fee.write_off', { limitFrom: 'amountCents' })
  @Post('write-offs')
  @HttpCode(201)
  async writeOff(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    return this.settleAs(tenant, actor, raw, 'write_off');
  }

  private async settleAs(
    tenant: TenantContext,
    actor: TenantActor,
    raw: unknown,
    kind: 'payment' | 'waiver' | 'write_off',
  ) {
    const dto = await validateDto(SettleFeesDto, raw ?? {});
    const out = await this.fees.settle(tenant, actor, {
      patronId: dto.patronId,
      kind,
      branchId: dto.branchId,
      currency: dto.currency,
      amountCents: BigInt(dto.amountCents),
      feeIds: dto.feeIds,
      paymentMethodId: dto.paymentMethodId ?? null,
      drawerSessionId: dto.drawerSessionId ?? null,
      clientChangeId: dto.clientChangeId ?? null,
      note: dto.note ?? null,
    });
    return {
      transactionId: out.transactionId,
      creditCents: String(out.creditCents),
      allocations: out.allocations.map((a) => ({
        feeId: a.feeId,
        amountCents: String(a.amountCents),
      })),
    };
  }

  @RequirePermission('circ.fee.refund', { limitFrom: 'amountCents' })
  @Post('refunds')
  @HttpCode(201)
  async refund(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(RefundFeesDto, raw ?? {});
    const out = await this.fees.refund(tenant, actor, {
      patronId: dto.patronId,
      branchId: dto.branchId,
      currency: dto.currency,
      amountCents: BigInt(dto.amountCents),
      feeIds: dto.feeIds,
      paymentMethodId: dto.paymentMethodId ?? null,
      drawerSessionId: dto.drawerSessionId ?? null,
      note: dto.note ?? null,
    });
    return {
      transactionId: out.transactionId,
      allocations: out.allocations.map((a) => ({
        feeId: a.feeId,
        amountCents: String(a.amountCents),
      })),
    };
  }

  @RequirePermission('circ.drawer.operate')
  @Post('drawers')
  @HttpCode(201)
  async openDrawer(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(OpenDrawerDto, raw ?? {});
    return this.drawers.open(tenant, actor, {
      servicePointId: dto.servicePointId,
      currency: dto.currency,
      openingFloatCents: BigInt(dto.openingFloatCents),
    });
  }

  /**
   * Count the till.
   *
   * The response carries the variance whether or not it is zero, because the
   * librarian standing at the drawer is the person who can still explain it.
   */
  @RequirePermission('circ.drawer.operate')
  @Post('drawers/:id/close')
  async closeDrawer(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') drawerSessionId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CloseDrawerDto, raw ?? {});
    const out = await this.drawers.close(tenant, actor, {
      drawerSessionId,
      countedCents: BigInt(dto.countedCents),
      note: dto.note ?? null,
    });
    return {
      expectedCents: String(out.expectedCents),
      countedCents: String(out.countedCents),
      varianceCents: String(out.varianceCents),
      transactionId: out.transactionId,
    };
  }

  /** The reprint. Re-serves stored bytes; renders nothing. */
  @RequirePermission('circ.fee.read')
  @Get('receipts/:id')
  async reprint(@TenantCtx() tenant: TenantContext, @Param('id') receiptId: string) {
    const out = await this.receipts.reprint(tenant, receiptId);
    return {
      number: out.number,
      contentType: out.contentType,
      body: out.bytes.toString('utf8'),
    };
  }
}
