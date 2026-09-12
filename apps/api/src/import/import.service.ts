import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { controlDb, Prisma, type ImportBatch, type ImportEntityKind } from '@libriant/db-control';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ImportQueueService } from './import-queue.service.js';
import { deleteStaged, stageFile } from './import-staging.js';
import {
  IMPORT_MAX_STAGED_BATCHES,
  IMPORT_MAX_STAGED_BYTES,
  IMPORT_STAGED_STATUSES,
  stagingExtFor,
} from './import.constants.js';
import { autoMap, type ColumnMapping } from './mapping/auto-map.js';
import { IMPORT_ENTITY_KINDS, mappableFields } from './mapping/entity-fields.js';
import { detectFormat, parseByFormat } from './parsers/index.js';
import { ParseError, type ParsedColumn, type SourceFormat } from './parsers/types.js';

const PREVIEW_ROWS = 20;
// IMP-06: bound how many bytes the (synchronous) preview tokenizer walks for
// line-oriented formats. A 64 MB CSV would otherwise be fully tokenized on the
// API event loop just to show 20 sample rows. 256 KB comfortably holds 20 wide
// rows; the full file is parsed (off the API process) in the worker at run time.
const PREVIEW_MAX_BYTES = 256 * 1024;
const VALID_FORMATS: readonly SourceFormat[] = ['csv', 'tsv', 'xlsx', 'marc', 'marcxml'];
const DUP_MODES = ['skip', 'update', 'error'] as const;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

export type UploadInput = {
  entityKind: string;
  file: { buffer: Buffer; originalname: string; mimetype: string };
  format?: string;
  encoding?: string;
  delimiter?: string;
  sheetName?: string;
  hasHeader?: boolean;
  createdByUserId?: string | null;
};

export type BatchDto = ReturnType<ImportService['toDto']>;

/**
 * How long an inserted-but-unwritten batch holds its staging slot. Long enough
 * to cover a large upload's disk write, short enough that a crashed request
 * does not park a slot until someone notices.
 */
