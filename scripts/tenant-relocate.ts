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
 *  10. Drain post-cutover stragglers
 *  11. End the read_only window
 *  12. Lift the source's DB-level read-only fence — LAST (data-integrity-08)
 *
 * Steps 8–12 are an order, not a list. The fence used to come off between 7
 * and 8, which meant the tenant still resolved to the source while the source
 * had become writable again — see the comment on step 12 for the rows that
 * cost.
 *
 * If anything between steps 3 and 7 fails, the tenant stays on the source
 * DB and the read_only window stays open for an admin to inspect. The
 * source DB is left intact — call `--drop-source` manually after a
 * post-migration probe to free the disk.
 *
 * This script fences, restores over, and can drop databases, so it refuses to
 * run against a cluster that is not on this machine unless you pass
 * `--allow-remote`. Every production run needs that flag.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL  — control-plane DB
 *     REDIS_URL             — to bust the per-tenant resolver cache
 *
 *   USAGE:
 *     pnpm tenant:relocate \
 *       --tenant=acme \
 *       --to-db-url='postgresql://lib:pw@cell-02.lan:5432/' \
 *       --to-cell=cell-02 \
 *       --allow-remote \
 *       --dry-run
 *
 *     # After verifying the new home is healthy, optionally:
 *     pnpm tenant:relocate --tenant=acme --drop-source --allow-remote --yes
 */
import { execFile } from 'node:child_process';
import { pinDatabaseTimezoneSql } from '@libriant/shared/postgres-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client as PgClient } from 'pg';
import { Redis } from 'ioredis';
import {
  applyTenantRoleGrants,
  controlDb,
  dropTenantRoles,
  ensureTenantRoles,
  newRuntimePassword,
  otherSlot,
  parseTenantDbMasterKey,
  sealTenantPassword,
  slotOfRole,
  tenantLoginRole,
  type Prisma,
} from '@libriant/db-control';
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
    // Seconds to wait AFTER the cutover before the source stops being fenced.
    'cutover-drain-seconds': { type: 'string' },
    // Consent to point this script at a Postgres cluster that is not on this
    // machine. See `assertLocalCluster`.
    'allow-remote': { type: 'boolean' },
  },
  required: ['tenant'] as const,
});

/** System-mode cache TTL is 30s; default drain margin gives headroom. */
const DEFAULT_DRAIN_SECONDS = 35;

/**
 * How long the source stays fenced AFTER the control plane has been moved and
 * the resolver cache busted (data-integrity-08).
 *
 * It only has to outlive work that had ALREADY resolved the old address when
 * the cache was busted, which is two bounded things:
 *
 *   - an HTTP request holding a `TenantContext` it resolved a moment ago, and
 *   - `TenantResolverService`'s degraded memo, which holds a resolved context
 *     in-process for DEGRADED_MEMO_MS = 5 s, but only along the path where a
 *     Redis read THREW.
 *
 * NOT the tenant cache TTL (TENANT_CACHE_TTL_SEC, 300 s), which is what this
 * was first written as. That would fence a library's database for five minutes
 * after it had already been moved, for nothing: the per-process address map in
 * tenant-resolver.service.ts is consulted ONLY after a positive Redis hit
 * (`resolveCached`, and the comment above it says so), so the DEL that
 * `bustResolverCache` issues forces every process to re-read the control plane
 * on its very next request. There is no straggler holding the old URL for a
 * TTL — the audit's "any API process still holding a cached tenant client"
 * does not exist.
 */
const DEFAULT_CUTOVER_DRAIN_SECONDS = 15;

/**
 * Hostnames that mean "this machine". Anything else is somebody's production.
 */
const LOCAL_PG_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function pgHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '(unparseable)';
  }
}

/**
 * Refuse to touch a Postgres cluster that is not on this machine unless the
 * operator says so on the command line.
 *
 * This script fences a live database read-only, restores over a database with
 * `pg_restore --clean`, and — under `--drop-source` — issues DROP DATABASE.
 * Every one of those is unrecoverable, and the only thing that decides which
 * cluster receives them is a URL typed into a flag or sitting in an env var
 * from another shell. The relocation family has already produced one
 * data-destroying footgun (`--drop-source` dropping the tenant's LIVE database,
 * REL-001), so the bar here is that reaching production must be a deliberate
 * act rather than the default.
 *
 * `--allow-remote` is the deliberate act. It is not a safety you can forget to
 * turn on: without it the script stops before it has touched anything.
 */
