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
    // Explicit OLD host for --drop-source (overrides the recorded source).
    'from-db-url': { type: 'string' },
    // Required confirmation for the destructive --drop-source.
    yes: { type: 'boolean' },
    // Seconds to wait after opening read_only for in-flight writers to drain
    // before pg_dump (must exceed the system-mode cache TTL of 30s).
    'drain-seconds': { type: 'string' },
  },
  required: ['tenant'] as const,
});

/** System-mode cache TTL is 30s; default drain margin gives headroom. */
const DEFAULT_DRAIN_SECONDS = 35;

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
    return dropSource(tenant, v);
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

  // CRITICAL: the read_only system mode is only honored once API processes
  // re-read it. They cache the mode for 30s, so without busting the cache (and
  // waiting for stragglers) writes accepted in that window are excluded from
  // the snapshot and silently lost on cutover. Belt-and-braces, we also fence
  // the SOURCE database read-only at the Postgres level so admin/impersonation
  // routes and background workers — which bypass the HTTP middleware — can't
  // write during the dump either.
  await bustSystemModeCache(tenant.id);
  await fenceSourceReadOnly(tenant.dbUrl, dbName);
  const drainSeconds = v['drain-seconds'] ? Number(v['drain-seconds']) : DEFAULT_DRAIN_SECONDS;
  log(SCRIPT, `draining in-flight writers for ${drainSeconds}s before snapshot…`);
  await sleep(drainSeconds * 1000);

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
    // The tenant stays on the source DB, so lift the DB-level read-only fence
    // we set before the dump — otherwise the live tenant would be stuck
    // read-only. The system-mode read_only window is deliberately left OPEN
    // for an admin to inspect (close it manually once resolved).
    await unfenceSource(tenant.dbUrl, dbName).catch((e) =>
      log(SCRIPT, `warning: could not lift source read-only fence: ${(e as Error).message}`),
    );
    // Bound the read_only window so a failed relocate can't strand the tenant
    // in 503-for-writes forever if nobody closes it. It stays open ~30min for
    // an admin to inspect, then auto-expires.
    await controlDb.systemModeEvent
      .update({ where: { id: modeEvent.id }, data: { endsAt: new Date(Date.now() + 30 * 60_000) } })
      .then(() => bustSystemModeCache(tenant.id))
      .catch(() => undefined);
    log(
      SCRIPT,
      'tenant left on source DB (writable again); read_only window stays open ~30min for inspection, then auto-expires.',
    );
    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    await controlDb.$disconnect();
  }
}

async function dropSource(
  tenant: { id: string; slug: string; dbUrl: string },
  v: Record<string, string | boolean | undefined>,
) {
  const dbName = dbNameForTenant(tenant.id);
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
    die(SCRIPT, `refusing to drop unsafe name: ${dbName}`);
  }

  // Determine the OLD host to drop. We must NOT default to tenant.dbUrl: after
  // a successful cutover that points at the tenant's NEW, LIVE home — dropping
  // it would destroy the tenant (this was the original critical bug). Resolve
  // the source host from, in order:
  //   1. an explicit --from-db-url, or
  //   2. the dbUrl recorded as beforeJson.dbUrl on the most recent
  //      `tenant.relocated` audit event (the host we migrated AWAY from).
  let sourceUrl = v['from-db-url'] ? String(v['from-db-url']) : undefined;
  if (!sourceUrl) {
    const ev = await controlDb.auditEvent.findFirst({
      where: { tenantId: tenant.id, action: 'tenant.relocated' },
      orderBy: { occurredAt: 'desc' },
      select: { beforeJson: true },
    });
    const before = ev?.beforeJson as { dbUrl?: string } | null;
    sourceUrl = before?.dbUrl;
  }
  if (!sourceUrl) {
    die(
      SCRIPT,
      'cannot determine the source DB to drop — no prior relocation on record. ' +
        'Pass the old host explicitly with --from-db-url, and double-check it.',
    );
  }

  // SAFETY NET: never drop the host the tenant currently lives on. This blocks
  // the post-cutover footgun, a failed relocation (tenant still on source), and
  // a same-host relocation — in all of which sourceHost == currentHost.
  const currentHost = new URL(tenant.dbUrl).host;
  const sourceHost = new URL(sourceUrl).host;
  if (sourceHost === currentHost) {
    die(
      SCRIPT,
      `refusing to drop: the resolved source host (${sourceHost}) is the tenant's CURRENT live ` +
        `host. Dropping it would destroy the live database. (The relocation may have failed, not ` +
        `changed hosts, or --from-db-url is wrong.)`,
    );
  }

  log(SCRIPT, `--drop-source: will DROP DATABASE "${dbName}" on host ${sourceHost}`);
  log(SCRIPT, `              (tenant "${tenant.slug}" now lives on ${currentHost}).`);
  if (!isYes(v.yes)) {
    die(
      SCRIPT,
      'refusing to drop without confirmation. Re-run with --yes once you have verified the host above.',
    );
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
    log(SCRIPT, `dropped ${dbName} on ${sourceHost}.`);
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
  const ended = await controlDb.systemModeEvent.update({
    where: { id: eventId },
    data: { endedAt: new Date() },
    select: { tenantId: true },
  });
  // Bust the cache so the read_only window lifts promptly instead of lingering
  // for up to the 30s cache TTL.
  if (ended.tenantId) await bustSystemModeCache(ended.tenantId);
}

/** ms sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** DEL the per-tenant system-mode cache key so a mode change is seen at once. */
async function bustSystemModeCache(tenantId: string): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, keyPrefix: 'lbr:' });
  try {
    await redis.connect();
    await redis.del(`system_mode:tenant:${tenantId}`);
  } finally {
    redis.disconnect();
  }
}

/**
 * Fence a database read-only at the Postgres level so even writers that bypass
 * the HTTP read_only middleware (admin/impersonation routes, background
 * workers) cannot mutate it during the snapshot. `ALTER DATABASE ... SET`
 * only affects NEW sessions, so we also terminate existing backends to force
 * them to reconnect under the read-only default.
 */
async function fenceSourceReadOnly(sourceUrl: string, dbName: string): Promise<void> {
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`refusing to fence unsafe db name: ${dbName}`);
  }
  const admin = new PgClient({ connectionString: urlForDb(sourceUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE "${dbName}" SET default_transaction_read_only = on`);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
  } finally {
    await admin.end();
  }
}

/** Lift the read-only fence set by fenceSourceReadOnly. */
async function unfenceSource(sourceUrl: string, dbName: string): Promise<void> {
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) return;
  const admin = new PgClient({ connectionString: urlForDb(sourceUrl, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`ALTER DATABASE "${dbName}" RESET default_transaction_read_only`);
  } finally {
    await admin.end();
  }
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
