import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import type { MaintenanceRun, Prisma } from '@libriant/db-control';
import { makeTenantPrismaClient, disconnectTenantClient } from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import type { RedisService } from '../platform/redis.service.js';
import type { MaintenanceIssue, MaintenanceTargetResult } from './maintenance.constants.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repo-root/packages/db-{tenant,control} — cwd for `prisma migrate …`. */
const DB_TENANT_DIR = path.resolve(HERE, '..', '..', '..', '..', 'packages', 'db-tenant');
const DB_CONTROL_DIR = path.resolve(HERE, '..', '..', '..', '..', 'packages', 'db-control');

/** Defaults for a fresh tenant_settings row (mirrors provisioning.seedDefaults). */
const DEFAULT_TENANT_SETTINGS = {
  id: 1,
  currency: 'EUR',
  loanPeriodDays: 14,
  maxRenewals: 2,
  finePerDayCents: 10,
  fineCapCents: 500,
  holdPickupHours: 48,
  maxActiveLoans: 0,
  defaultLocale: 'el',
};

type Tenant = { id: string; slug: string; dbUrl: string };

type Ctx = {
  redis: RedisService;
  pgSuperuserUrl: string;
  setProgress: (done: number, total: number) => Promise<void>;
};

const oneLine = (s: string) => s.split('\n').slice(0, 4).join(' ').slice(0, 500);

/** `cmlxxxx` → `tenant_cmlxxxx` (same rule as TenantProvisioningService). */
function dbNameFor(tenantId: string): string {
  return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

function listTenants(): Promise<Tenant[]> {
  return controlDb.tenant.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true, slug: true, dbUrl: true },
    orderBy: { slug: 'asc' },
  });
}

async function tenantById(id: string): Promise<Tenant> {
  const t = await controlDb.tenant.findUnique({
    where: { id },
    select: { id: true, slug: true, dbUrl: true },
  });
  if (!t) throw new Error(`Tenant ${id} not found.`);
  return t;
}

// --- entry point -----------------------------------------------------------

export async function processMaintenanceRun(
  runId: string,
  deps: { redis: RedisService },
): Promise<void> {
  const run = await controlDb.maintenanceRun.findUnique({ where: { id: runId } });
  if (!run) return;
  await controlDb.maintenanceRun.update({
    where: { id: runId },
    data: { status: 'running', startedAt: new Date() },
  });
  const ctx: Ctx = {
    redis: deps.redis,
    pgSuperuserUrl: loadEnv().pgSuperuserUrl,
    setProgress: async (done, total) => {
      await controlDb.maintenanceRun.update({
        where: { id: runId },
        data: { progressDone: done, progressTotal: total },
      });
    },
  };
  try {
    let result: object;
    switch (run.kind) {
      case 'diagnostics':
        result = await runDiagnostics(run, ctx);
        break;
      case 'migrate':
        result = await runMigrate(run, ctx);
        break;
      case 'fix':
        result = await runFix(run, ctx);
        break;
      case 'vacuum':
        result = await runVacuum(run, ctx);
        break;
      default:
        result = { results: [] };
    }
    await controlDb.maintenanceRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        resultJson: result as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    await controlDb.maintenanceRun
      .update({
        where: { id: runId },
        data: { status: 'failed', finishedAt: new Date(), error: oneLine((err as Error).message) },
      })
      .catch(() => {});
  }
}

// --- diagnostics ------------------------------------------------------------

