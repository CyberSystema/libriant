import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
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
import { ItemStatusService } from './item-status.service.js';
import { ItemTransfersService } from './item-transfers.service.js';
import { ItemsService } from './items.service.js';
import {
  AddItemNoteDto,
  CancelTransferDto,
  CreateItemDto,
  CreateStatusReasonDto,
  ItemByBarcodeQueryDto,
  ItemListQueryDto,
  ReceiveTransferDto,
  SendTransferDto,
  SetItemStatusDto,
  ShelfListQueryDto,
  UpdateItemDto,
} from './items.dto.js';

/**
 * Copies (2.0 phase 15).
 *
 * `items`, not `copies`: 1.0's word is `copies` and the whole of
 * `apps/api/src/catalog`'s copy routes are on phase 20's delete list. Both
 * surfaces exist side by side until then, against two different Postgres
 * schemas, and the URL is how you tell which one you are on — exactly as
 * `patrons` sits beside `members`.
 *
 * ## Why status has its own route and its own permission
 *
 * `PUT /items/:id` cannot change a status: the DTO has no such field and
 * `validateDto` rejects one. The status verb is `POST /items/:id/status` behind
 * `circ.item.status`, which is a different key from `cat.item.write` on purpose.
 * Shelf-reading staff who mark books missing all afternoon need that verb and do
 * not need the ability to re-catalogue a copy; a cataloguer needs the opposite.
 * Collapsing them would mean every library that wants one has to grant both.
 */
@Controller('t/:slug/items')
@UseGuards(TenantGuard, PermissionGuard)
export class ItemsController {
  constructor(
    @Inject(ItemsService) private readonly items: ItemsService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(ItemTransfersService) private readonly transfers: ItemTransfersService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
  ) {}

  // -------------------------------------------------------------------------
  // The copy itself
  // -------------------------------------------------------------------------

