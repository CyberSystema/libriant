import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { promisify } from 'node:util';
// archiver 8 dropped the callable default export (and create/registerFormat)
// in favour of named classes — one per format.
import { ZipArchive, Archiver } from 'archiver';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import type { ExportFormat, ExportJob } from '@libriant/db-control';
import { TENANT_RUNTIME_SELECT, runtimeDbUrl } from '../tenancy/tenant-db-url.js';
import { loadEnv } from '../config/env.js';
import { EXPORT_MAX_RUNTIME_MS } from './export.constants.js';
import { catalogManifest, withCatalogSource, writeCatalogMarc } from './catalog-marc.js';

const execFileP = promisify(execFile);
const oneLine = (s: string) => s.split('\n').slice(0, 4).join(' ').slice(0, 500);

// --- safety bounds (EXP-002 / performance-01) ------------------------------
// A slow/hung tenant DB must not be able to wedge the single-slot export
// queue, so cap how long we wait for a connection and how long any one
// statement may run server-side. With the cursor loop below, the statement
// timeout now applies per FETCH instead of to a whole-table SELECT — a 3M-row
// audit_log no longer has to come back inside 60s to be exportable at all.
const STATEMENT_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Peak memory bound for a read, in BYTES of row payload per FETCH.
 *
 * A fixed row count is not a memory bound, and this is the second time that
 * mattered. performance-01 replaced `SELECT * FROM "audit_log"` (1.4 GB RSS,
 * OOM-killing the 1 GB worker that also runs the email outbox, the CSV/XLSX
 * imports and all nine cron sweeps) with a 5,000-row FETCH — but the tenant
 * schema has unbounded `text` columns (book notes, member notes, MARC blobs),
 * so the tenant, not the constant, decided how much memory 5,000 rows was.
 * 5,000 × a 1 MB notes field is 5 GB, and nothing in the old bound noticed.
 *
 * So the loop targets BYTES and derives the row count from what the table
 * actually measured on the previous FETCH. 8 MiB is deliberately small: it is
 * per concurrent read (the queue has one slot, so one), and the writers behind
 * it buffer only ~64 KB, so the batch is the peak.
 */
const FETCH_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * Row-count clamps around that budget.
 *
 * Upper: round-trip cost. A two-column join table is a few bytes per row and
 * would otherwise ask for millions in one FETCH.
 *
 * Lower: 1, honestly. A single row wider than the whole budget cannot be
 * split any further here — bounding below one row would need value-level
 * streaming (`lo_get`/substring paging), which is a different change. One
 * pathological row is 1 GB worst case (Postgres's own field ceiling); a
 * thousand of them was 1 TB, and that is the difference this makes.
 *
 * Start: 256, and no longer load-bearing. It used to be "the FIRST FETCH has no
 * measurement to go on, so it must be cautious", and 256 rows × a 1 MB field is
 * still 256 MB — which is only survivable by luck. The first FETCH now DOES have
 * a measurement: `tableRowCeiling` measures the widest row in the table before
 * the cursor is declared, and clamps `maxRows` (and therefore this) to fit the
 * byte budget. 256 is just where the ramp starts on an ordinary table.
 */
const FETCH_MAX_ROWS = 5_000;
const FETCH_MIN_ROWS = 1;
const FETCH_START_ROWS = 256;

/**
 * Runaway backstop — no longer a memory bound. The old 2,000,000 was both
 * useless and harmful: useless because it was evaluated AFTER the table had
 * been materialised, harmful because an Institutional library is sold 400k
 * books / 520k copies / 100k members / 2M loans / 3M audit rows (≈6M), so the
 * plan that most needs its data out could never export it — and data
 * portability (GDPR Art. 20) rests on this path. 25M keeps ~4x headroom over
 * the largest plan while still refusing something pathological, and it is now
 * checked up-front from the planner's estimate (assertExportSizeSane) instead
 * of after 1.4 GB of allocation.
 */
const MAX_EXPORT_ROWS = 25_000_000;

class ExportTooLargeError extends Error {}
class ExportTimedOutError extends Error {}
class ExportOutOfSpaceError extends Error {}

/**
 * Free bytes an export must LEAVE on the spool volume.
 *
 * `STORAGE_ROOT/_exports` is not a scratch disk: it is the same volume every
 * tenant's covers, member photos and branding assets live on. csv/json/xlsx
 * each spool the full UNCOMPRESSED artifact there before archiver reads it (the
 * spool is deliberate — feeding a live stream into the archive risks a stalled
 * entry wedging the single-slot queue, EXP-002), so a big export is a
 * multi-gigabyte write onto tenant storage with, until now, nothing checking
 * there was room. Filling that volume does not just fail the export: it fails
 * every upload, every tenant, until someone notices.
 *
 * 2 GiB is a judgement call — enough that uploads keep working and an operator
 * has room to clean up, small enough not to refuse exports on a modest disk.
 */
const SPOOL_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How much larger than the tables' on-disk size the spooled artifact may be.
 *
 * `pg_table_size` counts compressed TOAST and page overhead; CSV/JSON re-expand
 * that to text and add quoting and column names per row. 2× is the working
 * assumption, and it is only used to decide whether to START — the periodic
 * re-check below is what catches the case where it was wrong.
 */
const SPOOL_SIZE_MULTIPLIER = 2;

/** Upper bound on how often the streaming re-check may call statfs. */
const SPACE_RECHECK_MS = 2_000;

/**
 * Guards one export run against the two ways it can hurt the rest of the box:
 * filling the shared storage volume, and running long enough that the cleanup
 * sweep reaps it (or that its REPEATABLE READ snapshot holds back vacuum).
 *
 * Both checks hang off the per-batch hook so they apply to csv, json AND xlsx
 * from one place, and cost nothing measurable: the deadline is a clock read and
 * statfs is throttled to once every SPACE_RECHECK_MS.
 */
export class ExportRunGuard {
  private lastSpaceCheck = 0;

  constructor(
    private readonly dir: string,
    private readonly deadlineAt: number,
    private readonly reserveBytes: number = SPOOL_RESERVE_BYTES,
  ) {}

  /** Free bytes on the spool volume, or null if the platform won't say. */
  private async freeBytes(): Promise<number | null> {
    try {
      const st = await fs.statfs(this.dir);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      // Fail OPEN, deliberately: statfs is unavailable on some mounts and in
      // some containers, and refusing every export there would break data
      // portability (GDPR Art. 20) to protect against a disk that might be
      // fine. ENOSPC still fails the one job cleanly — BufferedWriter captures
      // the stream error and generate()'s finally purges the partial spool.
      return null;
    }
  }

  /** Before writing anything: is there room for `needBytes` plus the reserve? */
  async assertRoomFor(needBytes: number): Promise<void> {
    const free = await this.freeBytes();
    if (free === null) return;
    if (free - needBytes < this.reserveBytes) {
      throw new ExportOutOfSpaceError(
        `Not enough free space to build this export: it needs about ` +
          `${Math.ceil(needBytes / 1024 / 1024)} MB and only ` +
          `${Math.floor(free / 1024 / 1024)} MB is free on the storage volume. ` +
          'Please try again once space has been reclaimed.',
      );
    }
  }

  /** Between batches: still above the reserve, and still inside the budget? */
  async assertStillHealthy(): Promise<void> {
    if (Date.now() > this.deadlineAt) {
      throw new ExportTimedOutError(
        'This export ran longer than the time budget and was stopped. ' +
          'Please narrow the scope or contact support.',
      );
    }
    const now = Date.now();
    if (now - this.lastSpaceCheck < SPACE_RECHECK_MS) return;
    this.lastSpaceCheck = now;
    const free = await this.freeBytes();
    if (free !== null && free < this.reserveBytes) {
      throw new ExportOutOfSpaceError(
        'The storage volume ran low on space while building this export, so it was stopped ' +
          'before it could fill up. Please try again once space has been reclaimed.',
      );
    }
  }
}

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
 * shape is unchanged) for the streamed formats (csv/json/xlsx). SQL dumps
 * (pg_dump) of the control DB are blocked entirely below.
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
  // privacy-legal-06: `email_outbox` is 90 days of every transactional message
  // Libriant has composed — patron names, patron addresses, borrowed book
  // titles, applicant contact details — in the CONTROL plane, reachable by any
  // owner-admin export. An export of scope `control` shipped all of it with
  // zero redactions; measured on a real run, `grep -c '[redacted]'
  // email_outbox.csv` returned 0 while users.csv returned 5. The bearer tokens
  // themselves are already sealed out of the body at enqueue time
  // (src/email/outbox-secrets.ts), so what is left here is the personal data,
  // and it has no business in a 24-hour unencrypted download.
  //
  // `idempotencyKey` is in the list because it is producer-composed free text
  // and producers put addresses in it: the library-profile mail keys on
  // `lib-req-submit:<requestId>:<adminEmail>`. Measured on a real control
  // export — after the other three columns were redacted, 39 rows still
  // carried an e-mail address, all of them here.
  //
  // Guarded by src/email/outbox-export-redaction.spec.ts, which drives the
  // real `createRowStreamer` — delete this entry and that spec fails.
  // `replyToEmail` was missed on the first pass and is the same kind of leak:
  // applications.service.ts:178 sets it to the APPLICANT'S contact address, so
  // a control-plane export shipped `…,[redacted],application_submitted,[redacted],
  // no-reply@libriant.com,eleni.applicant@school.gr,[redacted],…` — three columns
  // redacted and the one that mattered in the clear. Applicant contact details
  // are one of the four data categories privacy-legal-06 enumerates for this
  // table.
  email_outbox: new Set(['bodymarkdown', 'toemail', 'replytoemail', 'subject', 'idempotencykey']),
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

