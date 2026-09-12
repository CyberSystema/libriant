import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
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
import { PATRON_DATA_TABLES } from './patron-data-map.js';
import {
  ClearBlockDto,
  CreatePatronDto,
  ErasePatronDto,
  ListPatronsQueryDto,
  MergePatronsDto,
  PlaceBlockDto,
  ReplaceCardDto,
  ResolveCardDto,
  SetPatronStatusDto,
  UpdatePatronDto,
} from './patrons.dto.js';
import { PatronBlocksService, type LiveBlock } from './patron-blocks.service.js';
import { PatronMergeService } from './patron-merge.service.js';
import { PatronsService } from './patrons.service.js';
import { PatronEraseService } from './patron-erase.service.js';
import { PatronSubjectAccessService } from '../privacy/patron-subject-access.service.js';

/**
 * The borrower record.
 *
 * `patrons`, not `members`: 1.0's word is `members`, and the whole of
 * `apps/api/src/members` is on phase 20's delete list. Both surfaces exist side
 * by side until then, against two different Postgres schemas, and the URL is how
 * you tell which one you are on.
 */
@Controller('t/:slug/patrons')
@UseGuards(TenantGuard, PermissionGuard)
export class PatronsController {
  constructor(
    @Inject(PatronsService) private readonly patrons: PatronsService,
    @Inject(PatronMergeService) private readonly merges: PatronMergeService,
    @Inject(PatronBlocksService) private readonly blocks: PatronBlocksService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PatronSubjectAccessService)
    private readonly subjectAccess: PatronSubjectAccessService,
    @Inject(PatronEraseService) private readonly erasure: PatronEraseService,
  ) {}

  /**
   * The roster (2.0 phase 20a).
   *
   * Declared FIRST among the GETs. `@Get()` matches the empty path and cannot
   * be shadowed by a sibling, and this controller has no `@Get(':id')` at all
   * today — but `by-card` and `data-map` are literal paths that WOULD be
   * swallowed by one, so the ordering convention is worth keeping visible on
   * the day somebody adds it.
   *
   * `patron.read`, the key the whole read surface already uses — `by-card`,
   * `:id/desk` and `:id/blocks` are all behind it. No new permission:
   * `permissions.test.ts` asserts that the owner template's count equals
   * `PERMISSION_KEYS.length` and that volunteer ⊆ librarian ⊆ admin ⊆ owner
   * strictly, so inventing `patron.list` means editing all four templates for a
   * distinction nobody has asked for — a librarian who may open a patron may
   * list patrons. Note what that DOES mean: `patron.read` is in the volunteer
   * template, so a volunteer can page this roster, which is why `staff_notes`
   * is not among the columns `PatronsService.list` selects.
   */
  @RequirePermission('patron.read')
  @Get()
  async list(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ListPatronsQueryDto, rawQuery ?? {});
    return this.patrons.list(tenant, {
      q: q.q,
      status: q.status,
      after: q.after,
      limit: q.limit,
      // THE ONE PLACE the string becomes a boolean. The DTO accepts only `'1'`
      // and `'true'` because `class-transformer` turns the string `"false"`
      // into `true`; converting here, once, by PRESENCE rather than by value
      // means no later reader has to wonder whether some other spelling leaks
      // through and switches the archive on.
      includeArchived: q.includeArchived !== undefined,
    });
  }

  @RequirePermission('patron.write')
  @Post()
  @HttpCode(201)
  async create(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreatePatronDto, raw ?? {});
    return this.patrons.create(tenant, actor, {
      ...dto,
      dateOfBirth: dto.dateOfBirth === undefined ? undefined : this.clock.at(dto.dateOfBirth),
      expiresAt: dto.expiresAt === undefined ? undefined : this.clock.at(dto.expiresAt),
    });
  }

  /**
   * A scanned card, resolved to the patron who should be charged.
   *
   * `was_merged` comes back with the answer rather than being swallowed: the
   * desk should be able to say "this card belongs to a record that has been
   * merged into another one" instead of silently substituting a patron.
   */
  @RequirePermission('patron.read')
  @Get('by-card')
  async byCard(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ResolveCardDto, rawQuery ?? {});
    const found = await this.patrons.resolveCard(tenant, q.barcode);
    return found ?? { found: false };
  }

  /** Who they are, what stops them, and what they owe — per currency. */
  /**
   * The record. Declared before `:id/desk` only for readability — the two
   * patterns cannot collide — but AFTER `by-card`, `data-map`, `merge` and
   * `blocks/:blockId`, every one of which `:id` would otherwise swallow.
   */
  @RequirePermission('patron.read')
  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.patrons.get(tenant, id);
  }

  @RequirePermission('patron.write')
  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdatePatronDto, raw ?? {});
    return this.patrons.update(tenant, id, dto);
  }

  /**
   * `patron.status`, its own key — suspending a reader stops them borrowing,
   * which is a different act from correcting their phone number and is one a
   * library may want a narrower set of people doing.
   */
  @RequirePermission('patron.status')
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetPatronStatusDto, raw ?? {});
    return this.patrons.setStatus(tenant, id, dto.status);
  }

  /**
   * Archive, refusing while the patron still has open business — an open loan,
   * a live hold or an unpaid fee. A 409 rather than a 400: the request is
   * well-formed and the library may archive them tomorrow.
   */
  @RequirePermission('patron.archive')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.patrons.archive(tenant, id);
  }

  @RequirePermission('patron.archive')
  @Post(':id/restore')
  @HttpCode(200)
  async restore(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.patrons.restore(tenant, id);
  }

  /**
   * GDPR Article 15 and 20, over `lbr2`.
   *
   * `patron.pii.export`, not `patron.read` — a volunteer may staff a desk and
   * read the patron page, and assembling every field, the whole borrowing
   * history and every notice into one portable file is a disclosure decision
   * rather than a read. The 1.0 route at `GET /members/:id/data-export` makes
   * the same distinction and for the same reason.
   */
  @RequirePermission('patron.pii.export')
  @Get(':id/data-export')
  async dataExport(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.subjectAccess.bundle(tenant, id);
  }

  /**
   * GDPR Article 17.
   *
   * A POST rather than a DELETE: the patron row SURVIVES an erasure — redacted
   * in place so the ledger's NOT NULL references still hold — so `DELETE` would
   * describe something this does not do. And it takes a reason, because an
   * erasure is a decision a library may later be asked to account for.
   */
  @RequirePermission('patron.erase')
  @Post(':id/erase')
  @HttpCode(200)
  async erase(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ErasePatronDto, raw ?? {});
    return this.erasure.erase(tenant, actor, id, dto.reason);
  }

  @RequirePermission('patron.read')
  @Get(':id/desk')
  async desk(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.patrons.deskSummary(tenant, id);
  }

  @RequirePermission('patron.block.manage')
  @Post(':id/blocks')
  @HttpCode(201)
  async placeBlock(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(PlaceBlockDto, raw ?? {});
    return this.blocks.placeManualBlock(tenant, actor, {
      patronId: id,
      reason: dto.reason,
      severity: dto.severity,
      now: this.clock.now(),
    });
  }

  @RequirePermission('patron.read')
  @Get(':id/blocks')
  async listBlocks(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
  ): Promise<LiveBlock[]> {
    return this.blocks.liveBlocks(tenant, id);
  }

  @RequirePermission('patron.block.manage')
  @Delete('blocks/:blockId')
  @HttpCode(200)
  async clearBlock(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('blockId') blockId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ClearBlockDto, raw ?? {});
    await this.blocks.clearBlock(tenant, actor, {
      blockId,
      reason: dto.reason,
      now: this.clock.now(),
    });
    return { ok: true };
  }

  @RequirePermission('patron.write')
  @Put('cards/:cardId')
  @HttpCode(200)
  async replaceCard(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('cardId') cardId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ReplaceCardDto, raw ?? {});
    return this.patrons.replaceCard(tenant, actor, { cardId, ...dto });
  }

  /**
   * Fold two records for the same person into one.
   *
   * The survivor keeps its id. That is not a detail: every loan, fee, hold and
   * audit target pointing at it still resolves, and the loser's old card keeps
   * working through exactly one hop.
   */
  @RequirePermission('patron.merge')
  @Post('merge')
  @HttpCode(200)
  async merge(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(MergePatronsDto, raw ?? {});
    return this.merges.merge(tenant, actor, { ...dto, now: this.clock.now() });
  }

  /**
   * Which tables hold something about a patron, and what an erase does to each.
   *
   * §5 promises `check:dsar-coverage` at phases 33 and 96 — "makes it
   * structurally impossible for a new patron-referencing table to escape the
   * subject-access bundle" — and it does not exist. Phase 14 takes the count
   * from one to eleven, and a gate written nineteen phases later cannot
   * retroactively catch a table this phase forgot; it can only freeze the
   * forgetting.
   *
   * So the map is data, the bundle is driven from it, and this route makes it
   * legible to the person who has to answer for it. Behind `patron.pii.export`,
   * because knowing exactly what a library holds about its readers is the same
   * kind of disclosure as the bundle itself.
   */
  @RequirePermission('patron.pii.export')
  @Get('data-map')
  dataMap() {
    return {
      note:
        'Every table in the 2.0 schema that holds something about a person, and what an erase ' +
        'does to it. `pending` entries are tables a later phase creates.',
      tables: PATRON_DATA_TABLES,
    };
  }
}