async function runDiagnostics(
  run: MaintenanceRun,
  ctx: Ctx,
): Promise<{
  issues: MaintenanceIssue[];
  checked: number;
}> {
  const issues: MaintenanceIssue[] = [];
  const includeControl = run.scope === 'control' || run.scope === 'all';
  const tenants =
    run.scope === 'tenant'
      ? [await tenantById(run.targetTenantId!)]
      : run.scope === 'all'
        ? await listTenants()
        : [];

  const total = (includeControl ? 1 : 0) + tenants.length;
  let done = 0;
  await ctx.setProgress(0, total);

  // Existing tenant_* databases, fetched once so per-tenant checks are cheap.
  const existingDbs = await listTenantDbNames(ctx.pgSuperuserUrl);

  if (includeControl) {
    try {
      await controlDb.$queryRawUnsafe('SELECT 1');
    } catch (e) {
      issues.push({
        severity: 'error',
        target: 'control DB',
        message: `Unreachable: ${oneLine((e as Error).message)}`,
      });
    }
    const st = await migrateStatus(DB_CONTROL_DIR, 'CONTROL_DATABASE_URL', ctx.pgSuperuserUrl);
    if (st.pending) {
      issues.push({
        severity: 'warning',
        target: 'control DB',
        message: 'Has unapplied migrations — run a control-DB migration.',
      });
    } else if (!st.ok) {
      issues.push({
        severity: 'info',
        target: 'control DB',
        message: `Migration status inconclusive: ${st.detail}`,
      });
    }
    // Orphan tenant databases (a DB with no tenant row).
    const expected = new Set(
      (await controlDb.tenant.findMany({ select: { id: true } })).map((t) => dbNameFor(t.id)),
    );
    for (const name of existingDbs) {
      if (!expected.has(name)) {
        issues.push({
          severity: 'warning',
          target: 'control DB',
          message: `Orphan database "${name}" has no tenant row.`,
        });
      }
    }
    await ctx.setProgress(++done, total);
  }

  for (const t of tenants) {
    const target = `tenant: ${t.slug}`;
    if (!existingDbs.has(dbNameFor(t.id))) {
      issues.push({
        severity: 'error',
        target,
        message: `Database is missing — tenant row exists but its DB (${dbNameFor(t.id)}) is gone.`,
      });
      await ctx.setProgress(++done, total);
      continue;
    }
    let reachable = true;
    try {
      const client = makeTenantPrismaClient({ databaseUrl: t.dbUrl });
      try {
        const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
        if (!settings) {
          issues.push({
            severity: 'warning',
            target,
            message: 'Missing tenant_settings row — run a "fix".',
          });
        }
      } finally {
        await disconnectTenantClient(client);
      }
    } catch (e) {
      reachable = false;
      issues.push({
        severity: 'error',
        target,
        message: `Unreachable: ${oneLine((e as Error).message)}`,
      });
    }
    if (reachable) {
      const st = await migrateStatus(DB_TENANT_DIR, 'TENANT_DATABASE_URL', t.dbUrl);
      if (st.pending) {
        issues.push({
          severity: 'warning',
          target,
          message: 'Has unapplied migrations — run a tenant migration.',
        });
      }
    }
    await ctx.setProgress(++done, total);
  }

  return { issues, checked: total };
}

// --- migrate ----------------------------------------------------------------

async function runMigrate(
  run: MaintenanceRun,
  ctx: Ctx,
): Promise<{ results: MaintenanceTargetResult[] }> {
  type Target = { label: string; dir: string; envName: string; url: string };
  const targets: Target[] = [];
  if (run.scope === 'control' || run.scope === 'all') {
    targets.push({
      label: 'control DB',
      dir: DB_CONTROL_DIR,
      envName: 'CONTROL_DATABASE_URL',
      url: ctx.pgSuperuserUrl,
    });
  }
  if (run.scope === 'tenant') {
    const t = await tenantById(run.targetTenantId!);
    targets.push({
      label: `tenant: ${t.slug}`,
      dir: DB_TENANT_DIR,
      envName: 'TENANT_DATABASE_URL',
      url: t.dbUrl,
    });
  } else if (run.scope === 'all') {
    for (const t of await listTenants()) {
      targets.push({
        label: `tenant: ${t.slug}`,
        dir: DB_TENANT_DIR,
        envName: 'TENANT_DATABASE_URL',
        url: t.dbUrl,
      });
    }
  }

  const results: MaintenanceTargetResult[] = [];
  let done = 0;
  await ctx.setProgress(0, targets.length);
  for (const tgt of targets) {
    results.push(await migrateDeploy(tgt));
    await ctx.setProgress(++done, targets.length);
  }
  return { results };
}