/**
 * A table's shape, read once from the catalog — never its rows. The rows only
 * ever exist one FETCH_BATCH_ROWS batch at a time (see readTableInBatches).
 */
export type TableShape = {
  name: string;
  columns: string[];
  // Columns the pg driver returns as strings but which are genuinely numeric
  // (int8/numeric/etc). Formula-neutralization must skip these so a bigint like
  // `-42` isn't apostrophe-prefixed into text (EXP-006).
  numericColumns: ReadonlySet<string>;
};

/** Hands `onBatch` one table's rows in bounded batches, in cursor order. */
export type RowStreamer = (
  shape: TableShape,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
) => Promise<void>;

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
 * and any temp spool files (`${jobId}-*`) — regardless of what the DB row
 * recorded. Used on the failure path and by the cleanup sweep for stale jobs
 * whose `filePath` was never written (EXP-003).
 */
/**
 * Where exports spool and where the finished artifact lands. Shared with tenant
 * uploads — see SPOOL_RESERVE_BYTES for why that matters.
 */
function spoolDir(): string {
  return path.resolve(loadEnv().storageRoot, '_exports');
}

export async function purgeJobArtifacts(jobId: string): Promise<number> {
  const dir = spoolDir();
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
  const dir = spoolDir();
  await fs.mkdir(dir, { recursive: true });

  const targets = await resolveTargets(job, env.pgSuperuserUrl);
  const stamp = new Date().toISOString().slice(0, 10);
  const scopeLabel = job.scope === 'tenant' ? (targets[0]?.label ?? 'library') : job.scope;
  const baseName = `libriant-${scopeLabel}-${stamp}`;
  const multi = targets.length > 1;
  // CSV is inherently one-file-per-table, and multi-DB always bundles → zip.
  //
  // `catalog_marc` too, and for a reason worth stating: the artifact is
  // `catalogue.mrc` PLUS a `manifest.json` that accounts for every record the
  // walk saw, PLUS an `oversize.xml` when ISO 2709 refused any. A bare .mrc
  // would be a catalogue export that silently contains fewer records than the
  // catalogue, which the library would discover years later in another system
  // with no way to tell which ones were lost.
  const needsZip = job.format === 'csv' || job.format === 'catalog_marc' || multi;

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
  const archive = new ZipArchive({ zlib: { level: 9 } });
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
    // EXP-003: the temp spool files must be removed on BOTH the success and the
    // error path (the zip has read them by finalize() on success); before this
    // was only reached on success and leaked them on failure.
    if (!finalized) archive.abort(); // release the write stream on the error path
    for (const f of tempFiles) await fs.rm(f, { force: true }).catch(() => {});
  }
}

/**
 * How much disk a catalogue export will need, from the schema it actually reads.
 *
 * `pg_total_relation_size('lbr2.marc_record_contents')` is the stored size of
 * the documents INCLUDING their TOAST, which is the closest cheap proxy for the
 * serialized output — a MARC record's JSONB and its ISO 2709 bytes are within a
 * small factor of each other, and the factor is absorbed by
 * {@link CATALOG_SPOOL_MULTIPLIER}.
 *
 * Returns 0 rather than throwing when the schema is absent: a 1.0 tenant that
 * has not been migrated has no catalogue to export, and the walk will find no
 * rows and produce an empty artifact with an honest manifest.
 */
