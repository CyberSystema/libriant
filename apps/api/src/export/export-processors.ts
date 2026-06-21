import { execFile } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import type { ExportFormat, ExportJob } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';

const execFileP = promisify(execFile);
const oneLine = (s: string) => s.split('\n').slice(0, 4).join(' ').slice(0, 500);

// --- safety bounds (EXP-002) ----------------------------------------------
// A slow/hung tenant DB must not be able to wedge the single-slot export
// queue, and a runaway table must not OOM-kill the worker. These cap how long
// any one statement/connection may take and how many rows a single export may
// pull into memory before we abort (we buffer per-table; without pg-cursor in
// the image there's no server-side streaming, so a hard row cap is the
// backstop).
const STATEMENT_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 15_000;
const MAX_EXPORT_ROWS = 2_000_000;

class ExportTooLargeError extends Error {}

/**
 * Strip credentials from any Postgres connection string embedded in a string.
 * pg_dump failures surface the full command (incl. `postgresql://user:pass@…`)
 * in the error message, which is stored on the job's tenant-visible `error`
 * field — so this MUST run before any error is persisted/returned, or a tenant
 * can read the (super)user DB password from a failed export.
 */
export const redactSecrets = (s: string): string =>
  // A14-04: the password may itself contain '@' (raw, un-encoded in some
  // connection strings). The old `[^@/\s]+@` stopped at the FIRST '@', leaking
  // the rest of the password. Match the password greedily up to the LAST '@'
  // before the host (host has no '@' or '/'), so `user:p@ss@host/db` fully
  // redacts to `user:***@host/db`.
  s.replace(/(postgres(?:ql)?:\/\/[^:@/\s]+:)[^\s]*@([^@\s/]+)/gi, '$1***@$2');

/**
 * Sensitive control-plane columns that must never leave the box in a plaintext
 * export (EXP-004). A control/all-scope dump otherwise ships every user/admin
 * password hash, encrypted TOTP secret, encrypted per-tenant DB role secret and
 * onboarding/invite token to an unencrypted 24h file — material for offline
 * cracking and lateral movement. We redact the *values* (keep the column so the
 * shape is unchanged) for the readTables-based formats (csv/json/xlsx). SQL
 * dumps (pg_dump) of the control DB are blocked entirely below.
 *
 * Keyed by the Postgres table name (schema.prisma @@map), lowercased. The
 * regex catch-all in `isSensitive` additionally redacts any column whose name
 * mentions a token/secret/password-hash in *any* table, so a future table that
 * adds such a column is covered without a code change here.
 */
const SENSITIVE_COLUMNS: Record<string, ReadonlySet<string>> = {
  users: new Set(['passwordhash', 'mfasecretcipher', 'mfanonce', 'mfakeyid', 'invitetoken']),
  admin_users: new Set(['passwordhash', 'mfasecretcipher', 'mfanonce', 'mfakeyid']),
  tenant_db_credentials: new Set(['encryptedpwd', 'encryptionkeyid', 'encryptionnonce']),
  support_keys: new Set(['codehash']),
  // A14-02: the raw Stripe event payload carries customer PII (email, name,
  // billing address, card last4). It's kept in the DB for the retry sweep, but
  // must NOT ship in a control/all export — redact the value (shape preserved).
  stripe_webhook_events: new Set(['payloadjson']),
};
const REDACTED = '[redacted]';

/** True when `column` of `table` holds a secret that must be omitted/redacted. */
function isSensitive(table: string, column: string): boolean {
  const c = column.toLowerCase();
  // Catch-all: any column whose name mentions a token/secret/password hash.
  if (/token|secret|passwordhash|password_hash/.test(c)) return true;
  return SENSITIVE_COLUMNS[table.toLowerCase()]?.has(c) ?? false;
}

/** Replace sensitive values in-place so control-plane exports never ship them. */
function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    if (isSensitive(table, k) && row[k] !== null && row[k] !== undefined) {
      row[k] = REDACTED;
    }
  }
  return row;
}

type Target = { label: string; dbUrl: string; isControl?: boolean };
type TableData = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  // Columns the pg driver returns as strings but which are genuinely numeric
  // (int8/numeric/etc). Formula-neutralization must skip these so a bigint like
  // `-42` isn't apostrophe-prefixed into text (EXP-006).
  numericColumns: ReadonlySet<string>;
};
type Ctx = { setProgress: (done: number, total: number) => Promise<void> };

