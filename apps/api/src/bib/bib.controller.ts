import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { BibWriteService } from './bib-write.service.js';
import {
  AcquireLockDto,
  BibListQueryDto,
  CreateRecordDto,
  DeleteRecordDto,
  LockSessionDto,
  RestoreVersionDto,
  WriteRecordDto,
  parseOps,
  toMarcRecord,
} from './bib.dto.js';
import { BibLockService } from './bib-lock.service.js';
import { BibReadService } from './bib-read.service.js';
import { BibIngestService } from './bib-ingest.service.js';
import { BibDeleteService } from './bib-delete.service.js';
import {
  contentTypeForSourceFormat,
  marcWriteToHttp,
  serializeRecord,
  type SerializationFormat,
} from './bib-serialize.js';
import { CATALOG_INGEST_MAX_BYTES } from './bib.constants.js';

/**
 * The MARC store: records in, records out.
 *
 *   GET   /t/:slug/catalog/bib                      — the list: search, filter, page
 *   GET   /t/:slug/catalog/bib/:id.mrc              — ISO 2709
 *   GET   /t/:slug/catalog/bib/:id.xml              — MARCXML
 *   GET   /t/:slug/catalog/bib/:id.json             — MARC-in-JSON
 *   GET   /t/:slug/catalog/bib/:id                  — the record and its metadata
 *   POST  /t/:slug/catalog/bib/ingest               — a chunk of raw MARC
 *   POST  /t/:slug/catalog/bib                      — create
 *   PATCH /t/:slug/catalog/bib/:id                  — apply ops
 *   GET   /t/:slug/catalog/bib/:id/versions         — history
 *   GET   /t/:slug/catalog/bib/:id/versions/:a/diff — field-level diff
 *   POST  /t/:slug/catalog/bib/:id/restore          — restore a version
 *   GET    /t/:slug/catalog/bib/:id/lock            — who has it open
 *   POST   /t/:slug/catalog/bib/:id/lock            — acquire / renew / take over
 *   POST   /t/:slug/catalog/bib/:id/lock/heartbeat  — keep it alive
 *   DELETE /t/:slug/catalog/bib/:id/lock            — give it back
 *
 * ROUTE ORDER IS LOad-BEARING. `:id` compiles to `([^/]+)`, which matches
 * `abc123.mrc` and captures the dot — so a plain `@Get(':id')` declared first
 * would shadow all three suffixed routes and serve JSON metadata for a `.mrc`
 * request. The four GETs below are declared longest-pattern-first for that
 * reason and must stay that way. (`@Get(':id([^.]+)')` was the other option and
 * throws at boot on path-to-regexp 8.)
 *
 * The whole-catalogue export is NOT here: it is a `catalog_marc` value of the
 * existing `ExportFormat`, produced by the export worker, so that it inherits
 * the job row, the single-slot queue, the disk guard, the four-hour deadline and
 * the retention sweep rather than becoming a second unbounded long-lived
 * response beside the desktop installer download.
 *
 * PERMISSIONS. Three keys, all of which already exist — phase 10 adds none.
 * `cat.bib.read` for the history, the diff and reading the lock holder;
 * `cat.bib.write` for create, edit, restore and every lock operation. Restore is not separated from edit: it produces a state the
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
  constructor(
    @Inject(BibWriteService) private readonly svc: BibWriteService,
    @Inject(BibLockService) private readonly locks: BibLockService,
    @Inject(BibReadService) private readonly reads: BibReadService,
    @Inject(BibIngestService) private readonly ingestSvc: BibIngestService,
    @Inject(BibDeleteService) private readonly deletes: BibDeleteService,
  ) {}

  /**
   * Write a serialized record onto the response.
   *
   * `@Res()` and not a returned value, because the Express adapter does
   * `isObject(body) ? res.json(body) : res.send(String(body))` — a returned
   * `Buffer` is an object, so it would go out as `{"type":"Buffer","data":[…]}`
   * with `Content-Type: application/json`, silently, and look like a working
   * route in every smoke test.
   *
   * THE HEADERS ARE SET LAST, once the bytes are in hand. Everything that can
   * fail — the record missing, the source bytes absent, the writer refusing a
   * record it cannot encode — fails before a byte or a header is committed, so
   * `HttpExceptionFilter` (which always answers `res.status(…).json(body)`) can
   * do its job instead of writing JSON onto a response already promised as MARC.
   */
  private async send(
    tenant: TenantContext,
    id: string,
    format: SerializationFormat,
    fidelity: string | undefined,
    res: Response,
  ): Promise<void> {
    if (fidelity !== undefined && fidelity !== 'source' && fidelity !== 'normalized') {
      throw new BadRequestException(
        '`fidelity` must be `source` (the original bytes of an imported record) or `normalized` (the default).',
      );
    }

    let bytes: Uint8Array;
    let contentType: string;
    if (fidelity === 'source') {
      const blob = await this.reads.readSourceBlob(tenant, id, format);
      bytes = blob.bytes;
      contentType = contentTypeForSourceFormat(blob.sourceFormat);
      if (blob.sha256) res.setHeader('Content-Digest', `sha-256=:${blob.sha256}:`);
    } else {
      const found = await this.reads.read(tenant, id);
      try {
        const out = serializeRecord(found.record, format);
        bytes = out.bytes;
        contentType = out.contentType;
      } catch (err) {
        throw marcWriteToHttp(err, format);
      }
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${id}.${format}"`);
    // A catalogue record is not secret, but it is tenant data and an
    // intermediary has no business holding it.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(bytes));
  }

  /**
   * The record as ISO 2709 — the format every other ILS in the world loads.
   *
   * `?fidelity=source` serves the ORIGINAL BYTES of an imported record, exactly,
   * or refuses with a reason. See `BibReadService.readSourceBlob`: it never
   * falls back to a fresh serialization, because a re-derivation that merely
   * looks similar is the one wrong answer nobody can detect.
   */
  /**
   * The catalogue list (2.0 phase 20a).
   *
   * Declared FIRST among the GETs. `@Get()` matches the empty path and cannot
   * be shadowed by `@Get(':id')`, so this is convention rather than necessity —
   * but the convention is load-bearing on this controller (see the class
   * docblock on `:id` capturing the dot in `abc123.mrc`), and a reader should
   * not have to work out which of the six GETs are ordered on purpose.
   *
   * `cat.bib.read`, the key the rest of the read surface already uses. No new
   * permission: a cataloguer who may open a record may list records, and
   * inventing `cat.bib.list` would mean editing all four role templates for a
   * distinction nobody has asked for.
   */
  @RequirePermission('cat.bib.read')
  @Get()
  async list(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(BibListQueryDto, rawQuery ?? {});
    return this.reads.list(tenant, q);
  }

  @RequirePermission('cat.bib.read')
  @Get(':id.mrc')
  async readMrc(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Query('fidelity') fidelity: string | undefined,
    @Res() res: Response,
  ) {
    await this.send(tenant, id, 'mrc', fidelity, res);
  }

  /** The record as MARCXML — the format with no size ceiling. */
  @RequirePermission('cat.bib.read')
  @Get(':id.xml')
  async readXml(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Query('fidelity') fidelity: string | undefined,
    @Res() res: Response,
  ) {
    await this.send(tenant, id, 'xml', fidelity, res);
  }

  /**
   * The record as MARC-in-JSON.
   *
   * Ross Singer's shape, not the `{t, i, s}` the store holds — that one is a
   * storage decision (at 5M records the key names are ~15 % of the JSONB) and
   * §5 says it is "interchange only… never appears in a public API response".
   */
  @RequirePermission('cat.bib.read')
  @Get(':id.json')
  async readJson(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Query('fidelity') fidelity: string | undefined,
    @Res() res: Response,
  ) {
    await this.send(tenant, id, 'json', fidelity, res);
  }

  /**
   * The record, its metadata and its provenance.
   *
   * Phase 10 shipped `PATCH :id` with `expectedContentHash` as a compare-and-swap
   * precondition and no way to obtain that hash: the only sources were the
   * response to a write you had just made, or the version list. So an editor
   * that lost its page could not save. This closes that.
   *
   * `source.hasSourceBlob` is a BOOLEAN computed as `source_blob IS NOT NULL` in
   * SQL. The blob itself is never selected here — the 1:1 table split exists to
   * keep it out of `SELECT *` forever, and this is the hot read that would have
   * defeated it.
   */
  @RequirePermission('cat.bib.read')
  @Get(':id')
  async read(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.reads.read(tenant, id);
  }

  /**
   * A chunk of raw MARC, written through the ordinary create path.
   *
   * `application/marc` bytes, not multipart and not JSON: a MARC file is bytes,
   * and base64 in a JSON envelope would cost a third of the body for nothing.
   *
   * BOUNDED — see `bib.constants.ts`, where every number is measured against
   * `SHUTDOWN_DEADLINE_MS`. A bigger file is chunked by the caller, which
   * `pnpm catalog:import` does with the codec's own splitter so a boundary never
   * falls inside a record.
   *
   * `Idempotency-Key` is REQUIRED here, unlike everywhere else on this
   * controller. `marc_records_control_number_unique_active` only constrains
   * records that HAVE an 001, so a file of records without one has no uniqueness
   * at all and a client retry after a socket timeout would silently duplicate
   * every record in the chunk. The key is the only defence, so its absence is a
   * 400 rather than a shrug.
   */
  @RequirePermission('cat.bib.write')
  @Post('ingest')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  async ingest(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Req() req: Request,
  ) {
    if (!req.header('idempotency-key')) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.ingestNeedsIdempotencyKey',
        message:
          'Send an Idempotency-Key header. Records without an 001 have no uniqueness constraint, ' +
          'so a retried chunk would be loaded twice with nothing to notice it.',
      });
    }
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.ingestNotMarc',
        message:
          'Send raw ISO 2709 bytes with Content-Type: application/marc. ' +
          `The body may be up to ${CATALOG_INGEST_MAX_BYTES} bytes.`,
      });
    }
    return this.ingestSvc.ingestIso2709(tenant, actor, body);
  }

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

  // -- the record lock -------------------------------------------------------
  //
  // ADVISORY. Nothing below is consulted by PATCH: an import, an overlay, a
  // merge, a batch job and the phase-19 copy-forward all have to be able to
  // write a record a cataloguer has open, so a lock that could refuse a save
  // would be one somebody has to override at 2am. These routes tell the editor
  // whom to name in a banner, and that is all.
  //
  // No new permission key. `cat.bib.write` covers acquire, heartbeat, take-over
  // and release, because all four are things a person who may edit the record
  // may do — including taking it from a colleague, which is a conversation
  // rather than a privilege. `cat.lock.override` was considered and deferred:
  // permissions.ts records that keys are forever, and inventing one for a
  // workflow no library has asked for yet is a guess nothing can check.
  //
  // No Idempotency-Key. Every one of these is already idempotent by
  // construction — acquire is an upsert, heartbeat renews, release is a DELETE
  // that no-ops — and the interceptor would replay a cached 409 to a caller
  // whose second attempt should have succeeded.

  @RequirePermission('cat.bib.read')
  @Get(':id/lock')
  async lock(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return { lock: await this.locks.current(tenant, id) };
  }

  @RequirePermission('cat.bib.write')
  @Post(':id/lock')
  @HttpCode(200)
  async acquireLock(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(AcquireLockDto, raw ?? {});
    return this.locks.acquire(tenant, actor, {
      recordId: id,
      sessionId: dto.sessionId,
      seenSessionId: dto.seenSessionId,
    });
  }

  @RequirePermission('cat.bib.write')
  @Post(':id/lock/heartbeat')
  @HttpCode(200)
  async heartbeatLock(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(LockSessionDto, raw ?? {});
    return this.locks.heartbeat(tenant, actor, { recordId: id, sessionId: dto.sessionId });
  }

  /**
   * DELETE with a body, deliberately: the session is a credential for the lock,
   * not an identifier of it, and putting it in the query string would write it
   * into the access log.
   */
  /**
   * Delete a record — a TOMBSTONE, not a row that goes away.
   *
   * §5 commits to OAI-PMH `deletedRecord=persistent`, which the matrix calls "a
   * promise about the database": a harvester that saw the record last month has
   * to be told it was deleted, and cannot be if the row is gone.
   *
   * Declared BEFORE `:id/lock` so the two DELETEs cannot be confused, and it
   * takes a reason because removing a record from a catalogue is a decision a
   * library may be asked about.
   */
  @RequirePermission('cat.bib.delete')
  @Delete(':id')
  async remove(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Query() rawQuery: unknown,
  ) {
    const q = await validateDto(DeleteRecordDto, rawQuery ?? {});
    return this.deletes.delete(tenant, actor, id, q.reason);
  }

  @RequirePermission('cat.bib.delete')
  @Post(':id/restore-deleted')
  @HttpCode(200)
  async restoreDeleted(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
  ) {
    return this.deletes.restore(tenant, actor, id);
  }

  @RequirePermission('cat.bib.write')
  @Delete(':id/lock')
  @HttpCode(200)
  async releaseLock(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(LockSessionDto, raw ?? {});
    return this.locks.release(tenant, actor, { recordId: id, sessionId: dto.sessionId });
  }
}