async function estimateCatalogBytes(dbUrl: string): Promise<number> {
  const client = new PgClient({ connectionString: dbUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const r = await client.query<{ bytes: string }>(
      `SELECT COALESCE(
                pg_catalog.pg_total_relation_size(
                  pg_catalog.to_regclass('lbr2.marc_record_contents')), 0)::text AS bytes`,
    );
    return Number(r.rows[0]?.bytes ?? 0);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Headroom over the estimate for a catalogue export: 4, not the shared 2.
 *
 * The artifact is the .mrc plus, transiently, the uncompressed spool files the
 * archiver reads — and the estimate is of COMPRESSED lz4 JSONB while the output
 * is uncompressed MARC. Measured on the phase-7 corpus, stored-to-serialized
 * runs about 2.6x; 4 leaves room above that rather than exactly at it, because
 * the failure this number prevents is a full volume.
 */
const CATALOG_SPOOL_MULTIPLIER = 4;

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
  if (format === 'json') {
    await writeJsonFile(target, outPath);
    return;
  }
  await writeXlsxFile(target, outPath);
}

/**
 * Append one DB's artifact(s) to the zip under `folder`.
 *
 * Every format spools to a temp file first and hands archiver the *path*, the
 * shape the sql path has always used. Feeding a live stream into the archive
 * instead would save the spool, but a stalled entry would leave the writer
 * awaiting 'drain' forever and wedge the single-slot export queue (EXP-002) —
 * the spool is bounded, deleted by generate()'s finally either way, and costs
 * disk we already spend on pg_dump.
 */
async function addTargetToArchive(
  format: ExportFormat,
  target: Target,
  archive: Archiver,
  folder: string,
  tmpDir: string,
  jobId: string,
  tempFiles: string[],
): Promise<void> {
  if (format === 'csv') {
    // One file per table, each streamed straight from the cursor to disk.
    await withTableReader(target, async (tables, streamRows) => {
      for (const [i, shape] of tables.entries()) {
        const tmp = path.join(tmpDir, `${jobId}-${target.label}-t${i}.csv`);
        tempFiles.push(tmp);
        const out = new BufferedWriter(createWriteStream(tmp, 'utf8'));
        try {
          await writeCsvTable(out, shape, streamRows);
        } catch (err) {
          await out.close().catch(() => {});
          throw err;
        }
        await out.close();
        archive.file(tmp, { name: `${folder}${shape.name}.csv` });
      }
    });
    return;
  }
  if (format === 'catalog_marc') {
    // The catalogue, not the database. See catalog-marc.ts for why this cannot
    // reuse withTableReader (it enumerates schemaname='public' and quotes a
    // single unqualified identifier, so `lbr2` is invisible to it).
    const mrcTmp = path.join(tmpDir, `${jobId}-${target.label}.mrc`);
    const xmlTmp = path.join(tmpDir, `${jobId}-${target.label}-oversize.xml`);
    const manifestTmp = path.join(tmpDir, `${jobId}-${target.label}-manifest.json`);
    tempFiles.push(mrcTmp, xmlTmp, manifestTmp);
    // The SAME guard class, the same four-hour deadline and the same 2 GiB
    // reserve every other format runs under — a catalogue export with limits of
    // its own would be the one export that can fill the volume.
    //
    // Its ROOM CHECK is not the shared one, and that is not an oversight.
    // `assertExportSizeSane` estimates from `pg_class` filtered to
    // `nspname = 'public'`, so for a catalogue that lives entirely in `lbr2` it
    // would report zero and `assertRoomFor(0)` would wave through an export onto
    // a nearly full disk. `estimateCatalogBytes` asks the right schema.
    const guard = new ExportRunGuard(spoolDir(), Date.now() + EXPORT_MAX_RUNTIME_MS);
    await guard.assertRoomFor(
      (await estimateCatalogBytes(target.dbUrl)) * CATALOG_SPOOL_MULTIPLIER,
    );
    const result = await withCatalogSource(target.dbUrl, (source) =>
      writeCatalogMarc({
        source,
        mrcPath: mrcTmp,
        xmlPath: xmlTmp,
        assertHealthy: () => guard.assertStillHealthy(),
      }),
    );
    await fs.writeFile(manifestTmp, catalogManifest(result, new Date().toISOString()), 'utf8');
    if (result.refused > 0) {
      // The AUTHORITATIVE account is `manifest.json` inside the artifact, which
      // names every refused record and why. This line exists so the fact is also
      // in the operator's log, where a pattern across libraries would show — a
      // hundred `field-too-long` refusals in one week is a cataloguing practice
      // question, not an export bug.
      //
      // Deliberately NOT a Prometheus counter. This happens when a librarian
      // clicks Export, at most a handful of times a year, and its full detail is
      // in the file they are already holding; a fleet-wide series would page an
      // operator about one library's 505 note.
      console.warn(
        `[export] ${jobId} catalog_marc: ${result.refused} of ${result.total} record(s) ` +
          `could not be written as ISO 2709 and are in oversize.xml as MARCXML`,
      );
    }
    archive.file(mrcTmp, { name: `${folder}catalogue.mrc` });
    archive.file(manifestTmp, { name: `${folder}manifest.json` });
    // Only when there is something in it — an empty oversize.xml would invite
    // exactly the reading it exists to prevent.
    if (result.refused > 0) archive.file(xmlTmp, { name: `${folder}oversize.xml` });
    return;
  }
  if (format === 'json') {
    const tmp = path.join(tmpDir, `${jobId}-${target.label}.json`);
    tempFiles.push(tmp);
    await writeJsonFile(target, tmp);
    archive.file(tmp, { name: `${folder}${target.label}.json` });
    return;
  }
  if (format === 'xlsx') {
    const tmp = path.join(tmpDir, `${jobId}-${target.label}.xlsx`);
    tempFiles.push(tmp);
    await writeXlsxFile(target, tmp);
    archive.file(tmp, { name: `${folder}${target.label}.xlsx` });
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

/**
 * Every tenant target carries that tenant's RUNTIME url — the export worker
 * reads library data, so it connects as the library's own role and not as the
 * superuser (tenant-isolation-02). `pg_dump --no-owner --no-privileges` and the
 * streamed readers both need SELECT and nothing more, which is exactly what
 * `tenant_<id>_app` holds.
 *
 * The `control` target is the one place a superuser string is legitimate, and
 * `dumpSql` refuses to SQL-dump it at all (EXP-004).
 */
async function resolveTargets(job: ExportJob, superuserUrl: string): Promise<Target[]> {
  if (job.scope === 'tenant') {
    const t = await controlDb.tenant.findUnique({
      where: { id: job.targetTenantId ?? '' },
      select: TENANT_RUNTIME_SELECT,
    });
    if (!t) throw new Error('Target tenant not found.');
    return [{ label: t.slug, dbUrl: runtimeDbUrl(t) }];
  }
  if (job.scope === 'control') {
    return [{ label: 'control', dbUrl: superuserUrl, isControl: true }];
  }
  const tenants = await controlDb.tenant.findMany({
    where: { status: { not: 'archived' } },
    select: TENANT_RUNTIME_SELECT,
    orderBy: { slug: 'asc' },
  });
  return [
    { label: 'control', dbUrl: superuserUrl, isControl: true },
    ...tenants.map((t) => ({ label: t.slug, dbUrl: runtimeDbUrl(t) })),
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
 * verbatim. Callers should use csv/json/xlsx for control data (those stream
 * through readTableInBatches, which redacts).
 */
async function dumpSql(target: Target, outPath: string): Promise<void> {
  if (target.isControl) {
    throw new Error(
      'SQL export of the control database is not supported (it would include credential ' +
        'and secret columns). Use the CSV, JSON or XLSX format for control-plane data.',
    );
  }
  // pg_dump writes straight to `outPath` on the shared storage volume, and
  // nothing here can estimate its size without a connection of its own. So the
  // guard is the floor only: refuse to START a dump when the volume is already
  // down to the reserve, rather than discovering it at ENOSPC with a partial
  // dump occupying the last free bytes of every tenant's upload space.
  await new ExportRunGuard(spoolDir(), Date.now() + EXPORT_MAX_RUNTIME_MS).assertRoomFor(0);
  const u = new URL(target.dbUrl);
  // statement_timeout caps any single server-side statement (EXP-002).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    // Both timeouts are overridden here rather than inherited: the tenant's
    // runtime role carries a 15 s statement cap and a 60 s idle-in-transaction
    // cap for the request path (tenant-isolation-02), and a dump is neither. A
    // startup-packet option outranks the role's own setting, so this is the
    // opt-out the role-level default is designed to allow.
    PGOPTIONS:
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS} ` + `-c idle_in_transaction_session_timeout=0`,
    PGCONNECT_TIMEOUT: String(Math.ceil(CONNECTION_TIMEOUT_MS / 1000)),
  };
  // Dump goes to --file, not stdout, so the 16MB maxBuffer cap is unnecessary.
  //
  // `timeout` kills the child at the same wall-clock budget the streamed
  // formats enforce per batch. Without it pg_dump was the one path with no
  // upper bound at all: statement_timeout caps each statement, but a dump is
  // many statements, so a slow database could hold the single queue slot (and
  // its own snapshot) indefinitely — and outlive the cleanup sweep's notion of
  // a dead run, which is what made that sweep reap live jobs.
  await execFileP(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', '--file', outPath],
    {
      env,
      timeout: EXPORT_MAX_RUNTIME_MS,
    },
  );
}

// --- streaming reads -------------------------------------------------------

// Postgres type OIDs for columns the driver hands back as JS strings but which
// are genuinely numeric (int8/numeric/float/money). Used to skip EXP-006
// formula-neutralization on real numbers.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);

/** The slice of `pg.Client` the readers need — narrow enough to fake in tests. */
export type SqlClient = {
  query(text: string): Promise<{
    rows: Record<string, unknown>[];
    fields: { name: string; dataTypeID: number }[];
    rowCount: number | null;
  }>;
};

/** Quote a catalog-sourced identifier before interpolating it into SQL. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * How the paging loop is bounded. A plain number pins the row count (fixed
 * batches, used by the specs that pin the cursor's boundary behaviour); the
 * object form is the adaptive, byte-budgeted mode production runs in.
 */
export type BatchBounds = {
  /** Target bytes of row payload per FETCH. */
  budgetBytes?: number;
  maxRows?: number;
  minRows?: number;
  startRows?: number;
};

function resolveBounds(b: BatchBounds | number): Required<BatchBounds> {
  if (typeof b === 'number') {
    // Fixed-size mode: no budget, no adaptation. Exists so a test can assert
    // exactly where the batch boundaries fall.
    return { budgetBytes: Number.POSITIVE_INFINITY, maxRows: b, minRows: b, startRows: b };
  }
  const maxRows = b.maxRows ?? FETCH_MAX_ROWS;
  const minRows = Math.min(b.minRows ?? FETCH_MIN_ROWS, maxRows);
  return {
    budgetBytes: b.budgetBytes ?? FETCH_BUDGET_BYTES,
    maxRows,
    minRows,
    startRows: Math.min(Math.max(b.startRows ?? FETCH_START_ROWS, minRows), maxRows),
  };
}

/**
 * In-memory footprint of one row's values.
 *
 * WHY THIS IS NOT A FLAT CONSTANT ANY MORE. The first version of this function
 * counted a string at 2 bytes/char, a Buffer at its length, and EVERYTHING ELSE
 * at a flat 16 bytes. Every tenant table carries a `customFields` jsonb,
 * `audit_log` carries a jsonb payload, and `collection_records.data` is
 * entirely tenant-shaped — node-pg hands all of those back as parsed JS objects,
 * which fell into the "everything else" branch. Measured on a 53 MB probe table
 * of 13,000 rows × ~256 KB of jsonb: the estimator reported 0.20 MiB for a batch
 * whose real payload was 1,250 MiB, so the adaptive loop never saw the budget
 * being exceeded, ramped to the row ceiling, and peaked at 2,632 MB RSS in a
 * container limited to 1 GB.
 *
 * So structured values are WALKED. That is still much cheaper than
 * `JSON.stringify` (no output string is built), and it is bounded: a value that
 * is too large or too deeply nested to walk cheaply stops the walk and is
 * charged {@link OVERSIZE_VALUE_BYTES}, which collapses the batch to the
 * minimum rather than silently under-counting it. Under-counting is the failure
 * mode that OOMs the worker; over-counting only makes a batch smaller.
 *
 * Note this is the SECOND line of defence. The first is the per-table hard row
 * ceiling derived from the widest row in the table (see {@link widestRowBytes}),
 * which is what bounds the FIRST batch of a table — this function can only
 * react to a batch that has already been read.
 */

/** Nodes the walker may visit inside one value before it gives up. */
const VALUE_WALK_NODE_BUDGET = 20_000;
/** What an un-walkable (too big / too deep / cyclic) value is charged. */
const OVERSIZE_VALUE_BYTES = FETCH_BUDGET_BYTES;

function valueBytes(v: unknown, budget: { left: number }): number {
  if (budget.left-- <= 0) return OVERSIZE_VALUE_BYTES;
  if (v === null || v === undefined) return 8;
  switch (typeof v) {
    case 'string':
      // V8's worst case for a non-Latin1 string, and Greek catalogue data is
      // exactly that. +16 for the string header.
      return v.length * 2 + 16;
    case 'number':
    case 'boolean':
      return 8;
    case 'bigint':
      return 16;
    case 'object':
      break;
    default:
      return 16;
  }
  if (Buffer.isBuffer(v)) return v.length + 16;
  if (v instanceof Date) return 32;
  if (ArrayBuffer.isView(v)) return (v as ArrayBufferView).byteLength + 16;
  if (Array.isArray(v)) {
    let n = 32;
    for (const item of v) {
      n += valueBytes(item, budget);
      if (n >= OVERSIZE_VALUE_BYTES) return OVERSIZE_VALUE_BYTES;
    }
    return n;
  }
  // Parsed jsonb / json / composite / range — a plain object graph.
  let n = 32;
  for (const key in v as Record<string, unknown>) {
    n += key.length * 2 + 24;
    n += valueBytes((v as Record<string, unknown>)[key], budget);
    if (n >= OVERSIZE_VALUE_BYTES) return OVERSIZE_VALUE_BYTES;
  }
  return n;
}

export function approxRowBytes(row: Record<string, unknown>): number {
  const budget = { left: VALUE_WALK_NODE_BUDGET };
  let bytes = 0;
  for (const key in row) {
    bytes += key.length * 2 + 24;
    bytes += valueBytes(row[key], budget);
  }
  return bytes;
}

/**
 * Bytes in the WIDEST row of `table`, measured server-side before a single row
 * is fetched. This is the hard bound on a batch: `rows-per-FETCH × this` is what
 * the process will hold, so the caller divides the byte budget by it.
 *
 * WHY A WHOLE-TABLE MAX AND NOT A SAMPLE. The batch size for FETCH n+1 used to
 * be derived from what FETCH n measured, which is one batch too late: a table
 * whose first ~7,936 rows are narrow drives the ramp 256→512→1024→2048→4096→5000
 * and the NEXT fetch then pulls 5,000 rows of whatever follows. Executed against
 * a probe table shaped exactly like that (7,936 tiny rows, then 6,000 rows of
 * 1 MiB text — only 80 MB on disk, because the text compresses in TOAST):
 * batch 5 was 4,096 rows at 103 MB RSS and batch 6 was 5,000 rows at 5,197 MB.
 * Any bound computed from rows already seen has that hole in it; only a bound
 * over the whole table does not.
 *
 * WHY THIS IS CHEAP. Not `octet_length(t::text)` — that builds the full row
 * literal and took 22 s on the 80 MB probe table. Instead the expression is
 * assembled per column:
 *   - fixed-width types (int, timestamp, uuid, bool, …) contribute `typlen`
 *     with no I/O at all;
 *   - text/varchar/bytea/citext use `octet_length(col)`, which reads the
 *     UNCOMPRESSED size straight out of the TOAST pointer without fetching a
 *     single chunk — 1.5 ms for the same 80 MB table;
 *   - anything else (json, jsonb, arrays, ranges, hstore) has no raw-size
 *     accessor, so it costs one `col::text` serialization — the same work the
 *     writer will do anyway.
 * It runs inside the export's REPEATABLE READ snapshot, so the row it measures
 * is the row the cursor will read; a concurrent INSERT of a wider row is not
 * visible to either.
 *
 * Returns 0 for an empty table (the caller then keeps its default ceiling).
 */
async function widestRowBytes(client: SqlClient, table: string): Promise<number> {
  const cols = await client.query(
    `SELECT a.attname AS name, t.typlen AS len, t.typname AS type
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = '${table.replace(/'/g, "''")}'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  // Types whose octet_length() reads the raw size from the TOAST header.
  const RAW_SIZE_TYPES = new Set(['text', 'varchar', 'bpchar', 'bytea', 'citext', 'name', 'xml']);
  const terms: string[] = ['0'];
  for (const c of cols.rows) {
    const col = quoteIdent(String(c.name));
    const len = Number(c.len);
    if (Number.isFinite(len) && len > 0) {
      terms.push(String(len));
    } else if (RAW_SIZE_TYPES.has(String(c.type))) {
      terms.push(`COALESCE(octet_length(${col}), 0)`);
    } else {
      terms.push(`COALESCE(octet_length(${col}::text), 0)`);
    }
    // Per-column JS overhead: the key string plus the value's own header.
    terms.push('32');
  }
  const res = await client.query(
    `SELECT COALESCE(MAX(${terms.join(' + ')}), 0)::bigint AS max FROM ${quoteIdent(table)}`,
  );
  const max = Number(res.rows[0]?.max ?? 0);
  return Number.isFinite(max) && max > 0 ? max : 0;
}

/**
 * How many bytes of JS heap one byte of Postgres row payload turns into.
 *
 * node-pg holds the raw wire bytes for the whole FETCH result, then materialises
 * JS values from them: a UTF-8 text column becomes a V8 string (up to 2 bytes
 * per code unit for the Greek data this product is built for), a jsonb column
 * becomes an object graph that is several times its serialized form. 2 is the
 * working multiplier, deliberately on the pessimistic side — the whole point of
 * this bound is that being wrong in the other direction is an OOM kill of a
 * process that also owns the email outbox, every import and all nine sweeps.
 */
const JS_BYTES_PER_DB_BYTE = 2;

/**
 * Rows per FETCH to fall back to when the width probe could not run.
 *
 * The probe is one aggregate scan and is normally milliseconds (see
 * widestRowBytes), but on a very large jsonb-heavy table it pays a full
 * serialization and can exceed even its own extended timeout. When that
 * happens we must NOT fall back to the unbounded ceiling — that is the exact
 * hole this whole mechanism exists to close — so we fall back to a small fixed
 * count and let the adaptive loop take it from there.
 */
const FETCH_UNMEASURED_MAX_ROWS = 64;

/**
 * Statement timeout for the width probe alone.
 *
 * The connection runs with a 60 s statement_timeout so a hung tenant DB cannot
 * wedge the single-slot queue, and that is right for a FETCH. The probe is a
 * different shape: one sequential aggregate whose cost is proportional to the
 * table, bounded overall by ExportRunGuard's wall-clock budget. Give it room
 * rather than making every large table take the degraded fallback.
 */
const WIDTH_PROBE_TIMEOUT_MS = 10 * 60_000;

/**
 * The most rows one FETCH of `table` may ask for, so that the batch fits
 * `budgetBytes` even if every row in it is the widest row in the table.
 *
 * Exported for the tests: this is the number the whole memory bound rests on.
 */
export async function tableRowCeiling(
  client: SqlClient,
  table: string,
  budgetBytes: number,
  minRows: number,
  maxRows: number,
): Promise<number> {
  let widest = 0;
  try {
    await client.query(`SET LOCAL statement_timeout = ${WIDTH_PROBE_TIMEOUT_MS}`);
    widest = await widestRowBytes(client, table);
  } catch (err) {
    // Fail SMALL, never fail open: an unmeasured table is exactly the case this
    // bound exists for, so it gets the degraded ceiling rather than the default.
    console.warn(
      `[export] width probe failed for ${table} (${oneLine(String(err))}); ` +
        `capping FETCH at ${FETCH_UNMEASURED_MAX_ROWS} rows`,
    );
    return Math.max(minRows, Math.min(maxRows, FETCH_UNMEASURED_MAX_ROWS));
  } finally {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch(() => {});
  }
  // An empty table measures 0 — nothing to bound, keep the caller's ceiling.
  if (widest <= 0) return maxRows;
  const fits = Math.floor(budgetBytes / (widest * JS_BYTES_PER_DB_BYTE));
  return Math.max(minRows, Math.min(maxRows, fits));
}

/**
 * Read one table through a server-side cursor, handing the caller one bounded
 * batch at a time and never holding more than that. The cursor lives in the
 * caller's transaction (withTableReader), so no rows are materialised anywhere
 * — server side the cursor is lazy, client side each FETCH result is released
 * once `onBatch` has written it out.
 *
 * The batch is bounded by BYTES, not rows, in TWO layers, because one was not
 * enough:
 *
 *   1. a HARD per-table row ceiling — `budgetBytes ÷ the widest row in the
 *      table`, measured server-side in the same snapshot before the cursor is
 *      declared ({@link tableRowCeiling}). This bounds every batch including
 *      the first, and is what a table whose wide rows come LAST cannot slip
 *      past;
 *   2. the adaptive ramp below, which re-derives the next FETCH's row count
 *      from what the last one actually measured, so a table of mixed widths
 *      settles near the budget rather than at the ceiling.
 *
 * Layer 2 alone was the shipped bound and it was defeated twice — see
 * {@link approxRowBytes} (an estimator blind to jsonb) and
 * {@link widestRowBytes} (a narrow prefix driving the ramp up before the wide
 * rows arrive). See FETCH_BUDGET_BYTES for why a row count alone is not a bound
 * at all.
 *
 * Exported for the unit tests: the batch boundaries (a short final chunk, an
 * exactly-full final chunk, an empty table) are where a hand-rolled paging loop
 * silently drops or duplicates rows — and the adaptation must not disturb them.
 */
export async function readTableInBatches(
  client: SqlClient,
  table: string,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
  bounds: BatchBounds | number = {},
): Promise<number> {
  const resolved = resolveBounds(bounds);
  const { budgetBytes, minRows } = resolved;
  // HARD per-table ceiling: rows-per-FETCH × the widest row in the table must
  // fit the byte budget. This is what bounds the FIRST batch — the adaptive
  // ramp below can only react to a batch it has already read into memory, and
  // a table whose wide rows come last defeats it (see widestRowBytes).
  let maxRows = resolved.maxRows;
  let startRows = resolved.startRows;
  if (Number.isFinite(budgetBytes)) {
    maxRows = await tableRowCeiling(client, table, budgetBytes, minRows, maxRows);
    startRows = Math.min(startRows, maxRows);
  }
  const cursor = 'lbr_export_cursor';
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT * FROM ${quoteIdent(table)}`);
  let total = 0;
  let batchSize = startRows;
  try {
    for (;;) {
      const res = await client.query(`FETCH FORWARD ${batchSize} FROM ${cursor}`);
      const got = res.rows.length;
      if (got > 0) {
        total += got;
        await onBatch(res.rows);
      }
      // A short chunk means the cursor is exhausted; an exactly-full one still
      // costs one more (empty) FETCH to find that out. Measured against the
      // size we ASKED for, before it is adjusted below.
      if (got < batchSize) break;

      // Re-aim at the byte budget using this batch's measured payload. Halving
      // (rather than jumping straight to the computed target) on the way down
      // is not enough when a table is 100× wider than assumed, so the target is
      // used directly in both directions; the growth is capped at 2× so one
      // atypically narrow batch cannot undo the caution of the start size.
      let sampled = 0;
      for (const row of res.rows) sampled += approxRowBytes(row);
      if (Number.isFinite(budgetBytes)) {
        const perRow = Math.max(1, sampled / got);
        const target = Math.floor(budgetBytes / perRow);
        batchSize = Math.max(minRows, Math.min(maxRows, batchSize * 2, target));
      }
    }
  } finally {
    // The cursor dies with the transaction anyway, but leaving it open would
    // collide with the next table's DECLARE of the same name.
    await client.query(`CLOSE ${cursor}`).catch(() => {});
  }
  return total;
}

/**
 * Tables present in every database that the export deliberately does NOT ship.
 *
 * One list, used by BOTH the pre-flight estimate and the table enumeration.
 * They were written separately and drifted: the estimate counted
 * `_prisma_migrations` (and its bytes) toward a limit whose whole purpose is to
 * predict what the export will do, while the enumeration excluded it. Small in
 * absolute terms, but an estimate that measures a different set of tables than
 * the run is not an estimate of the run.
 */
const EXCLUDED_TABLES = ['_prisma_migrations'] as const;
const EXCLUDED_TABLES_SQL = EXCLUDED_TABLES.map((t) => `'${t}'`).join(', ');

/** What the planner thinks this database costs to export. No scan, no rows. */
export type ExportEstimate = {
  /** Estimated live rows across the tables the export will actually read. */
  rows: number;
  /** Estimated on-disk bytes of those tables, heap + TOAST, indexes excluded. */
  bytes: number;
};

/**
 * Refuse an oversized export BEFORE a single row is read, and report what the
 * run is expected to cost. `reltuples` is the planner's row estimate, already
 * in pg_class — no scan, no allocation (performance-01: the old cap was checked
 * after the rows were in memory, so it never prevented the OOM it was written
 * for). A table that has never been analysed reports -1 on PG14+, i.e.
 * *unknown* rather than empty, so it contributes nothing here and the running
 * total inside createRowStreamer stays as the backstop.
 *
 * `pg_table_size` (heap + TOAST, no indexes) is the closest cheap proxy for how
 * many bytes the spooled artifact will need; the caller uses it for the disk
 * guard. It is only a proxy — CSV/JSON of the same rows can be larger than the
 * page image — hence the multiplier at the call site.
 */
export async function assertExportSizeSane(
  client: SqlClient,
  maxRows: number = MAX_EXPORT_ROWS,
): Promise<ExportEstimate> {
  const res = await client.query(
    `SELECT COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint      AS est,
            COALESCE(SUM(pg_table_size(c.oid)), 0)::bigint          AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname NOT IN (${EXCLUDED_TABLES_SQL})`,
  );
  const rows = Number(res.rows[0]?.est ?? 0);
  const bytes = Number(res.rows[0]?.bytes ?? 0);
  if (Number.isFinite(rows) && rows > maxRows) {
    throw new ExportTooLargeError(
      `This database holds roughly ${Math.round(rows).toLocaleString()} rows, above the ` +
        `${maxRows.toLocaleString()}-row export limit; please contact support.`,
    );
  }
  return { rows, bytes: Number.isFinite(bytes) ? bytes : 0 };
}

/**
 * Per-target row source: applies control-plane redaction and carries the
 * runaway row backstop across every table of the same database.
 */
export function createRowStreamer(
  client: SqlClient,
  target: Pick<Target, 'isControl'>,
  maxRows: number = MAX_EXPORT_ROWS,
  bounds: BatchBounds | number = {},
  guard?: Pick<ExportRunGuard, 'assertStillHealthy'>,
): RowStreamer {
  let totalRows = 0;
  return async (shape, onBatch) => {
    await readTableInBatches(
      client,
      shape.name,
      async (rows) => {
        // One hook, checked once per batch, for every format: the run is still
        // inside its time budget and the shared storage volume still has room.
        // Per-batch rather than per-table because a single audit_log can be the
        // whole run — a per-table check would never fire during it.
        await guard?.assertStillHealthy();
        totalRows += rows.length;
        if (totalRows > maxRows) {
          throw new ExportTooLargeError(
            `Export exceeds the ${maxRows.toLocaleString()}-row limit; ` +
              'please narrow the scope or contact support.',
          );
        }
        // EXP-004: control-plane tables carry password hashes, encrypted TOTP /
        // DB-role secrets and invite tokens — redact those values before they
        // ever touch disk in a (non-SQL) control/all export.
        await onBatch(target.isControl ? rows.map((r) => redactRow(shape.name, r)) : rows);
      },
      bounds,
    );
  };
}

/** Column names + types for one table, read from a zero-row describe. */
async function describeTable(client: SqlClient, name: string): Promise<TableShape> {
  const res = await client.query(`SELECT * FROM ${quoteIdent(name)} LIMIT 0`);
  return {
    name,
    columns: res.fields.map((f) => f.name),
    numericColumns: new Set(
      res.fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name),
    ),
  };
}

/**
 * How long the export's own connection may sit idle INSIDE its open
 * transaction before Postgres kills the session.
 *
 * The read runs in one REPEATABLE READ snapshot held open for the whole
 * database — minutes on a big tenant — and an open snapshot pins the xmin
 * horizon, so autovacuum on that database cannot reclaim anything dead behind
 * it for the duration. That is an accepted cost while we are actively FETCHing.
 * What is not acceptable is the same snapshot held open by a client that has
 * stopped doing anything: a worker blocked on a stalled disk write, a crashed
 * process whose TCP session has not been noticed yet. Before this there was no
 * `idle_in_transaction_session_timeout` anywhere in the repository, so such a
 * session held back vacuum until someone found it by hand.
 *
 * 60 s: comfortably longer than any single write between two FETCHes, short
 * enough that a wedged export stops mattering to the database within a minute.
 * A killed session surfaces as a failed job, which is the correct outcome —
 * the alternative is a tenant database that slowly bloats.
 *
 * (Postgres 17's `transaction_timeout` would additionally bound the total, but
 * the deployed server is 16, so the wall-clock bound is enforced client-side by
 * ExportRunGuard instead.)
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Open a read-only REPEATABLE READ transaction on `target` and give `body` the
 * shape of every public table plus a ready-made, guarded row streamer. Generic
 * — works for control and tenant DBs.
 *
 * One snapshot for the whole database, the way pg_dump does it: the tables are
 * now read minutes apart rather than in one shot, and without a shared snapshot
 * a loan streamed at minute 3 could reference a copy that the copies file,
 * written at minute 1, never contained.
 *
 * The streamer is built HERE rather than by each caller so that the run guard
 * (time budget + spool space) cannot be forgotten by one format. It was: the
 * three writers each constructed their own streamer, which is how the disk
 * check had nowhere to live.
 */
async function withTableReader<T>(
  target: Target,
  body: (tables: TableShape[], streamRows: RowStreamer) => Promise<T>,
): Promise<T> {
  const client = new PgClient({
    connectionString: target.dbUrl,
    // EXP-002: cap how long we wait to connect, and cap any single statement
    // server-side so a hung/slow tenant DB can't wedge the single-slot worker.
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    // Must be set OUTSIDE the transaction: `SET` inside one is rolled back with
    // it, and this has to outlive the BEGIN it protects.
    await client.query(
      `SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
    );
    // The same transaction form pg_dump uses for a consistent whole-database
    // read. Declaring the cursors inside a transaction (rather than WITH HOLD)
    // also means the server never materialises the result set anywhere.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    try {
      const estimate = await assertExportSizeSane(client);
      const guard = new ExportRunGuard(spoolDir(), Date.now() + EXPORT_MAX_RUNTIME_MS);
      // Refuse before the first byte if the artifact plainly will not fit. The
      // periodic check inside the streamer covers the case where this estimate
      // was optimistic.
      await guard.assertRoomFor(estimate.bytes * SPOOL_SIZE_MULTIPLIER);
      const names = (
        await client.query(
          `SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename NOT IN (${EXCLUDED_TABLES_SQL})
            ORDER BY tablename`,
        )
      ).rows.map((r) => String(r.tablename));
      const tables: TableShape[] = [];
      for (const name of names) tables.push(await describeTable(client, name));
      return await body(tables, createRowStreamer(client, target, MAX_EXPORT_ROWS, {}, guard));
    } finally {
      await client.query('COMMIT').catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// --- output writers --------------------------------------------------------

/**
 * Write-behind buffer over an output stream. Rows are concatenated into ~64 KB
 * chunks before they reach the stream (a write syscall per row is unusable at
 * 3M rows) and `write` honours backpressure, so what is in flight is one chunk
 * — never one table.
 */
export class BufferedWriter {
  private buf = '';
  private failed: Error | null = null;

  constructor(
    private readonly out: Writable,
    private readonly flushBytes = 64 * 1024,
  ) {
    // An 'error' with no listener is an uncaught exception — ENOSPC on the
    // shared _exports volume would kill the worker outright instead of failing
    // the one job. Capture it and surface it from the next write/close.
    this.out.on('error', (err: Error) => {
      this.failed ??= err;
    });
  }

  async write(s: string): Promise<void> {
    if (this.failed) throw this.failed;
    this.buf += s;
    if (this.buf.length >= this.flushBytes) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.buf === '') return;
    const chunk = this.buf;
    this.buf = '';
    // `once` rejects if the stream errors while we wait, so a dead stream can
    // never leave the export parked on a 'drain' that will not come (EXP-002).
    if (!this.out.write(chunk)) await once(this.out, 'drain');
  }

  /** Flush, end the stream and wait for the bytes to actually land. */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.out.end();
      await finished(this.out).catch((err: Error) => {
        this.failed ??= err;
      });
    }
    if (this.failed) throw this.failed;
  }
}

