import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { controlDb, type ImportBatch, type ImportEntityKind } from '@libriant/db-control';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ImportQueueService } from './import-queue.service.js';
import { deleteStaged, stageFile } from './import-staging.js';
import { stagingExtFor } from './import.constants.js';
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

@Injectable()
export class ImportService {
  constructor(@Inject(ImportQueueService) private readonly queue: ImportQueueService) {}

  // ---- upload ------------------------------------------------------------
  async createBatch(tenant: TenantContext, input: UploadInput) {
    const entityKind = this.requireEntityKind(input.entityKind);
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
    const batch = await controlDb.importBatch.create({
      data: {
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
      },
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
    const updated = await controlDb.importBatch.update({
      where: { id: batch.id },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    // Running jobs poll status and abort; staging is cleared on next finish.
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
