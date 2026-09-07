/**
 * Libriant — fan-out tenant migrations, as a durable operation.
 *
 * WHAT THIS USED TO BE. A loop over every tenant that shelled out to `prisma
 * migrate deploy`, printed a summary and exited. Nothing survived the process,
 * and two consequences followed directly:
 *
 *   A partial fan-out was unrecoverable. Forty tenants in, one fails; the
 *   script exits 2 and the only way forward is to run the whole thing again
 *   and trust every already-migrated tenant is a no-op. That holds until a
 *   migration is not idempotent — and this repo has migrations that
 *   deduplicate rows and repair orphaned holds, which are exactly the ones
 *   that must not run twice.
 *
 *   Nobody could say what schema a library was on without opening a connection
 *   to its database. That is the first question of an incident.
 *
 * WHAT IT IS NOW. Every run is a row in `migration_runs`, every tenant a row
 * in `migration_run_tenants`, and every tenant's resulting schema a row in
 * `tenant_schema_state`. `--resume` re-enters a run and skips what already
 * succeeded. A per-tenant deadline stops one wedged database holding the fleet.
 *
 * THE BARRIER. A tenant whose `_libriant_schema_state.onlinePending` is set has
 * an online script part-way through: half a backfill committed, or an index
 * left INVALID by a failed CONCURRENTLY build. Applying more migrations on top
 * of that is how a database ends up in a state nothing reports. Such a tenant
 * is SKIPPED, loudly, and `pnpm tenant:online` is what clears it.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL    — control-plane DB
 *
 *   USAGE:
 *     pnpm tenant:migrate                          # all active tenants
 *     pnpm tenant:migrate --plan                   # read-only: who, and what is pending
 *     pnpm tenant:migrate --only=acme,step18a      # specific slugs
 *     pnpm tenant:migrate --include-archived       # archived too
 *     pnpm tenant:migrate --concurrency=4          # parallel jobs (default 1)
 *     pnpm tenant:migrate --timeout=600            # per-tenant seconds (default 900)
 *     pnpm tenant:migrate --resume=<runId>         # continue a partial run
 *     pnpm tenant:migrate --note="2.0 rollout"     # label the run
 *     pnpm tenant:migrate --force                  # ignore the online barrier
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyTenantRoleGrants, controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, withV2Schema } from '@libriant/db-tenant';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TENANT_DIR = path.resolve(HERE, '..', 'packages', 'db-tenant');

const SCRIPT = 'tenant-migrate';
const DEFAULT_TIMEOUT_SEC = 900;

const args = parseArgs({
  name: SCRIPT,
  description: 'Apply tenant migrations to every tenant, with a durable ledger.',
  options: {
    only: { type: 'string' },
    'include-archived': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    plan: { type: 'boolean' },
    resume: { type: 'string' },
    timeout: { type: 'string' },
    note: { type: 'string' },
    force: { type: 'boolean' },
    concurrency: { type: 'string' },
  },
});

type Tenant = { id: string; slug: string; dbUrl: string; status: string };

interface TenantState {
  readonly schemaMajor: number | null;
  readonly onlinePending: string | null;
  readonly applied: number;
  readonly last: string | null;
  readonly reachable: boolean;
  readonly error?: string;
}

/**
 * Read what the tenant database says about ITSELF.
 *
 * `tenant_schema_state` in the control plane is a cache; this is the source of
 * truth, and `--resume` consults it rather than trusting the cache — a run
 * that died may have applied a migration and never recorded it.
 */