function assertLocalCluster(what: string, url: string, allowRemote: boolean): void {
  const host = pgHost(url);
  if (LOCAL_PG_HOSTS.has(host)) return;
  if (allowRemote) {
    log(SCRIPT, `--allow-remote: proceeding against NON-LOCAL ${what} at ${host}.`);
    return;
  }
  die(
    SCRIPT,
    `refusing to run against a non-local cluster: ${what} resolves to host "${host}". ` +
      'This script fences a database read-only, restores over one with --clean, and can ' +
      'DROP DATABASE. Re-run with --allow-remote once you have read the host above and ' +
      'meant it.',
  );
}

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const slug = String(v.tenant);
  const dryRun = isYes(v['dry-run']);
  const dropSourceMode = isYes(v['drop-source']);
  const allowRemote = isYes(v['allow-remote']);

  assertLocalCluster('CONTROL_DATABASE_URL', process.env.CONTROL_DATABASE_URL ?? '', allowRemote);

  const tenant = await controlDb.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      dbUrl: true,
      cellId: true,
      customSubdomain: true,
      // Which rotation slot the tenant is live on, so the destination roles
      // land on the other one.
      dbCredentials: { select: { roleName: true } },
    },
  });
  if (!tenant) die(SCRIPT, `tenant "${slug}" not found.`);

  assertLocalCluster(`tenant "${slug}" live database`, tenant.dbUrl, allowRemote);

  if (dropSourceMode) {
    return dropSource(tenant, v, allowRemote);
  }

  const targetHostUrl = v['to-db-url']
    ? String(v['to-db-url'])
    : die(SCRIPT, '--to-db-url is required (use --drop-source for post-cutover cleanup).');
  const newCellId = v['to-cell'] ? String(v['to-cell']) : tenant.cellId;
  assertLocalCluster('--to-db-url destination', targetHostUrl, allowRemote);

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

    // tenant-isolation-02: `pg_restore --no-owner --no-acl` deliberately drops
    // every grant, and the destination is a DIFFERENT cluster, so this tenant
    // has no login role there at all. Create one before the cutover.
    //
    // Onto the OTHER slot, never the one in use. The source is still serving
    // reads under its existing credential until the cache bust below; taking
    // the live slot's name here would mean re-issuing a password that processes
    // are still holding, for a host they are still pointed at. Alternating
    // makes the two credentials disjoint, which is what leaves no window.
    log(SCRIPT, 'creating per-tenant database roles on the destination…');
    const currentSlot = tenant.dbCredentials
      ? slotOfRole(tenant.id, tenant.dbCredentials.roleName)
      : null;
    const destSlot = currentSlot ? otherSlot(currentSlot) : 'a';
    const runtimePassword = newRuntimePassword();
    await ensureTenantRoles({
      tenantDbUrl: newDbUrl,
      tenantId: tenant.id,
      activeSlot: destSlot,
      password: runtimePassword,
    });
    await applyTenantRoleGrants({ tenantDbUrl: newDbUrl, tenantId: tenant.id });
    const destCredential = sealTenantPassword({
      tenantId: tenant.id,
      roleName: tenantLoginRole(tenant.id, destSlot),
      password: runtimePassword,
      masterKey: parseTenantDbMasterKey(reqEnv('TENANT_DB_MASTER_KEY')),
    });
    log(SCRIPT, `  destination runtime role=${destCredential.roleName}`);

    log(SCRIPT, 'updating control plane (db_url + cell_id + runtime credential)…');
    await controlDb.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { dbUrl: newDbUrl, cellId: newCellId },
      });
      // The address and the credential move together or neither does: a
      // committed `db_url` pointing at a host where the sealed role does not
      // exist is a tenant nothing can open.
      await tx.tenantDbCredential.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
          roleName: destCredential.roleName,
          encryptedPwd: destCredential.encryptedPwd,
          encryptionKeyId: destCredential.encryptionKeyId,
          encryptionNonce: destCredential.encryptionNonce,
        },
        update: {
          roleName: destCredential.roleName,
          encryptedPwd: destCredential.encryptedPwd,
          encryptionKeyId: destCredential.encryptionKeyId,
          encryptionNonce: destCredential.encryptionNonce,
          rotatedAt: new Date(),
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'system',
          action: 'tenant.relocated',
          targetType: 'tenant',
          targetId: tenant.id,
          // beforeJson.dbUrl is the OLD host — --drop-source reads it to know
          // which DB to delete. Do not change its shape.
          beforeJson: { dbUrl: tenant.dbUrl, cellId: tenant.cellId },
          // REL-002: name the fenced database, because at the instant this row
          // is written the SOURCE is still fenced read-only — the fence is now
          // the last thing this script lifts (see below). A run that dies
          // between here and the end leaves it on, and this is where an
          // operator finds which database to RESET.
          afterJson: {
            dbUrl: newDbUrl,
            cellId: newCellId,
            sourceReadOnlyFencedDb: dbName,
          },
        },
      });
    });

    log(SCRIPT, 'busting TenantResolver cache…');
    await bustResolverCache(tenant.slug, tenant.customSubdomain);

    // data-integrity-08: the DB-level fence on the SOURCE comes off LAST — after
    // the control plane names the destination, after the resolver cache has been
    // busted, and after a drain for whatever had already resolved the old
    // address. It used to come off FIRST, immediately after verifyDestination
    // and before all three of those, which left a window in which the tenant
    // still resolved to the source AND the source accepted writes again. That
    // is not theoretical: driving a real relocation with a worker-shaped writer
    // attached (a fresh session per attempt, straight at the tenant DB, exactly
    // what the retention/notification sweeps do) put 11 rows into the source in
    // the 151 ms between the old unfence and the cache bust, with
    // `tenants.dbUrl` still naming the source at the instant of the first one.
    // Those rows were behind the pg_dump and were simply not at the destination
    // afterwards — 68 rows on the source, 56 on the destination, no
    // reconciliation step anywhere.
    //
    // Order within the tail matters too: close the read_only window BEFORE
    // unfencing, so ordinary HTTP writes resume against the destination while
    // the abandoned source is still incapable of accepting one.
    const cutoverDrainSeconds = v['cutover-drain-seconds']
      ? Number(v['cutover-drain-seconds'])
      : DEFAULT_CUTOVER_DRAIN_SECONDS;
    log(SCRIPT, `draining post-cutover stragglers for ${cutoverDrainSeconds}s…`);
    await sleep(cutoverDrainSeconds * 1000);

    log(SCRIPT, 'closing read_only window…');
    await closeEvent(modeEvent.id);

    log(SCRIPT, 'lifting source read-only fence (last, on purpose)…');
    await unfenceSource(tenant.dbUrl, dbName).catch((e) => {
      log(
        SCRIPT,
        `warning: could not lift source read-only fence (lift it manually with ` +
          `ALTER DATABASE "${dbName}" RESET default_transaction_read_only): ${(e as Error).message}`,
      );
    });

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
  allowRemote: boolean,
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

  // The DROP lands on THIS url, which is read out of an audit row or a flag and
  // has been wrong before (REL-001). Check it against the local-cluster bar too.
  assertLocalCluster('--drop-source target', sourceUrl, allowRemote);

  // SAFETY NET: never drop the host the tenant currently lives on. This blocks
  // the post-cutover footgun, a failed relocation (tenant still on source), and
  // a same-host relocation — in all of which the source resolves to the current
  // live database.
  //
  // REL-001: compare CANONICALIZED endpoints, not raw `URL.host`. `URL.host`
  // includes the port verbatim, so `cell.lan` and `cell.lan:5432` compare as
  // DIFFERENT even though Postgres treats an omitted port as 5432 — a common
  // mismatch when operators record one URL with the explicit port and the other
  // without. That gap let `--drop-source --yes` drop the tenant's LIVE DB on the
  // same server. Resolve the default port and also compare the (server, dbName)
  // tuple so a same-host, same-database drop is refused regardless of notation.
  const currentEndpoint = canonicalEndpoint(tenant.dbUrl);
  const sourceEndpoint = canonicalEndpoint(sourceUrl);
  const currentHost = currentEndpoint.hostPort;
  const sourceHost = sourceEndpoint.hostPort;
  const currentDbName = new URL(tenant.dbUrl).pathname.replace(/^\//, '');
  if (
    sourceHost === currentHost ||
    (sourceEndpoint.host === currentEndpoint.host && dbName === currentDbName)
  ) {
    die(
      SCRIPT,
      `refusing to drop: the resolved source (${sourceHost}/${dbName}) is the tenant's CURRENT live ` +
        `database. Dropping it would destroy the live data. (The relocation may have failed, not ` +
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
  }
  // The abandoned cluster still carries this tenant's login roles, and one of
  // them is the credential the fleet was using right up to the cutover. The
  // database is gone, so they grant nothing — but a role that can still
  // authenticate against a cluster is a credential, and leaving it is how a
  // decommissioned host stays interesting to an attacker.
  try {
    const dropped = await dropTenantRoles({ adminUrl: u.toString(), tenantId: tenant.id });
    if (dropped.length) log(SCRIPT, `dropped ${dropped.length} source role(s) on ${sourceHost}.`);
  } catch (e) {
    log(SCRIPT, `warning: could not drop source roles on ${sourceHost}: ${(e as Error).message}`);
  }
  await controlDb.$disconnect();
}

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) die(SCRIPT, `missing required env var ${key}`);
  return v;
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
    // THE UTC PIN, before the `pg_restore` this function precedes. See
    // packages/shared/src/postgres-session.ts.
    //
    // IT DOES NOT REPAIR WHAT ARRIVES IN THE DUMP. A relocation moves bytes
    // faithfully, so `audit_log` partition bounds and every stored instant carry
    // the SOURCE cluster's frame across; pinning the destination only stops the
    // problem growing from here. `scripts/tenant-timezone-audit.ts` is what
    // reports a database whose partitions did not arrive on UTC boundaries.
    await admin.query(pinDatabaseTimezoneSql(dbName));
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

/**
 * Canonicalize a Postgres URL's network endpoint for safe comparison (REL-001):
 * resolve an omitted port to the Postgres default (5432) so `host` and
 * `host:5432` compare equal. Returns the bare hostname and the `host:port`
 * pair.
 */
function canonicalEndpoint(dbUrl: string): { host: string; hostPort: string } {
  const u = new URL(dbUrl);
  const port = u.port || '5432';
  return { host: u.hostname, hostPort: `${u.hostname}:${port}` };
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
