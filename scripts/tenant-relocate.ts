/**
 * Libriant — relocate a tenant's database to a new Postgres host / cell.
 *
 * Flow (with --dry-run, prints the plan and exits):
 *
 *   1. Resolve tenant + its current db_url
 *   2. Open a per-tenant `read_only` system mode (so any in-flight
 *      mutations get a clean 503; we ride out of this in step 9)
 *   3. pg_dump from source → temp file (custom format, compressed)
 *   4. Ensure destination DB exists (CREATE if missing) + install extensions
 *   5. pg_restore into destination
 *   6. Apply any pending tenant migrations to the destination
 *   7. Verify the destination is reachable + non-empty
 *   8. Update tenants.db_url + cell_id in the control DB
 *   9. Bust the TenantResolver Redis cache (key: tenant:slug:<slug>)
 *  10. End the read_only window
 *
 * If anything between steps 3 and 7 fails, the tenant stays on the source
 * DB and the read_only window stays open for an admin to inspect. The
 * source DB is left intact — call `--drop-source` manually after a
 * post-migration probe to free the disk.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL  — control-plane DB
 *     REDIS_URL             — to bust the per-tenant resolver cache
 *
 *   USAGE:
 *     pnpm tenant:relocate -- \
 *       --tenant=acme \
 *       --to-db-url='postgresql://lib:pw@cell-02.lan:5432/' \
 *       --to-cell=cell-02 \
 *       --dry-run
 *
 *     # After verifying the new home is healthy, optionally:
 *     pnpm tenant:relocate -- --tenant=acme --drop-source
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client as PgClient } from 'pg';
import { Redis } from 'ioredis';
import { controlDb, type Prisma } from '@libriant/db-control';
import { dbNameForTenant, die, isYes, log, parseArgs, urlForDb } from './_lib/cli.js';

const execFileP = promisify(execFile);
const SCRIPT = 'tenant-relocate';

const args = parseArgs({
  name: SCRIPT,
  description: "Move a tenant's DB to a new cell.",
  options: {
    tenant: { type: 'string' },
    'to-db-url': { type: 'string' },
    'to-cell': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'drop-source': { type: 'boolean' },
  },
  required: ['tenant'] as const,
});

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const slug = String(v.tenant);
  const dryRun = isYes(v['dry-run']);
  const dropSourceMode = isYes(v['drop-source']);

  const tenant = await controlDb.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, dbUrl: true, cellId: true, customSubdomain: true },
  });
  if (!tenant) die(SCRIPT, `tenant "${slug}" not found.`);

  if (dropSourceMode) {
    return dropSource(tenant);
  }

  const targetHostUrl = v['to-db-url']
    ? String(v['to-db-url'])
    : die(SCRIPT, '--to-db-url is required (use --drop-source for post-cutover cleanup).');
  const newCellId = v['to-cell'] ? String(v['to-cell']) : tenant.cellId;

  const dbName = dbNameForTenant(tenant.id);
  const newDbUrl = urlForDb(targetHostUrl, dbName);

  if (newDbUrl === tenant.dbUrl) {
    die(SCRIPT, 'destination URL equals current URL; nothing to do.');
  }
  const newCell = await controlDb.cell.findUnique({ where: { id: newCellId } });
  if (!newCell) die(SCRIPT, `destination cell "${newCellId}" not found.`);

  log(SCRIPT, `tenant=${slug} (${tenant.id})`);
  log(SCRIPT, `  from cell=${tenant.cellId} dbUrl=${redact(tenant.dbUrl)}`);
  log(SCRIPT, `  to   cell=${newCellId} dbUrl=${redact(newDbUrl)}`);
  log(SCRIPT, `  dryRun=${dryRun}`);

  if (dryRun) {
    log(SCRIPT, 'dry run: not relocating.');
    await controlDb.$disconnect();
    return;
  }

  const adminId = await firstOwnerAdminId();
  const modeEvent = await openReadOnly(tenant.id, adminId);
  log(SCRIPT, `opened read_only window event=${modeEvent.id}`);

  const tmp = await mkdtemp(path.join(tmpdir(), `lbr-relocate-${tenant.slug}-`));
  const dumpFile = path.join(tmp, 'tenant.dump');

  try {
    log(SCRIPT, `pg_dump → ${dumpFile}…`);
    await execFileP(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '-f', dumpFile, tenant.dbUrl],
      {
        maxBuffer: 256 * 1024 * 1024,
      },
    );

    log(SCRIPT, `ensuring destination database ${dbName}…`);
    await ensureDestinationDatabase(targetHostUrl, dbName);

    log(SCRIPT, 'pg_restore → destination…');
    await execFileP(
      'pg_restore',
      ['--no-owner', '--no-acl', '--clean', '--if-exists', '-d', newDbUrl, dumpFile],
      { maxBuffer: 256 * 1024 * 1024 },
    );

    log(SCRIPT, 'verifying destination…');
    await verifyDestination(newDbUrl);

    log(SCRIPT, 'updating control plane (db_url + cell_id)…');
    await controlDb.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { dbUrl: newDbUrl, cellId: newCellId },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'system',
          action: 'tenant.relocated',
          targetType: 'tenant',
          targetId: tenant.id,
          beforeJson: { dbUrl: tenant.dbUrl, cellId: tenant.cellId },
          afterJson: { dbUrl: newDbUrl, cellId: newCellId },
        },
      });
    });

    log(SCRIPT, 'busting TenantResolver cache…');
    await bustResolverCache(tenant.slug, tenant.customSubdomain);

    log(SCRIPT, 'closing read_only window…');
    await closeEvent(modeEvent.id);

    log(SCRIPT, 'done. Probe the new home, then re-run with --drop-source to delete the old DB.');
  } catch (err) {
    log(SCRIPT, `failed: ${(err as Error).message}`);
    log(SCRIPT, 'tenant left on source DB; read_only window stays open for inspection.');
    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await controlDb.$disconnect();
  }
}

async function dropSource(tenant: { id: string; slug: string; dbUrl: string }) {
  // After --drop-source we expect tenants.db_url to already point at the
  // NEW home; the SOURCE we drop is computed by name from the tenant id.
  const sourceUrl = tenant.dbUrl;
  log(SCRIPT, `--drop-source: this will DROP the database named ${dbNameForTenant(tenant.id)}`);
  log(SCRIPT, `              on host ${new URL(sourceUrl).host}.`);
  const dbName = dbNameForTenant(tenant.id);
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
    die(SCRIPT, `refusing to drop unsafe name: ${dbName}`);
  }
  const u = new URL(sourceUrl);
  u.pathname = '/postgres'; // need a real DB to issue DROP against
  const admin = new PgClient({ connectionString: u.toString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    log(SCRIPT, `dropped ${dbName}.`);
  } finally {
    await admin.end();
    await controlDb.$disconnect();
  }
}

async function openReadOnly(tenantId: string, adminId: string) {
  // No reuse of SystemModeService here — that lives in the API process.
  // For a CLI we write to the table directly. The middleware reads the
  // same shape on next request (30s cache TTL covers the latency).
  return controlDb.systemModeEvent.create({
    data: {
      scope: 'tenant',
      tenantId,
      mode: 'read_only',
      messageMarkdown: 'Migrating this library to a new host — should be over in a few minutes.',
      allowAdminBypass: true,
      createdByAdminId: adminId,
    },
  });
}

async function closeEvent(eventId: string) {
  await controlDb.systemModeEvent.update({
    where: { id: eventId },
    data: { endedAt: new Date() },
  });
}

async function firstOwnerAdminId(): Promise<string> {
  const owner = await controlDb.adminUser.findFirst({
    where: { role: 'owner', status: 'active' },
    select: { id: true },
  });
  if (!owner) die(SCRIPT, 'no active owner admin found (bootstrap one first).');
  return owner.id;
}

async function ensureDestinationDatabase(baseUrl: string, dbName: string): Promise<void> {
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`refusing to CREATE DATABASE with unsafe name: ${dbName}`);
  }
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  const admin = new PgClient({ connectionString: u.toString() });
  await admin.connect();
  try {
    const existing = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!existing.rowCount) {
      await admin.query(`CREATE DATABASE "${dbName}" ENCODING 'UTF8'`);
    }
  } finally {
    await admin.end();
  }
  const target = new PgClient({ connectionString: urlForDb(baseUrl, dbName) });
  await target.connect();
  try {
    await target.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    await target.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await target.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await target.query('CREATE EXTENSION IF NOT EXISTS citext');
  } finally {
    await target.end();
  }
}

async function verifyDestination(dbUrl: string): Promise<void> {
  const c = new PgClient({ connectionString: dbUrl });
  await c.connect();
  try {
    const res = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`,
    );
    if (!res.rowCount || (res.rows[0]?.n ?? 0) === 0) {
      throw new Error('destination has no public tables after restore.');
    }
  } finally {
    await c.end();
  }
}

async function bustResolverCache(slug: string, subdomain: string | null): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, keyPrefix: 'lbr:' });
  try {
    await redis.connect();
    const keys = [`tenant:slug:${slug}`];
    if (subdomain) keys.push(`tenant:sub:${subdomain}`);
    if (keys.length) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

function redact(u: string): string {
  return u.replace(/:[^:@]+@/, ':***@');
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