const STAGING_RESERVATION_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class ImportService {
  constructor(@Inject(ImportQueueService) private readonly queue: ImportQueueService) {}

  // ---- upload ------------------------------------------------------------
  async createBatch(tenant: TenantContext, input: UploadInput) {
    const entityKind = this.requireEntityKind(input.entityKind);
    // input-and-files-06: refuse BEFORE parsing a preview or writing a byte.
    // The staging directory is excluded from the tenant's storage quota, so
    // this is the only thing standing between a retry loop and a full shared
    // volume — and the volume is shared with every other library's covers and
    // with the export artifacts.
    // The budget is no longer checked here. See reserveBatch(): the check and
    // the row that consumes it have to happen under one lock, or a burst of
    // concurrent uploads all read the same pre-burst total and all pass.
    const format = this.resolveFormat(input.format, input.file);
    const noHeader = input.hasHeader === false;

    // IMP-06: only feed the preview tokenizer a bounded prefix for line-oriented
    // formats so a large upload can't stall the API event loop while we sample
    // PREVIEW_ROWS. xlsx (a zip) and binary/XML MARC can't be byte-sliced; they
    // bound themselves by row count in their own parsers. The full buffer is
    // still staged below for the worker.
    const previewBuffer =
      (format === 'csv' || format === 'tsv') && input.file.buffer.byteLength > PREVIEW_MAX_BYTES
        ? input.file.buffer.subarray(0, PREVIEW_MAX_BYTES)
        : input.file.buffer;

    let preview;
    try {
      preview = await parseByFormat(format, previewBuffer, {
        maxRows: PREVIEW_ROWS,
        encoding: input.encoding,
        delimiter: input.delimiter,
        sheetName: input.sheetName,
        noHeader,
      });
    } catch (err) {
      if (err instanceof ParseError) throw new BadRequestException(err.message);
      throw new BadRequestException(`Could not read the file: ${(err as Error).message}`);
    }
    if (preview.columns.length === 0) {
      throw new BadRequestException('No columns were detected in the file.');
    }

    const mapping = autoMap(entityKind, preview.columns);
    const batch = await this.reserveBatch(tenant, input.file.buffer.byteLength, {
      tenantId: tenant.id,
      entityKind,
      format,
      status: 'uploaded',
      originalName: input.file.originalname.slice(0, 255),
      stagingPath: '',
      sizeBytes: input.file.buffer.byteLength,
      encoding: preview.meta.encoding ?? null,
      delimiter: preview.meta.delimiter ?? null,
      sheetName: preview.meta.sheetName ?? null,
      hasHeaderRow: !noHeader,
      columnsJson: {
        columns: preview.columns,
        sample: preview.rows.slice(0, 10),
        availableSheets: preview.meta.availableSheets ?? [],
      } as object,
      mappingJson: mapping as object,
      duplicateMode: 'skip',
      // The column has existed since the model was written — "Control-plane
      // User.id of the librarian who started the import … an audit pointer" —
      // and nothing ever wrote it. `createBatch` took it, the controller passed
      // it from the session, and it stopped here, so every import in the
      // product's history is attributed to nobody. Found in 2.0 phase 20c,
      // where the 2.0 engine reads it to name an actor on the MARC version row
      // it writes: without this line every imported record says `system`.
      createdByUserId: input.createdByUserId ?? null,
    });
    const stagingPath = await stageFile(batch.id, stagingExtFor(format), input.file.buffer);
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: { stagingPath },
    });

    return {
      batch: this.toDto(updated),
      columns: preview.columns,
      sample: preview.rows,
      mapping,
      targetFields: mappableFields(entityKind),
      availableSheets: preview.meta.availableSheets ?? [],
    };
  }

  // ---- read --------------------------------------------------------------
  async list(tenant: TenantContext) {
    const rows = await controlDb.importBatch.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((r) => this.toDto(r)) };
  }

  async get(tenant: TenantContext, id: string) {
    const batch = await this.require(tenant, id);
    const cols = (batch.columnsJson ?? {}) as {
      columns?: ParsedColumn[];
      sample?: unknown[];
      availableSheets?: string[];
    };
    return {
      batch: this.toDto(batch),
      columns: cols.columns ?? [],
      sample: cols.sample ?? [],
      mapping: (batch.mappingJson ?? {}) as ColumnMapping,
      targetFields: mappableFields(batch.entityKind),
      availableSheets: cols.availableSheets ?? [],
    };
  }

  // ---- mapping -----------------------------------------------------------
  async setMapping(
    tenant: TenantContext,
    id: string,
    body: { mapping?: unknown; duplicateMode?: unknown; options?: unknown },
  ) {
    const batch = await this.require(tenant, id);
    this.assertEditable(batch);
    const mapping = this.validateMapping(batch.entityKind, body.mapping);
    const duplicateMode = this.validateDupMode(body.duplicateMode) ?? batch.duplicateMode;
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: {
        mappingJson: mapping as object,
        duplicateMode,
        optionsJson: (body.options ?? batch.optionsJson) as object,
        // A mapping change invalidates a prior dry-run.
        status: batch.status === 'validated' ? 'uploaded' : batch.status,
      },
    });
    return this.toDto(updated);
  }

  // ---- run ---------------------------------------------------------------
  async startValidate(tenant: TenantContext, id: string) {
    const batch = await this.requireRunnable(tenant, id);
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: { status: 'validating', error: null, ...this.zeroCounts() },
    });
    await this.queue.enqueue(batch.id, 'validate');
    return this.toDto(updated);
  }

  async startCommit(tenant: TenantContext, id: string) {
    const batch = await this.requireRunnable(tenant, id);
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: { status: 'committing', error: null, startedAt: new Date(), ...this.zeroCounts() },
    });
    await this.queue.enqueue(batch.id, 'commit');
    return this.toDto(updated);
  }

  // ---- issues ------------------------------------------------------------
  async listIssues(
    tenant: TenantContext,
    id: string,
    opts: { after?: string; limit?: number; severity?: 'error' | 'warning' },
  ) {
    const batch = await this.require(tenant, id);
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const rows = await controlDb.importRowIssue.findMany({
      where: { batchId: batch.id, ...(opts.severity ? { severity: opts.severity } : {}) },
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      rowNumber: r.rowNumber,
      phase: r.phase,
      severity: r.severity,
      field: r.field,
      code: r.code,
      message: r.message,
    }));
    return { items, nextCursor: hasMore ? rows[limit - 1]!.id : null };
  }

  async errorsCsv(tenant: TenantContext, id: string): Promise<string> {
    const batch = await this.require(tenant, id);
    const rows = await controlDb.importRowIssue.findMany({
      where: { batchId: batch.id, severity: 'error' },
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
      take: 50_000,
    });
    const header = ['row', 'field', 'code', 'message'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([String(r.rowNumber), r.field ?? '', r.code, r.message].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  // ---- lifecycle ---------------------------------------------------------
  async cancel(tenant: TenantContext, id: string) {
    const batch = await this.require(tenant, id);
    // input-and-files-06: a cancelled batch is terminal — `requireRunnable`
    // refuses to (re)start one — so its staged file serves nothing.
    //
    // Cancelling an `uploaded` batch used to be a free bypass of every staging
    // limit: the row left the counted states, the worker never ran (so nothing
    // ever deleted the file), and the 64 MB stayed on the shared volume
    // forever. Delete it here, but ONLY when no job can be reading it right
    // now — for a running batch the worker's own cancel path does the delete,
    // and yanking the file out from under a live read would turn a clean
    // "canceled" into a confusing "failed: ENOENT".
    const running = batch.status === 'validating' || batch.status === 'committing';
    if (!running) await deleteStaged(batch.stagingPath);
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'canceled',
        finishedAt: new Date(),
        ...(running ? {} : { stagingPath: '' }),
      },
    });
    return this.toDto(updated);
  }

  async remove(tenant: TenantContext, id: string) {
    const batch = await this.require(tenant, id);
    if (batch.status === 'validating' || batch.status === 'committing') {
      throw new ConflictException('This import is still running. Cancel it before deleting.');
    }
    await deleteStaged(batch.stagingPath);
    await controlDb.importBatch.delete({ where: { id: batch.id } });
    return { deleted: true };
  }

  // ---- helpers -----------------------------------------------------------
  /**
   * input-and-files-06: cap the disk one tenant may hold in import staging.
   *
   * Counts only batches that still HAVE a file — `stagingPath` is blanked by
   * every path that deletes one (worker finish, cancel-mid-commit, the
   * abandoned-staging sweeper), so a non-empty `stagingPath` in one of
   * `IMPORT_STAGED_STATUSES` means bytes on the shared volume right now.
   *
   * `failed` counts deliberately, even though a failed batch is re-runnable and
   * keeps its file on purpose: a file that fails to parse fails on every
   * retry, and "retry the broken import twenty times" is the exact honest
   * behaviour that fills the volume. The message tells the librarian which
   * lever to pull.
   */
  /**
   * Take the staging slot AND create the row that occupies it, under one lock.
   *
   * This used to be a bare read-then-write: count the staged batches, then
   * return, then create the row much later. Two things made that advisory
   * rather than enforced. Concurrent requests all read the same pre-burst
   * total and all passed — measured at 30 uploads accepted against a cap of 3.
   * And the count only saw rows whose `stagingPath` was already set, which
   * happens AFTER the file is written, so even a serial burst was invisible to
   * itself for the length of a disk write.
   *
   * Now the ROW is the reservation: it is inserted inside the same transaction
   * that counted, behind `pg_advisory_xact_lock` on the tenant, which is the
   * shape LoansService already uses for per-member and per-book contention.
   * The lock is per tenant, so one library's uploads never block another's.
   *
   * In-flight rows (stagingPath still empty) count against the budget, because
   * their bytes are about to land on the same volume — but only for
   * STAGING_RESERVATION_TTL_MS, so an upload that died between the insert and
   * the write does not hold a slot for ever.
   */
  private async reserveBatch(
    tenant: TenantContext,
    incomingBytes: number,
    data: Prisma.ImportBatchUncheckedCreateInput,
  ) {
    return controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`import-staging:${tenant.id}`}, 0))`;
      await this.assertStagingBudget(tx, tenant, incomingBytes);
      return tx.importBatch.create({ data });
    });
  }

  private async assertStagingBudget(
    tx: Prisma.TransactionClient,
    tenant: TenantContext,
    incomingBytes: number,
  ): Promise<void> {
    const inFlightSince = new Date(Date.now() - STAGING_RESERVATION_TTL_MS);
    const staged = await tx.importBatch.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: [...IMPORT_STAGED_STATUSES] },
        OR: [
          { NOT: { stagingPath: '' } },
          // Reserved but not yet written. Counted so a burst sees itself.
          { stagingPath: '', createdAt: { gte: inFlightSince } },
        ],
      },
      select: { sizeBytes: true },
    });
    const stagedBytes = staged.reduce((n: number, b: { sizeBytes: number }) => n + b.sizeBytes, 0);
    const mb = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

    if (staged.length >= IMPORT_MAX_STAGED_BATCHES) {
      throw new ConflictException(
        `This library already has ${staged.length} uploaded import${
          staged.length === 1 ? '' : 's'
        } waiting to run. Run or delete one before uploading another (at most ${IMPORT_MAX_STAGED_BATCHES} at a time).`,
      );
    }
    if (stagedBytes + incomingBytes > IMPORT_MAX_STAGED_BYTES) {
      throw new ConflictException(
        `Uploaded import files for this library would total ${mb(
          stagedBytes + incomingBytes,
        )} MB, over the ${mb(
          IMPORT_MAX_STAGED_BYTES,
        )} MB staging limit. Run or delete an earlier upload before adding this one.`,
      );
    }
  }

  private requireEntityKind(raw: string): ImportEntityKind {
    if (!(IMPORT_ENTITY_KINDS as readonly string[]).includes(raw)) {
      throw new BadRequestException(
        `Unknown entity "${raw}". One of: ${IMPORT_ENTITY_KINDS.join(', ')}.`,
      );
    }
    return raw as ImportEntityKind;
  }

  private resolveFormat(raw: string | undefined, file: UploadInput['file']): SourceFormat {
    if (raw) {
      if (!(VALID_FORMATS as readonly string[]).includes(raw)) {
        throw new BadRequestException(`Unknown format "${raw}".`);
      }
      return raw as SourceFormat;
    }
    return detectFormat(file.originalname, file.buffer);
  }

  private validateDupMode(raw: unknown): 'skip' | 'update' | 'error' | null {
    if (raw === undefined || raw === null) return null;
    if (!(DUP_MODES as readonly string[]).includes(raw as string)) {
      throw new BadRequestException(`Unknown duplicate mode "${String(raw)}".`);
    }
    return raw as 'skip' | 'update' | 'error';
  }

  private validateMapping(entityKind: ImportEntityKind, raw: unknown): ColumnMapping {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new BadRequestException('mapping must be an object of column → target.');
    }
    const validKeys = new Set(mappableFields(entityKind).map((f) => f.key));
    const out: ColumnMapping = {};
    for (const [col, t] of Object.entries(raw as Record<string, unknown>)) {
      if (t === null) {
        out[col] = { field: null };
        continue;
      }
      if (typeof t !== 'object') {
        throw new BadRequestException(`Invalid target for column "${col}".`);
      }
      const target = t as { field?: unknown; options?: unknown };
      const field = target.field;
      if (field === null || field === undefined) {
        out[col] = { field: null };
      } else if (typeof field !== 'string') {
        throw new BadRequestException(`Target field for "${col}" must be a string or null.`);
      } else if (field.startsWith('custom:')) {
        const key = field.slice('custom:'.length);
        if (!FIELD_KEY_RE.test(key)) {
          throw new BadRequestException(`Invalid custom field key in "${field}".`);
        }
        out[col] = { field, options: this.cleanOptions(target.options) };
      } else if (validKeys.has(field)) {
        out[col] = { field, options: this.cleanOptions(target.options) };
      } else {
        throw new BadRequestException(`Unknown target field "${field}" for column "${col}".`);
      }
    }
    return out;
  }

  private cleanOptions(raw: unknown): ColumnMapping[string]['options'] {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const o = raw as Record<string, unknown>;
    const out: NonNullable<ColumnMapping[string]['options']> = {};
    if (typeof o.dayFirst === 'boolean') out.dayFirst = o.dayFirst;
    if (typeof o.flipName === 'boolean') out.flipName = o.flipName;
    if (typeof o.multiSeparators === 'string') out.multiSeparators = o.multiSeparators;
    return Object.keys(out).length ? out : undefined;
  }

  private assertEditable(batch: ImportBatch): void {
    if (batch.status === 'validating' || batch.status === 'committing') {
      throw new ConflictException('This import is still running. Wait for it to finish.');
    }
    if (batch.status === 'completed' || batch.status === 'partially_completed') {
      throw new ConflictException('This import already ran and cannot be remapped.');
    }
  }

  private async requireRunnable(tenant: TenantContext, id: string): Promise<ImportBatch> {
    const batch = await this.require(tenant, id);
    if (!batch.mappingJson) {
      throw new BadRequestException('Set a column mapping before running the import.');
    }
    // IMP-07 / IMP-02: a 'failed' batch (a hard error, or one reset by the
    // crash-recovery sweep) is re-runnable, because the engine commits each row
    // independently and matches on a natural key.
    //
    // data-integrity-02: that claim was FALSE when it was written, and this
    // comment is why the hole survived review. Four of the seven entity kinds
    // had no natural key at all — a fine was a bare `create` — so re-running a
    // half-done commit duplicated every keyless row it had already written,
    // including patrons' outstanding debts. The claim is now backed by
    // `IMPORT_NATURAL_KEYS` in engine/import-engine.ts, which names the key for
    // every kind and fails to compile if one is added without an answer, and by
    // test/integration/import-reimport.spec.ts, which drives THIS route: it
    // marks a batch `failed`, POSTs /commit again, and asserts the tenant's fine
    // rows and their total in cents do not move.
    //
    // NOTE what re-running still is NOT: an undo. Rows the failed run wrote
    // stay written — a re-run skips them rather than replacing them. Recovering
    // from a run that wrote the WRONG rows is a delete, not a re-import.
    if (!['uploaded', 'validated', 'failed'].includes(batch.status)) {
      throw new ConflictException(`An import in "${batch.status}" can't be (re)started.`);
    }
    // input-and-files-06: the abandoned-staging sweeper deletes the uploaded
    // file after IMPORT_STAGING_TTL_MS and blanks `stagingPath` to record that.
    // Without this guard the run would be enqueued, the worker would fail on
    // ENOENT, and the librarian would read a filesystem error path instead of
    // "upload it again".
    if (!batch.stagingPath) {
      throw new ConflictException(
        'The uploaded file for this import was cleaned up because it sat unused for too long. Upload it again to run it.',
      );
    }
    return batch;
  }

  private async require(tenant: TenantContext, id: string): Promise<ImportBatch> {
    const batch = await controlDb.importBatch.findFirst({
      where: { id, tenantId: tenant.id },
    });
    if (!batch) throw new NotFoundException('Import not found.');
    return batch;
  }

  private zeroCounts() {
    return {
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
      warningRows: 0,
      importedRows: 0,
      updatedRows: 0,
      skippedRows: 0,
      issuesTruncated: false,
    };
  }

  private toDto(b: ImportBatch) {
    return {
      id: b.id,
      entityKind: b.entityKind,
      format: b.format,
      status: b.status,
      originalName: b.originalName,
      sizeBytes: b.sizeBytes,
      encoding: b.encoding,
      delimiter: b.delimiter,
      sheetName: b.sheetName,
      hasHeaderRow: b.hasHeaderRow,
      duplicateMode: b.duplicateMode,
      mapping: (b.mappingJson ?? null) as ColumnMapping | null,
      counts: {
        total: b.totalRows,
        valid: b.validRows,
        errors: b.errorRows,
        warnings: b.warningRows,
        imported: b.importedRows,
        updated: b.updatedRows,
        skipped: b.skippedRows,
      },
      issuesTruncated: b.issuesTruncated,
      error: b.error,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }
}

/**
 * Neutralize spreadsheet formula injection (EXP-007 / IMP-03): Excel/Sheets
 * execute a cell whose text begins with = + - @ (or a leading tab/CR). The
 * errors.csv carries semi-user-derived text (field names, transform messages),
 * so prefix such values with an apostrophe to force literal text — mirroring
 * export-processors' neutralizeFormula so every CSV-producing path is uniformly
 * safe. (Defined locally rather than imported: the export helper is owned by a
 * different module and not exported.)
 */
function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** Minimal RFC-4180 cell quoting for the errors.csv export. */
function csvCell(value: string): string {
  const v = neutralizeFormula(value);
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