/**
 * Stream every table of one database into a single JSON document. The bytes
 * are identical to the old `JSON.stringify(allTables, null, 2)` — the object
 * is assembled on the wire instead of in the heap.
 */
export async function writeJsonTables(
  out: BufferedWriter,
  tables: TableShape[],
  streamRows: RowStreamer,
): Promise<void> {
  await out.write('{');
  let firstTable = true;
  for (const shape of tables) {
    await out.write(`${firstTable ? '\n' : ',\n'}  ${JSON.stringify(shape.name)}: [`);
    firstTable = false;
    let firstRow = true;
    await streamRows(shape, async (rows) => {
      for (const row of rows) {
        const body = indentBlock(JSON.stringify(normalizeRow(row), null, 2), 4);
        await out.write(`${firstRow ? '\n' : ',\n'}${body}`);
        firstRow = false;
      }
    });
    await out.write(firstRow ? ']' : '\n  ]');
  }
  await out.write(firstTable ? '}' : '\n}');
}

/** Stream one table into its own CSV file (header first, then cursor batches). */
export async function writeCsvTable(
  out: BufferedWriter,
  shape: TableShape,
  streamRows: RowStreamer,
): Promise<void> {
  await out.write(csvHeaderLine(shape));
  await streamRows(shape, async (rows) => {
    for (const row of rows) await out.write(`\r\n${csvRowLine(shape, row)}`);
  });
}