async function readTenantState(dbUrl: string): Promise<TenantState> {
  const db = makeTenantPrismaClient({ databaseUrl: dbUrl, maxPoolSize: 1 });
  try {
    const applied = await db.$queryRawUnsafe<{ n: bigint; last: string | null }[]>(
      `SELECT count(*)::bigint AS n,
              (SELECT migration_name FROM "_prisma_migrations"
                WHERE finished_at IS NOT NULL
                ORDER BY finished_at DESC LIMIT 1) AS last
         FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    let schemaMajor: number | null = null;
    let onlinePending: string | null = null;
    // ASK whether the table exists rather than querying it and catching. The
    // table arrives in 20260906000000, so on every tenant behind that migration
    // the query is a normal, expected miss — and Prisma logs a failed raw query
    // at ERROR level regardless of who catches it, which would print a stack
    // trace per tenant during an ordinary fan-out and teach everyone to ignore
    // the loudest output the tool produces.
    const present = await db.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT pg_catalog.to_regclass('public._libriant_schema_state') IS NOT NULL AS present`,
    );
    if (present[0]?.present) {
      const st = await db.$queryRawUnsafe<{ schemaMajor: number; onlinePending: string | null }[]>(
        `SELECT "schemaMajor", "onlinePending" FROM "_libriant_schema_state" WHERE "id" = 1`,
      );
      schemaMajor = st[0]?.schemaMajor ?? null;
      onlinePending = st[0]?.onlinePending ?? null;
    }
    return {
      schemaMajor,
      onlinePending,
      applied: Number(applied[0]?.n ?? 0n),
      last: applied[0]?.last ?? null,
      reachable: true,
    };
  } catch (err) {
    return {
      schemaMajor: null,
      onlinePending: null,
      applied: 0,
      last: null,
      reachable: false,
      error: String((err as Error).message).split('\n')[0],
    };
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const planOnly = isYes(v.plan) || isYes(v['dry-run']);
  const includeArchived = isYes(v['include-archived']);
  const force = isYes(v.force);
  const concurrency = Math.max(1, Math.min(16, Number(v.concurrency ?? '1')));
  // `Number('abc')` is NaN, and `Math.max(30, NaN)` is NaN — which reaches
  // execFile's `timeout` as NaN and disables the deadline entirely. A typo in
  // the flag must not silently remove the protection the flag exists to give.
  const timeoutRaw = Number(v.timeout ?? DEFAULT_TIMEOUT_SEC);
  if (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
    die(SCRIPT, `--timeout must be a positive number of seconds; got ${String(v.timeout)}`);
  }
  // Floored at 30s: below that the deadline fires while Prisma is still
  // starting up, and every tenant "times out" without a migration attempted.
  const timeoutMs = Math.max(30, timeoutRaw) * 1000;
  const resumeId = v.resume ? String(v.resume) : null;
  const only = v.only
    ? String(v.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.status = { not: 'archived' };
  if (only && only.length) where.slug = { in: only };

  let tenants: Tenant[] = await controlDb.tenant.findMany({
    where,
    select: { id: true, slug: true, dbUrl: true, status: true },
    orderBy: { slug: 'asc' },
  });

  if (only) {
    const missing = only.filter((s) => !tenants.find((t) => t.slug === s));
    if (missing.length) die(SCRIPT, `unknown tenant slug(s): ${missing.join(', ')}`);
  }

  // --- resume: narrow to what the previous run did not finish ---------------
  let alreadyOk = new Set<string>();
  if (resumeId) {
    const prior = await controlDb.migrationRun.findUnique({
      where: { id: resumeId },
      include: { tenants: true },
    });
    if (!prior) die(SCRIPT, `no migration run with id ${resumeId}`);
    alreadyOk = new Set(prior.tenants.filter((t) => t.status === 'ok').map((t) => t.tenantId));
    const wanted = new Set(prior.tenants.map((t) => t.tenantId));
    tenants = tenants.filter((t) => wanted.has(t.id));
    log(
      SCRIPT,
      `resuming ${resumeId}: ${prior.tenants.length} tenant(s) in the original plan, ` +
        `${alreadyOk.size} already ok, ${tenants.length - alreadyOk.size} to attempt`,
    );
  }

  log(
    SCRIPT,
    `${tenants.length} tenant(s) (concurrency=${concurrency}, timeout=${timeoutMs / 1000}s` +
      `${planOnly ? ', PLAN ONLY' : ''})`,
  );

  // --- the plan: read every tenant's actual state ---------------------------
  const states = new Map<string, TenantState>();
  for (const t of tenants) states.set(t.id, await readTenantState(t.dbUrl));

  if (planOnly) {
    log(SCRIPT, '---');
    for (const t of tenants) {
      const s = states.get(t.id) as TenantState;
      const flags = [
        `schema ${s.schemaMajor ?? '1(pre-ledger)'}`,
        `${s.applied} applied`,
        s.last ? `last=${s.last}` : 'last=(none)',
        s.onlinePending ? `BARRIER: online "${s.onlinePending}" unfinished` : '',
        alreadyOk.has(t.id) ? 'already ok in the resumed run' : '',
        s.reachable ? '' : `UNREACHABLE: ${s.error}`,
      ].filter(Boolean);
      log(SCRIPT, `  ${t.slug.padEnd(20)} ${t.status.padEnd(9)} ${flags.join(' · ')}`);
    }
    await controlDb.$disconnect();
    return;
  }

  // --- open the run ---------------------------------------------------------
  const run = await controlDb.migrationRun.create({
    data: {
      note: v.note ? String(v.note) : null,
      invocation: process.argv.slice(1).join(' '),
      resumedFromId: resumeId,
      plannedCount: tenants.length,
      tenants: {
        create: tenants.map((t) => ({
          tenantId: t.id,
          slug: t.slug,
          status: alreadyOk.has(t.id) ? ('skipped' as const) : ('planned' as const),
        })),
      },
    },
  });
  log(SCRIPT, `run ${run.id} opened`);

  const queue = tenants.filter((t) => !alreadyOk.has(t.id));
  let okCount = 0;
  let failCount = 0;
  let skippedCount = alreadyOk.size;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const state = states.get(t.id) as TenantState;

      if (state.onlinePending && !force) {
        skippedCount += 1;
        await mark(run.id, t, 'skipped', {
          error:
            `online script "${state.onlinePending}" is unfinished on this database. ` +
            `Run \`pnpm tenant:online --only=${t.slug}\` first, or pass --force if you are ` +
            `certain the remaining steps are safe to skip.`,
        });
        log(SCRIPT, `  ${t.slug.padEnd(20)} ⏸ barrier: online "${state.onlinePending}" unfinished`);
        continue;
      }

      await mark(run.id, t, 'running', { startedAt: new Date() });
      const started = Date.now();
      const outcome = await migrateOne(t, timeoutMs);
      const durationMs = Date.now() - started;

      if (outcome.ok) {
        okCount += 1;
        // Re-grant before anything reads the migrated database. `prisma migrate
        // deploy` runs as the superuser, so a table it just created is owned by
        // the superuser and — for a tenant provisioned before the default
        // privileges were in place — invisible to that tenant's own runtime
        // role. Silent, total, and it would surface as "relation does not
        // exist" on a table the operator can see in psql.
        await applyTenantRoleGrants({ tenantDbUrl: t.dbUrl, tenantId: t.id }).catch((e) => {
          log(SCRIPT, `  ${t.slug.padEnd(20)} ⚠ could not re-grant: ${(e as Error).message}`);
        });
        const after = await readTenantState(t.dbUrl);
        await mark(run.id, t, 'ok', {
          appliedCount: outcome.applied,
          finishedAt: new Date(),
          durationMs,
        });
        await controlDb.tenantSchemaState.upsert({
          where: { tenantId: t.id },
          create: {
            tenantId: t.id,
            schemaMajor: after.schemaMajor ?? 1,
            lastMigration: after.last,
            migrationCount: after.applied,
            onlinePending: after.onlinePending,
            checkedAt: new Date(),
          },
          update: {
            schemaMajor: after.schemaMajor ?? 1,
            lastMigration: after.last,
            migrationCount: after.applied,
            onlinePending: after.onlinePending,
            checkedAt: new Date(),
          },
        });
        log(SCRIPT, `  ${t.slug.padEnd(20)} ✓ ${outcome.summary} (${durationMs} ms)`);
      } else {
        failCount += 1;
        await mark(run.id, t, outcome.timedOut ? 'timeout' : 'failed', {
          error: outcome.error,
          finishedAt: new Date(),
          durationMs,
        });
        log(SCRIPT, `  ${t.slug.padEnd(20)} ✗ ${outcome.error}`);
      }
    }
  });
  await Promise.all(workers);

  await controlDb.migrationRun.update({
    where: { id: run.id },
    data: {
      status: failCount > 0 ? 'failed' : 'completed',
      okCount,
      failCount,
      skippedCount,
      finishedAt: new Date(),
    },
  });

  log(SCRIPT, '---');
  log(SCRIPT, `run ${run.id}: ${okCount} ok, ${failCount} failed, ${skippedCount} skipped.`);
  if (failCount > 0 || skippedCount > alreadyOk.size) {
    log(SCRIPT, `resume with:  pnpm tenant:migrate --resume=${run.id}`);
  }
  await controlDb.$disconnect();
  if (failCount > 0) process.exit(2);
}

