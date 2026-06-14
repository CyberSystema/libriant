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

type Target = { label: string; dbUrl: string };
type TableData = { name: string; columns: string[]; rows: Record<string, unknown>[] };
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
    await controlDb.exportJob
      .update({
        where: { id: jobId },
        data: { status: 'failed', finishedAt: new Date(), error: oneLine((err as Error).message) },
      })
      .catch(() => {});
  }
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
  let done = 0;
  for (const target of targets) {
    const folder = multi ? `${target.label}/` : '';
    await addTargetToArchive(job.format, target, archive, folder, dir, job.id, tempFiles);
    await ctx.setProgress(++done, targets.length);
  }
  await archive.finalize();
  await closed;
  // The zip has read + buffered the temp dumps by now — clean them up.
  for (const f of tempFiles) await fs.rm(f, { force: true }).catch(() => {});
  const bytes = (await fs.stat(outPath)).size;
  return { filePath: outPath, fileName: `${baseName}.zip`, bytes };
}

/** Single target, non-CSV → one standalone file. */
async function produceSingleFile(
  format: ExportFormat,
  target: Target,
  outPath: string,
): Promise<void> {
  if (format === 'sql') {
    await dumpSql(target.dbUrl, outPath);
    return;
  }
  const data = await readTables(target.dbUrl);
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
    const data = await readTables(target.dbUrl);
    for (const table of data) {
      archive.append(toCsv(table), { name: `${folder}${table.name}.csv` });
    }
    return;
  }
  if (format === 'json') {
    const data = await readTables(target.dbUrl);
    archive.append(JSON.stringify(tablesToObject(data), null, 2), {
      name: `${folder}${target.label}.json`,
    });
    return;
  }
  if (format === 'xlsx') {
    const data = await readTables(target.dbUrl);
    const buf = (await buildWorkbook(data).xlsx.writeBuffer()) as unknown as Buffer;
    archive.append(buf, { name: `${folder}${target.label}.xlsx` });
    return;
  }
  // sql — pg_dump to a temp file, add it; the caller deletes it after the zip
  // finalizes (archiver reads it during finalize()).
  const tmp = path.join(tmpDir, `${jobId}-${target.label}.sql`);
  await dumpSql(target.dbUrl, tmp);
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
    return [{ label: 'control', dbUrl: superuserUrl }];
  }
  const tenants = await controlDb.tenant.findMany({
    where: { status: { not: 'archived' } },
    select: { slug: true, dbUrl: true },
    orderBy: { slug: 'asc' },
  });
  return [
    { label: 'control', dbUrl: superuserUrl },
    ...tenants.map((t) => ({ label: t.slug, dbUrl: t.dbUrl })),
  ];
}

/** pg_dump a DB to a plain-SQL file. Requires postgresql-client in the image. */
async function dumpSql(dbUrl: string, outPath: string): Promise<void> {
  await execFileP(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', '--file', outPath, dbUrl],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/** Read every public table's rows. Generic — works for control + tenant DBs. */
async function readTables(dbUrl: string): Promise<TableData[]> {
  const client = new PgClient({ connectionString: dbUrl });
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
    for (const name of tables) {
      const res = await client.query(`SELECT * FROM "${name}"`);
      out.push({ name, columns: res.fields.map((f) => f.name), rows: res.rows });
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
    for (const row of table.rows) ws.addRow(table.columns.map((c) => cellValue(row[c])));
  }
  return wb;
}

/**
 * Neutralize spreadsheet formula injection: Excel/Sheets execute a cell whose
 * text begins with = + - @ (or a leading tab/CR). Member/book free-text flows
 * into exports, so prefix such values with an apostrophe to force literal text.
 * Applied to STRING values only — real numbers/dates stay typed.
 */
function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cellValue(v: unknown): string | number | boolean | Date | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'object') return neutralizeFormula(JSON.stringify(v));
  if (typeof v === 'string') return neutralizeFormula(v);
  return neutralizeFormula(String(v));
}

function toCsv(table: TableData): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s: string;
    if (Buffer.isBuffer(v)) s = v.toString('base64');
    else if (v instanceof Date) s = v.toISOString();
    else if (typeof v === 'object') s = neutralizeFormula(JSON.stringify(v));
    else if (typeof v === 'string') s = neutralizeFormula(v);
    else s = String(v); // number/boolean — safe, no neutralization needed
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns.map(esc).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => esc(row[c])).join(','));
  return lines.join('\r\n');
}