/**
 * How much un-deflated sheet XML we let queue in front of the workbook's zip
 * before pausing to let it catch up. MEASURED: ExcelJS hands every committed
 * row to the sheet's zip stream and never honours the backpressure that comes
 * back (its StreamBuf.write is documented as never returning false), so a
 * producer that only awaits the next FETCH queues the whole uncompressed sheet
 * — 47 MB of live Buffers per 100,000 audit_log rows, i.e. ~1.4 GB for one 3M
 * row table. That is the same OOM as performance-01, just off-heap, so
 * streaming the reads is not on its own enough to fix the xlsx format.
 */
const XLSX_QUEUE_BYTES = 32 * 1024 * 1024;
/** Never stall a batch longer than this if the queue refuses to shrink. */
const XLSX_DRAIN_BUDGET_MS = 5_000;

/**
 * Bytes of sheet XML currently queued in front of the workbook's deflate, or
 * null if ExcelJS no longer exposes the stream we throttle on.
 *
 * The sheet's StreamBuf pipes into a PassThrough that feeds the zip; that
 * PassThrough's write queue is where the un-deflated XML piles up. It comes
 * from archiver's bundled readable-stream, which has no `writableLength`
 * getter, hence the `_writableState.length` fallback.
 *
 * Exported so a spec can pin that the signal is still discoverable: if a future
 * ExcelJS/archiver reshuffles this, the throttle would otherwise switch itself
 * off in silence and the OOM would walk straight back in.
 */