async function mark(
  runId: string,
  t: Tenant,
  status: 'planned' | 'running' | 'ok' | 'failed' | 'skipped' | 'timeout',
  data: Record<string, unknown> = {},
) {
  await controlDb.migrationRunTenant.update({
    where: { runId_tenantId: { runId, tenantId: t.id } },
    data: { status, ...data },
  });
}

type Outcome =
  { ok: true; applied: number; summary: string } | { ok: false; error: string; timedOut: boolean };

async function migrateOne(t: Tenant, timeoutMs: number): Promise<Outcome> {
  try {
    // BOTH folders, and the per-tenant timeout covers the pair. The 2.0 baseline
    // lives in its own Postgres schema with its own `_prisma_migrations`; a
    // tenant that receives only the 1.0 folder is a database every 2.0 service
    // fails against at its first query, and it would be reported here as a
    // success. See `packages/db-tenant/src/v2.ts`.
    const started = Date.now();
    const one = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DB_TENANT_DIR,
      env: { ...process.env, TENANT_DATABASE_URL: t.dbUrl },
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });
    const two = await execFileP(
      'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--config', 'prisma-v2.config.ts'],
      {
        cwd: DB_TENANT_DIR,
        env: { ...process.env, TENANT_DATABASE_URL: withV2Schema(t.dbUrl) },
        maxBuffer: 16 * 1024 * 1024,
        timeout: Math.max(1_000, timeoutMs - (Date.now() - started)),
        killSignal: 'SIGTERM',
      },
    );
    const stdout = `${one.stdout}\n${two.stdout}`;
    const stderr = `${one.stderr}\n${two.stderr}`;
    const out = `${stdout}\n${stderr}`;
    // Both deploys must say so; one folder being up to date while the other
    // applied something is not "up to date".
    if ((out.match(/No pending migrations/g) ?? []).length >= 2) {
      return { ok: true, applied: 0, summary: 'up to date' };
    }
    const applied = (out.match(/└─\s*\d+/g) ?? []).length;
    return { ok: true, applied, summary: `${applied} applied` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    // A killed child means the deadline fired. The migration may STILL BE
    // RUNNING on the database — Postgres does not care that we stopped
    // waiting — which is why a resume re-reads the tenant rather than assuming
    // it did not happen.
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    const msg = timedOut
      ? `timed out after ${timeoutMs / 1000}s (the migration may still be running on the database)`
      : String(e.message).split('\n').slice(0, 3).join(' ');
    return { ok: false, error: msg, timedOut };
  }
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
