import {
  Body,
  Controller,
  Delete,
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
import { HoldShelfService } from './hold-shelf.service.js';
import { HoldsService } from './holds.service.js';
import {
  CancelHoldDto,
  CreateHoldGroupDto,
  FetchHoldDto,
  HoldShelfQueryDto,
  PatronHoldsQueryDto,
  PlaceHoldDto,
  PrioritiseHoldDto,
  SuspendHoldDto,
} from './holds.dto.js';

/**
 * Requests (2.0 phase 17).
 *
 * `holds`, not `reservations`: 1.0's word is `reservations` and the whole of
 * `apps/api/src/reservations` is on phase 20's delete list. Both surfaces exist
 * side by side until then, against two different Postgres schemas, and the URL
 * is how you tell which one you are on — exactly as `items` sits beside
 * `copies` and `patrons` beside `members`.
 *
 * ## The permission split follows the VERB, not the table
 *
 * Phase 3 decided the keys and phase 17 is the first code to use four of them.
 * `circ.hold.place` and `circ.hold.cancel` are the two a desk assistant needs
 * all day; `circ.hold.edit` covers suspend, resume and priority, because all
 * three change a request a reader already has; and `circ.hold.fulfill` is the
 * pull-list verb, which is the one that moves a physical copy and therefore the
 * one a library may want to keep to trained staff.
 *
 * `circ.hold.expire` guards the two sweeps. They are normally run by a schedule
 * with no session at all, but the routes exist because a librarian who has just
 * fixed a calendar wants the shelf swept NOW rather than at 03:00.
 */
@Controller('t/:slug/holds')
@UseGuards(TenantGuard, PermissionGuard)
export class HoldsController {
  constructor(
    @Inject(HoldsService) private readonly holds: HoldsService,
    @Inject(HoldShelfService) private readonly shelf: HoldShelfService,
  ) {}

  // -------------------------------------------------------------------------
  // Placing and reading
  // -------------------------------------------------------------------------

  @RequirePermission('circ.hold.place')
  @Post()
  @HttpCode(201)
  async place(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(PlaceHoldDto, raw ?? {});
    return this.holds.place(tenant, actor, dto);
  }

  /**
   * The pull list, the shelf and the in-between.
   *
   * All three declared BEFORE `:id`, because Nest matches routes in declaration
   * order and `shelf` would otherwise be read as a hold id — a 404 that looks
   * like a missing request rather than a routing mistake.
   */
  @RequirePermission('circ.hold.read')
  @Get('pull-list')
  async pullList(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(HoldShelfQueryDto, rawQuery ?? {});
    return this.shelf.pullList(tenant, q.branchId, q.take);
  }

  @RequirePermission('circ.hold.read')
  @Get('shelf')
  async holdShelf(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(HoldShelfQueryDto, rawQuery ?? {});
    return this.shelf.shelf(tenant, q.branchId, q.take);
  }

  @RequirePermission('circ.hold.read')
  @Get('in-progress')
  async inProgress(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(HoldShelfQueryDto, rawQuery ?? {});
    return this.shelf.inProgress(tenant, q.branchId, q.take);
  }

  /** One reader's requests. The account page, and the desk's summary. */
  @RequirePermission('circ.hold.read')
  @Get('for-patron')
  async forPatron(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(PatronHoldsQueryDto, rawQuery ?? {});
    return this.holds.forPatron(tenant, q.patronId, q.includeClosed === '1');
  }

  /** The queue for one record, in the order it will actually be served. */
  @RequirePermission('circ.hold.read')
  @Get('queue/:bibId')
  async queue(@TenantCtx() tenant: TenantContext, @Param('bibId') bibId: string) {
    return this.holds.queueFor(tenant, bibId);
  }

  // -------------------------------------------------------------------------
  // Working the list
  // -------------------------------------------------------------------------

  /**
   * "I have this copy in my hand."
   *
   * Keyed on the COPY and not on the request the pull list named — see
   * `HoldShelfService.fetch` for why. A `null` body is the honest answer when
   * the queue moved on while the librarian walked to the shelf.
   */
  @RequirePermission('circ.hold.fulfill')
  @Post('fetch')
  @HttpCode(200)
  async fetch(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(FetchHoldDto, raw ?? {});
    return this.shelf.fetch(tenant, actor, { itemId: dto.itemId });
  }

  // -------------------------------------------------------------------------
  // Changing one
  // -------------------------------------------------------------------------

  @RequirePermission('circ.hold.cancel')
  @Delete(':id')
  @HttpCode(200)
  async cancel(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CancelHoldDto, raw ?? {});
    return this.holds.cancel(tenant, actor, { holdId: id, ...dto });
  }

  @RequirePermission('circ.hold.edit')
  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SuspendHoldDto, raw ?? {});
    return this.holds.suspend(tenant, actor, { holdId: id, until: dto.until ?? null });
  }

  @RequirePermission('circ.hold.edit')
  @Post(':id/resume')
  @HttpCode(200)
  async resume(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
  ) {
    return this.holds.resume(tenant, actor, { holdId: id });
  }

  @RequirePermission('circ.hold.edit')
  @Post(':id/priority')
  @HttpCode(200)
  async prioritise(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(PrioritiseHoldDto, raw ?? {});
    return this.holds.prioritise(tenant, actor, { holdId: id, priority: dto.priority });
  }

  // -------------------------------------------------------------------------
  // Groups, and the sweeps
  // -------------------------------------------------------------------------

  @RequirePermission('circ.hold.place')
  @Post('groups')
  @HttpCode(201)
  async createGroup(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateHoldGroupDto, raw ?? {});
    return this.holds.createGroup(tenant, actor, dto);
  }

  /**
   * Sweep the shelf now.
   *
   * The schedule runs this nightly with no session; the route exists for the
   * librarian who has just corrected a calendar and does not want to wait until
   * 03:00 to see the shelf agree with it.
   */
  @RequirePermission('circ.hold.expire')
  @Post('sweep/shelf')
  @HttpCode(200)
  async sweepShelf(@TenantCtx() tenant: TenantContext, @TenantActorParam() actor: TenantActor) {
    return this.shelf.expireShelf(tenant, actor);
  }

  @RequirePermission('circ.hold.expire')
  @Post('sweep/requests')
  @HttpCode(200)
  async sweepRequests(@TenantCtx() tenant: TenantContext, @TenantActorParam() actor: TenantActor) {
    return this.shelf.expireRequests(tenant, actor);
  }
}