export function xlsxSheetQueueBytes(ws: ExcelJS.Worksheet): number | null {
  const pipes = (ws as unknown as { stream?: { pipes?: unknown[] } }).stream?.pipes;
  const dest = Array.isArray(pipes) ? pipes[0] : undefined;
  const queued =
    (dest as { writableLength?: unknown })?.writableLength ??
    (dest as { _writableState?: { length?: unknown } })?._writableState?.length;
  return typeof queued === 'number' ? queued : null;
}

/** Let the zip work through what we've already handed it before feeding more. */
async function awaitZipDrain(ws: ExcelJS.Worksheet): Promise<void> {
  const deadline = Date.now() + XLSX_DRAIN_BUDGET_MS;
  do {
    // Yielding at least once per batch is what lets zlib's threadpool
    // callbacks land at all — a tight synchronous row loop never gives the
    // event loop a turn.
    await yieldToLoop();
    const queued = xlsxSheetQueueBytes(ws);
    if (queued === null || queued <= XLSX_QUEUE_BYTES) return;
  } while (Date.now() < deadline);
}

/**
 * Stream every table into its own worksheet. `useSharedStrings` stays off on
 * purpose: the shared-strings table is an in-memory map of every distinct cell
 * string for the life of the workbook, which is exactly the unbounded growth
 * this rewrite removes. Committing each row hands it to the sheet's zip stream
 * and drops it from the worksheet; awaitZipDrain then keeps the zip's own queue
 * from becoming the new leak.
 */