// --- entry point -----------------------------------------------------------

export async function processExportJob(jobId: string): Promise<void> {
  const job = await controlDb.exportJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  await controlDb.exportJob.update({
    where: { id: jobId },
    data: { status: 'running', startedAt: new Date() },
  });
  const ctx: Ctx = {
    setProgress: async (done, total) => {
      await controlDb.exportJob.update({
        where: { id: jobId },
        data: { progressDone: done, progressTotal: total },
      });
    },
  };
  try {
    const { filePath, fileName, bytes } = await generate(job, ctx);
    await controlDb.exportJob.update({
      where: { id: jobId },
      data: { status: 'completed', finishedAt: new Date(), filePath, fileName, fileBytes: bytes },
    });
  } catch (err) {
    // EXP-003: a crashed/failed export must not leave its partial output file
    // (or temp dumps) orphaned on the shared volume — reclaim them here.
    await purgeJobArtifacts(jobId).catch(() => {});
    await controlDb.exportJob
      .update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          // redactSecrets runs regardless of requester kind so the superuser /
          // tenant DB password can't leak through job.error (EXP-001 /
          // export-new-SQL).
          error: redactSecrets(oneLine((err as Error).message)),
        },
      })
      .catch(() => {});
  }
}

/**
 * Remove every on-disk artifact for a job — the produced output (`${jobId}.*`)
 * and any temp pg_dump files (`${jobId}-*.sql`) — regardless of what the DB row
 * recorded. Used on the failure path and by the cleanup sweep for stale jobs
 * whose `filePath` was never written (EXP-003).
 */