  @RequirePermission('cat.item.write')
  @Post()
  @HttpCode(201)
  async create(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateItemDto, raw ?? {});
    return this.items.create(tenant, actor, {
      ...dto,
      priceCents: dto.priceCents === undefined ? undefined : BigInt(dto.priceCents),
      replacementCostCents:
        dto.replacementCostCents === undefined ? undefined : BigInt(dto.replacementCostCents),
    });
  }

  /**
   * The copies of one record (2.0 phase 20a).
   *
   * `bibId` is required and its absence is a 400. `ItemsService.copies` carries
   * the argument: there is no index for a library-wide copy list and no screen
   * that wants one, and a required filter is cheaper to explain than an
   * endpoint that is slow for a reason nobody meant to invoke.
   *
   * `cat.bib.read`, which is what every other read on this controller already
   * uses — `GET :id`, `GET shelf`, `GET :id/history`, `GET :id/notes`. No new
   * key: `permissions.test.ts` asserts owner holds exactly `PERMISSION_KEYS
   * .length` and that volunteer ⊂ librarian ⊂ admin ⊂ owner, so inventing
   * `cat.item.read` means editing all four role templates for a distinction
   * nobody has asked for — and a volunteer who may open a copy may list the
   * copies of a title.
   */
  @RequirePermission('cat.bib.read')
  @Get()
  async list(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ItemListQueryDto, rawQuery ?? {});
    return this.items.copies(tenant, q);
  }

  /**
   * The copy a scanner just read, with its title (2.0 phase 20a).
   *
   * Declared BEFORE `:id`. Nest matches in declaration order and `:id` compiles
   * to `([^/]+)`, so a `@Get(':id')` ahead of this one would swallow
   * `by-barcode` and answer "No such copy." for the literal string — a 404 that
   * looks like a missing book and is really a routing mistake, which is the
   * same trap `shelf` and `status-reasons` below are ordered around.
   *
   * `cat.bib.read` again, and it matters that this is the key a circulation
   * desk already holds: the callers are checkout and check-in, and putting a
   * scan behind a cataloguing permission would mean every library granting
   * `cat.item.write` to whoever works the desk.
   */
  @RequirePermission('cat.bib.read')
  @Get('by-barcode')
  async byBarcode(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ItemByBarcodeQueryDto, rawQuery ?? {});
    return this.items.byBarcode(tenant, q.barcode);
  }

  /**
   * The shelf list at a branch, in shelf order.
   *
   * Declared BEFORE `:id` because Nest matches routes in declaration order and
   * `shelf` would otherwise be read as an item id — a 404 that looks like a
   * missing copy rather than a routing mistake.
   */
  @RequirePermission('cat.bib.read')
  @Get('shelf')
  async shelf(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ShelfListQueryDto, rawQuery ?? {});
    return this.items.shelfList(tenant, q.branchId, {
      take: q.take,
      ...(q.afterId === undefined
        ? {}
        : {
            after: {
              // An empty string means "the NULL tail" — a copy with no call
              // number. It cannot be written as a missing parameter, because a
              // missing one means "start at the beginning".
              callNumberSort:
                q.afterCallNumberSort === undefined || q.afterCallNumberSort === ''
                  ? null
                  : q.afterCallNumberSort,
              id: q.afterId,
            },
          }),
    });
  }

  /** The reason vocabulary, for the picker beside the status verb. */
  @RequirePermission('cat.bib.read')
  @Get('status-reasons')
  async listReasons(@TenantCtx() tenant: TenantContext) {
    return this.status.reasons(tenant, { staffOnly: true });
  }

  @RequirePermission('circ.policy.manage')
  @Post('status-reasons')
  @HttpCode(201)
  async createReason(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateStatusReasonDto, raw ?? {});
    return this.status.createReason(tenant, actor, dto);
  }

  /** What is on its way to a branch and has not arrived. */
  @RequirePermission('circ.item.transfer')
  @Get('transfers/inbound/:branchId')
  async inbound(@TenantCtx() tenant: TenantContext, @Param('branchId') branchId: string) {
    return this.transfers.inbound(tenant, branchId);
  }

  @RequirePermission('cat.bib.read')
  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.items.get(tenant, id);
  }

  @RequirePermission('cat.item.write')
  @Put(':id')
  @HttpCode(200)
  async update(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateItemDto, raw ?? {});
    return this.items.update(tenant, actor, id, {
      ...dto,
      priceCents: dto.priceCents === undefined ? undefined : BigInt(dto.priceCents),
      replacementCostCents:
        dto.replacementCostCents === undefined ? undefined : BigInt(dto.replacementCostCents),
    });
  }

  @RequirePermission('cat.item.delete')
  @Delete(':id')
  @HttpCode(200)
  async archive(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
  ) {
    await this.items.archive(tenant, actor, id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Mark a copy missing, found, or in process.
   *
   * Three of the six statuses, and the DTO says why the other three are not
   * here: `on_loan`, `in_transit` and `awaiting_pickup` are outcomes of acts,
   * and a copy that is `on_loan` with no loan is a state every availability
   * count and every patron account disagrees about.
   */
  @RequirePermission('circ.item.status')
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetItemStatusDto, raw ?? {});
    return this.status.transition(tenant, actor, {
      itemId: id,
      toStatus: dto.status,
      reasonId: dto.reasonId ?? null,
      note: dto.note ?? null,
      now: this.clock.now(),
    });
  }

  /** What has happened to this copy. The question a librarian holding it asks. */
  @RequirePermission('cat.bib.read')
  @Get(':id/history')
  async history(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.status.history(tenant, id);
  }

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  @RequirePermission('circ.item.transfer')
  @Post(':id/transfers')
  @HttpCode(201)
  async send(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SendTransferDto, raw ?? {});
    return this.transfers.send(tenant, actor, {
      itemId: id,
      toBranchId: dto.toBranchId,
      reasonId: dto.reasonId ?? null,
      holdId: dto.holdId ?? null,
      expectedBy: dto.expectedBy === undefined ? null : this.clock.at(dto.expectedBy),
      markSent: dto.markSent,
      note: dto.note ?? null,
    });
  }

  /** The open transfer for a copy, if there is one. At most one — by index. */
  @RequirePermission('circ.item.transfer')
  @Get(':id/transfers/open')
  async openTransfer(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return (await this.transfers.openFor(tenant, id)) ?? { open: false };
  }

  @RequirePermission('circ.item.transfer')
  @Post('transfers/receive')
  @HttpCode(200)
  async receive(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ReceiveTransferDto, raw ?? {});
    return this.transfers.receive(tenant, actor, dto);
  }

  @RequirePermission('circ.item.transfer')
  @Post('transfers/cancel')
  @HttpCode(200)
  async cancelTransfer(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CancelTransferDto, raw ?? {});
    return this.transfers.cancel(tenant, actor, dto);
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  @RequirePermission('cat.item.write')
  @Post(':id/notes')
  @HttpCode(201)
  async addNote(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(AddItemNoteDto, raw ?? {});
    return this.items.addNote(tenant, actor, id, dto);
  }

  /**
   * Staff see every note; this route is behind a staff permission, so it passes
   * `true`. The OPAC reads the same table through phase 31's own plane and
   * passes `false` — which is why the flag is a parameter rather than a
   * hard-coded `true` here.
   */
  @RequirePermission('cat.bib.read')
  @Get(':id/notes')
  async notes(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.items.notes(tenant, id, true);
  }

  @RequirePermission('cat.item.write')
  @Delete('notes/:noteId')
  @HttpCode(200)
  async archiveNote(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('noteId') noteId: string,
  ) {
    await this.items.archiveNote(tenant, actor, noteId);
    return { ok: true };
  }
}