export async function writeXlsxSheets(
  wb: ExcelJS.stream.xlsx.WorkbookWriter,
  tables: TableShape[],
  streamRows: RowStreamer,
): Promise<void> {
  if (tables.length === 0) {
    wb.addWorksheet('empty').commit();
    return;
  }
  for (const shape of tables) {
    // Sheet names: max 31 chars, no []*?/\ — keep it simple.
    const sheetName = shape.name.replace(/[[\]*?/\\]/g, '_').slice(0, 31) || 'sheet';
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(shape.columns).commit();
    await streamRows(shape, async (rows) => {
      for (const row of rows) {
        ws.addRow(
          shape.columns.map((c) => cellValue(row[c], shape.numericColumns.has(c))),
        ).commit();
      }
      await awaitZipDrain(ws);
    });
    ws.commit();
  }
}

async function writeJsonFile(target: Target, outPath: string): Promise<void> {
  const out = new BufferedWriter(createWriteStream(outPath, 'utf8'));
  try {
    await withTableReader(target, (tables, streamRows) => writeJsonTables(out, tables, streamRows));
  } catch (err) {
    // Close on the failure path too or the fd leaks; the caller purges the
    // half-written file (EXP-003).
    await out.close().catch(() => {});
    throw err;
  }
  await out.close();
}