async function migrateDeploy(tgt: {
  label: string;
  dir: string;
  envName: string;
  url: string;
}): Promise<MaintenanceTargetResult> {
  try {
    const { stdout, stderr } = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: tgt.dir,
      env: { ...process.env, [tgt.envName]: tgt.url },
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${stdout}\n${stderr}`;
    if (/No pending migrations/i.test(out))
      return { target: tgt.label, ok: true, summary: 'up to date' };
    const applied = (out.match(/└─|have been applied/gi) ?? []).length;
    return {
      target: tgt.label,
      ok: true,
      summary: applied ? `${applied} migration(s) applied` : 'applied',
    };
  } catch (err) {
    return { target: tgt.label, ok: false, summary: oneLine((err as Error).message) };
  }
}

// --- fix --------------------------------------------------------------------

async function runFix(
  run: MaintenanceRun,
  ctx: Ctx,
): Promise<{ results: MaintenanceTargetResult[] }> {
  const results: MaintenanceTargetResult[] = [];

  if (run.scope === 'control') {
    // Rebuild (flush) every cached effective-plan blob.
    const keys = await ctx.redis.client.keys('plan:effective:*');
    if (keys.length) await ctx.redis.client.del(...keys);
    return {
      results: [
        { target: 'control DB', ok: true, summary: `flushed ${keys.length} plan cache(s)` },
      ],
    };
  }

  const tenants =
    run.scope === 'tenant' ? [await tenantById(run.targetTenantId!)] : await listTenants();
  let done = 0;
  await ctx.setProgress(0, tenants.length);
  for (const t of tenants) {
    results.push(await fixTenant(t, ctx));
    await ctx.setProgress(++done, tenants.length);
  }
  return { results };
}

async function fixTenant(t: Tenant, ctx: Ctx): Promise<MaintenanceTargetResult> {
  const fixed: string[] = [];
  try {
    const client = makeTenantPrismaClient({ databaseUrl: t.dbUrl });
    try {
      const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
      if (!settings) {
        await client.tenantSetting.create({ data: DEFAULT_TENANT_SETTINGS });
        fixed.push('seeded tenant_settings');
      }
    } finally {
      await disconnectTenantClient(client);
    }
    await ctx.redis.client.del(`plan:effective:${t.id}`);
    fixed.push('rebuilt plan cache');
    return { target: `tenant: ${t.slug}`, ok: true, summary: fixed.join(', ') };
  } catch (err) {
    return { target: `tenant: ${t.slug}`, ok: false, summary: oneLine((err as Error).message) };
  }
}

// --- vacuum -----------------------------------------------------------------

async function runVacuum(
  run: MaintenanceRun,
  ctx: Ctx,
): Promise<{ results: MaintenanceTargetResult[] }> {
  const targets: Array<{ label: string; url: string }> = [];
  if (run.scope === 'control' || run.scope === 'all') {
    targets.push({ label: 'control DB', url: ctx.pgSuperuserUrl });
  }
  if (run.scope === 'tenant') {
    const t = await tenantById(run.targetTenantId!);
    targets.push({ label: `tenant: ${t.slug}`, url: t.dbUrl });
  } else if (run.scope === 'all') {
    for (const t of await listTenants()) targets.push({ label: `tenant: ${t.slug}`, url: t.dbUrl });
  }

  const results: MaintenanceTargetResult[] = [];
  let done = 0;
  await ctx.setProgress(0, targets.length);
  for (const tgt of targets) {
    results.push(await vacuumOne(tgt));
    await ctx.setProgress(++done, targets.length);
  }
  return { results };
}

async function vacuumOne(tgt: { label: string; url: string }): Promise<MaintenanceTargetResult> {
  const client = new PgClient({ connectionString: tgt.url });
  try {
    await client.connect();
    await client.query('VACUUM (ANALYZE)');
    return { target: tgt.label, ok: true, summary: 'VACUUM ANALYZE done' };
  } catch (err) {
    return { target: tgt.label, ok: false, summary: oneLine((err as Error).message) };
  } finally {
    await client.end().catch(() => {});
  }
}

// --- shared pg helpers ------------------------------------------------------

/** All `tenant_*` database names that currently exist on the server. */
async function listTenantDbNames(superuserUrl: string): Promise<Set<string>> {
  const admin = new PgClient({ connectionString: superuserUrl });
  await admin.connect();
  try {
    const res = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'tenant_%'`,
    );
    return new Set(res.rows.map((r) => r.datname));
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * `prisma migrate status` exits non-zero when migrations are pending, so we
 * parse stdout/stderr off both the success and the thrown-error paths.
 */
async function migrateStatus(
  dir: string,
  envName: string,
  url: string,
): Promise<{ ok: boolean; pending: boolean; detail: string }> {
  const PENDING_RE = /not yet been applied/i;
  try {
    const { stdout, stderr } = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: dir,
      env: { ...process.env, [envName]: url },
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${stdout}\n${stderr}`;
    return { ok: true, pending: PENDING_RE.test(out), detail: 'checked' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
    if (PENDING_RE.test(out)) return { ok: true, pending: true, detail: 'pending' };
    return { ok: false, pending: false, detail: oneLine(out) };
  }
}
