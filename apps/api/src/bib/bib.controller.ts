import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
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
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { BibWriteService } from './bib-write.service.js';
import {
  CreateRecordDto,
  RestoreVersionDto,
  WriteRecordDto,
  parseOps,
  toMarcRecord,
} from './bib.dto.js';

/**
 * The MARC store's write surface.
 *
 *   POST  /t/:slug/catalog/bib                      — create
 *   PATCH /t/:slug/catalog/bib/:id                  — apply ops
 *   GET   /t/:slug/catalog/bib/:id/versions         — history
 *   GET   /t/:slug/catalog/bib/:id/versions/:a/diff — field-level diff
 *   POST  /t/:slug/catalog/bib/:id/restore          — restore a version
 *
 * NOT here, and deliberately: reading a record as `.mrc` / `.xml` / `.json`,
 * `?fidelity=source`, and the streamed export. §6 gives all of those to phase
 * 11 together with the projection, and building a read surface now would mean
 * building it twice.
 *
 * PERMISSIONS. Three keys, all of which already exist — phase 10 adds none.
 * `cat.bib.read` for the history and the diff, `cat.bib.write` for create, edit
 * and restore. Restore is not separated from edit: it produces a state the
 * record already had and that this library already published, so a cataloguer
 * trusted to change a record is trusted to change it back. A library wanting
 * otherwise is really asking for a four-eyes workflow, which is a different
 * feature.
 *
 * IDEMPOTENCY on every mutation, as on the circulation routes. A cataloguer
 * double-clicking Save is the normal case, and the offline client replays what
 * it buffered. Note this is BELT to the CAS's braces and does a different job:
 * the interceptor makes the SAME request harmless to repeat, while
 * `expectedContentHash` makes a DIFFERENT request against a moved record
 * refuse. Neither substitutes for the other.
 *
 * NOT plan-gated. A library whose subscription lapsed must still be able to
 * correct its own catalogue.
 */
@Controller('t/:slug/catalog/bib')
@UseGuards(TenantGuard, PermissionGuard)
export class BibController {
  constructor(@Inject(BibWriteService) private readonly svc: BibWriteService) {}

  @RequirePermission('cat.bib.write')
  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async create(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateRecordDto, raw ?? {});
    return this.svc.create(tenant, actor, {
      record: toMarcRecord(dto),
      kind: dto.kind,
      schema: dto.schema,
      controlNumber: dto.controlNumber,
    });
  }

  /**
   * PATCH, not PUT: the body is a set of ops against a named base state, not a
   * replacement document. A PUT would invite a client to send the whole record
   * back, which loses the one thing the op list carries — WHICH subfield the
   * cataloguer touched — and turns every save into a whole-record diff.
   */
  @RequirePermission('cat.bib.write')
  @Patch(':id')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async write(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(WriteRecordDto, raw ?? {});
    const parsed = parseOps(dto.ops);
    if ('errors' in parsed) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.badOps',
        message: 'One or more edits could not be understood, so nothing was saved.',
        errors: parsed.errors,
      });
    }
    if (parsed.ops.length === 0) {
      throw new BadRequestException('Send at least one edit.');
    }
    return this.svc.write(tenant, actor, {
      recordId: id,
      ops: parsed.ops,
      expectedContentHash: dto.expectedContentHash,
      changeKind: dto.changeKind,
      changeSummary: dto.changeSummary,
    });
  }

  @RequirePermission('cat.bib.read')
  @Get(':id/versions')
  async versions(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.versions(tenant, id);
  }

  /**
   * The difference between two stored versions.
   *
   * `to` defaults to the version after `from`, because "what did this edit
   * change?" is the question a history list actually asks.
   */
  @RequirePermission('cat.bib.read')
  @Get(':id/versions/:from/diff')
  async diff(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Param('from', ParseIntPipe) from: number,
    @Query('to') toRaw?: string,
  ) {
    const to = toRaw === undefined ? from + 1 : Number(toRaw);
    if (!Number.isInteger(to) || to < 1) {
      throw new BadRequestException('`to` must be a version number.');
    }
    return this.svc.diffVersions(tenant, id, from, to);
  }

  /**
   * 200, not 201: a restore creates a version but not a record, and the caller
   * addressed an existing one.
   */
  @RequirePermission('cat.bib.write')
  @Post(':id/restore')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async restore(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(RestoreVersionDto, raw ?? {});
    return this.svc.restore(tenant, actor, id, dto.version, dto.expectedContentHash);
  }
}