async function writeXlsxFile(target: Target, outPath: string): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outPath,
    useSharedStrings: false,
    useStyles: false,
  });
  try {
    await withTableReader(target, (tables, streamRows) => writeXlsxSheets(wb, tables, streamRows));
  } catch (err) {
    // commit() is what closes the workbook's file stream — skip it on the error
    // path and the fd (and archiver) leak for the life of the worker.
    await wb.commit().catch(() => {});
    throw err;
  }
  await wb.commit();
}

// --- value formatting ------------------------------------------------------

/** Indent every line of a JSON fragment so it nests inside a 2-space document. */
function indentBlock(s: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
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

function csvCell(v: unknown, numericColumn = false): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Buffer.isBuffer(v)) s = v.toString('base64');
  else if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = neutralizeFormula(JSON.stringify(v));
  else if (typeof v === 'string')
    s = numericColumn && isNumericString(v) ? v : neutralizeFormula(v);
  else s = String(v); // number/boolean — safe, no neutralization needed
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvHeaderLine = (shape: TableShape): string => shape.columns.map((c) => csvCell(c)).join(',');

const csvRowLine = (shape: TableShape, row: Record<string, unknown>): string =>
  shape.columns.map((c) => csvCell(row[c], shape.numericColumns.has(c))).join(',');