export async function purgeJobArtifacts(jobId: string): Promise<number> {
  const env = loadEnv();
  const dir = path.resolve(env.storageRoot, '_exports');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // dir may not exist yet — nothing to purge
  }
  let removed = 0;
  for (const name of entries) {
    if (name === `${jobId}` || name.startsWith(`${jobId}.`) || name.startsWith(`${jobId}-`)) {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

// --- generation ------------------------------------------------------------

async function generate(
  job: ExportJob,
  ctx: Ctx,
): Promise<{ filePath: string; fileName: string; bytes: number }> {
  const env = loadEnv();
  const dir = path.resolve(env.storageRoot, '_exports');
  await fs.mkdir(dir, { recursive: true });

  const targets = await resolveTargets(job, env.pgSuperuserUrl);
  const stamp = new Date().toISOString().slice(0, 10);
  const scopeLabel = job.scope === 'tenant' ? (targets[0]?.label ?? 'library') : job.scope;
  const baseName = `libriant-${scopeLabel}-${stamp}`;
  const multi = targets.length > 1;
  // CSV is inherently one-file-per-table, and multi-DB always bundles → zip.
  const needsZip = job.format === 'csv' || multi;

  await ctx.setProgress(0, targets.length);

  if (!needsZip) {
    const target = targets[0];
    if (!target) throw new Error('No databases resolved for this export.');
    const outPath = path.join(dir, `${job.id}.${job.format}`);
    await produceSingleFile(job.format, target, outPath);
    await ctx.setProgress(1, targets.length);
    const bytes = (await fs.stat(outPath)).size;
    return { filePath: outPath, fileName: `${baseName}.${job.format}`, bytes };
  }

  const outPath = path.join(dir, `${job.id}.zip`);
  const output = createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);

  const tempFiles: string[] = [];
  let finalized = false;
  try {
    let done = 0;
    for (const target of targets) {
      const folder = multi ? `${target.label}/` : '';
      await addTargetToArchive(job.format, target, archive, folder, dir, job.id, tempFiles);
      await ctx.setProgress(++done, targets.length);
    }
    await archive.finalize();
    await closed;
    finalized = true;
    const bytes = (await fs.stat(outPath)).size;
    return { filePath: outPath, fileName: `${baseName}.zip`, bytes };
  } finally {
    // EXP-003: the temp .sql dumps must be removed on BOTH the success and the
    // error path (the zip has read + buffered them by finalize() on success);
    // before this was only reached on success and leaked them on failure.
    if (!finalized) archive.abort(); // release the write stream on the error path
    for (const f of tempFiles) await fs.rm(f, { force: true }).catch(() => {});
  }
}

/** Single target, non-CSV → one standalone file. */
async function produceSingleFile(
  format: ExportFormat,
  target: Target,
  outPath: string,
): Promise<void> {
  if (format === 'sql') {
    await dumpSql(target, outPath);
    return;
  }
  const data = await readTables(target);
  if (format === 'json') {
    await fs.writeFile(outPath, JSON.stringify(tablesToObject(data), null, 2), 'utf8');
    return;
  }
  // xlsx
  const wb = buildWorkbook(data);
  await wb.xlsx.writeFile(outPath);
}

/** Append one DB's artifact(s) to the zip under `folder`. */
async function addTargetToArchive(
  format: ExportFormat,
  target: Target,
  archive: archiver.Archiver,
  folder: string,
  tmpDir: string,
  jobId: string,
  tempFiles: string[],
): Promise<void> {
  if (format === 'csv') {
    const data = await readTables(target);
    for (const table of data) {
      archive.append(toCsv(table), { name: `${folder}${table.name}.csv` });
    }
    return;
  }
  if (format === 'json') {
    const data = await readTables(target);
    archive.append(JSON.stringify(tablesToObject(data), null, 2), {
      name: `${folder}${target.label}.json`,
    });
    return;
  }
  if (format === 'xlsx') {
    const data = await readTables(target);
    const buf = (await buildWorkbook(data).xlsx.writeBuffer()) as unknown as Buffer;
    archive.append(buf, { name: `${folder}${target.label}.xlsx` });
    return;
  }
  // sql — pg_dump to a temp file, add it; the caller deletes it after the zip
  // finalizes (archiver reads it during finalize()).
  const tmp = path.join(tmpDir, `${jobId}-${target.label}.sql`);
  await dumpSql(target, tmp);
  archive.file(tmp, { name: `${folder}${target.label}.sql` });
  tempFiles.push(tmp);
}

// --- per-DB helpers --------------------------------------------------------

async function resolveTargets(job: ExportJob, superuserUrl: string): Promise<Target[]> {
  if (job.scope === 'tenant') {
    const t = await controlDb.tenant.findUnique({
      where: { id: job.targetTenantId ?? '' },
      select: { slug: true, dbUrl: true },
    });
    if (!t) throw new Error('Target tenant not found.');
    return [{ label: t.slug, dbUrl: t.dbUrl }];
  }
  if (job.scope === 'control') {
    return [{ label: 'control', dbUrl: superuserUrl, isControl: true }];
  }
  const tenants = await controlDb.tenant.findMany({
    where: { status: { not: 'archived' } },
    select: { slug: true, dbUrl: true },
    orderBy: { slug: 'asc' },
  });
  return [
    { label: 'control', dbUrl: superuserUrl, isControl: true },
    ...tenants.map((t) => ({ label: t.slug, dbUrl: t.dbUrl })),
  ];
}

/**
 * pg_dump a DB to a plain-SQL file. Requires postgresql-client in the image.
 *
 * Credentials are passed via PG* env (never argv) so the connection string —
 * and especially the superuser password on the control/all path — can't leak
 * through `ps`, the dump banner, or an error message persisted to the
 * admin-visible `job.error` field (EXP-001 / export-new-SQL).
 *
 * A plain pg_dump can't selectively redact the sensitive control-plane columns
 * (EXP-004), so we refuse to SQL-dump the control DB outright — control/all
 * SQL exports would otherwise ship every password hash / encrypted secret
 * verbatim. Callers should use csv/json/xlsx for control data (those go through
 * readTables, which redacts).
 */
async function dumpSql(target: Target, outPath: string): Promise<void> {
  if (target.isControl) {
    throw new Error(
      'SQL export of the control database is not supported (it would include credential ' +
        'and secret columns). Use the CSV, JSON or XLSX format for control-plane data.',
    );
  }
  const u = new URL(target.dbUrl);
  // statement_timeout caps any single server-side statement (EXP-002).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGOPTIONS: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    PGCONNECT_TIMEOUT: String(Math.ceil(CONNECTION_TIMEOUT_MS / 1000)),
  };
  // Dump goes to --file, not stdout, so the 16MB maxBuffer cap is unnecessary.
  await execFileP(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', '--file', outPath],
    {
      env,
    },
  );
}

// Postgres type OIDs for columns the driver hands back as JS strings but which
// are genuinely numeric (int8/numeric/float/money). Used to skip EXP-006
// formula-neutralization on real numbers.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);

/** Read every public table's rows. Generic — works for control + tenant DBs. */
async function readTables(target: Target): Promise<TableData[]> {
  const client = new PgClient({
    connectionString: target.dbUrl,
    // EXP-002: cap how long we wait to connect, and cap any single statement
    // server-side so a hung/slow tenant DB can't wedge the single-slot worker.
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const tables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
         ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);
    const out: TableData[] = [];
    let totalRows = 0;
    for (const name of tables) {
      const res = await client.query(`SELECT * FROM "${name}"`);
      // EXP-002: hard backstop against a runaway table OOM-killing the worker.
      // (No pg-cursor in the image, so we can't stream — buffering is bounded
      // by this cap instead.)
      totalRows += res.rowCount ?? res.rows.length;
      if (totalRows > MAX_EXPORT_ROWS) {
        throw new ExportTooLargeError(
          `Export exceeds the ${MAX_EXPORT_ROWS.toLocaleString()}-row limit; ` +
            'please narrow the scope or contact support.',
        );
      }
      const numericColumns = new Set(
        res.fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name),
      );
      // EXP-004: control-plane tables carry password hashes, encrypted TOTP /
      // DB-role secrets and invite tokens — redact those values before they
      // ever touch disk in a (non-SQL) control/all export.
      const rows = target.isControl ? res.rows.map((r) => redactRow(name, r)) : res.rows;
      out.push({ name, columns: res.fields.map((f) => f.name), rows, numericColumns });
    }
    return out;
  } finally {
    await client.end().catch(() => {});
  }
}

function tablesToObject(data: TableData[]): Record<string, unknown[]> {
  const obj: Record<string, unknown[]> = {};
  for (const t of data) obj[t.name] = t.rows.map(normalizeRow);
  return obj;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = jsonValue(v);
  return out;
}

function jsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (v instanceof Date) return v.toISOString();
  return v;
}

function buildWorkbook(data: TableData[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  if (data.length === 0) {
    wb.addWorksheet('empty');
    return wb;
  }
  for (const table of data) {
    // Sheet names: max 31 chars, no []*?/\ — keep it simple.
    const sheetName = table.name.replace(/[[\]*?/\\]/g, '_').slice(0, 31) || 'sheet';
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(table.columns);
    for (const row of table.rows) {
      ws.addRow(table.columns.map((c) => cellValue(row[c], table.numericColumns.has(c))));
    }
  }
  return wb;
}

/**
 * Neutralize spreadsheet formula injection: Excel/Sheets execute a cell whose
 * text begins with = + - @ (or a leading tab/CR). Member/book free-text flows
 * into exports, so prefix such values with an apostrophe to force literal text.
 * Applied to STRING values only — real numbers/dates stay typed.
 *
 * Exported so the CSV/XLSX import pipeline can reuse the exact same rule
 * (apps/api/src/import imports it from ../export/export-processors.js).
 */
export function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * EXP-006: the pg driver hands back bigint/numeric/money columns as strings,
 * and a value like `-42` would otherwise trip neutralizeFormula and be turned
 * into the text `'-42`. When the column is known-numeric we skip neutralization
 * entirely — the value is a real number, not attacker-controlled free text.
 */
const isNumericString = (s: string): boolean => /^[+-]?\d+(\.\d+)?$/.test(s);

function cellValue(v: unknown, numericColumn = false): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') return neutralizeFormula(JSON.stringify(v));
  if (typeof v === 'string') return numericColumn && isNumericString(v) ? v : neutralizeFormula(v);
  return neutralizeFormula(String(v));
}

function toCsv(table: TableData): string {
  const esc = (v: unknown, numericColumn = false): string => {
    if (v === null || v === undefined) return '';
    let s: string;
    if (Buffer.isBuffer(v)) s = v.toString('base64');
    else if (v instanceof Date) s = v.toISOString();
    else if (typeof v === 'object') s = neutralizeFormula(JSON.stringify(v));
    else if (typeof v === 'string')
      s = numericColumn && isNumericString(v) ? v : neutralizeFormula(v);
    else s = String(v); // number/boolean — safe, no neutralization needed
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns.map((c) => esc(c)).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => esc(row[c], table.numericColumns.has(c))).join(','));
  }
  return lines.join('\r\n');
}
