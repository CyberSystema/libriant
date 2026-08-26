/**
 * Libriant — fan-out tenant migrations.
 *
 * Iterates every tenant row in the control plane, runs `prisma migrate
 * deploy` against each tenant's `db_url`, and prints a per-row summary.
 * Failures on individual tenants don't stop the batch — we collect them
 * and exit non-zero at the end so CI/cron catches the regression while
 * still migrating as many as possible.
 *
 * Output looks like:
 *
 *   [tenant-migrate] acme         ✓ 0 pending → up to date
 *   [tenant-migrate] step18a      ✓ 1 applied   20260601120000_add_x
 *   [tenant-migrate] members-test ✗ failed (P3009 — see log above)
 *
 *   ENV:
 *     CONTROL_DATABASE_URL    — control-plane DB
 *
 *   USAGE:
 *     pnpm tenant:migrate                              # all active tenants
 *     pnpm tenant:migrate --only=acme,step18a      # specific slugs
 *     pnpm tenant:migrate --include-archived       # archived too
 *     pnpm tenant:migrate --dry-run                # list, don't migrate
 *     pnpm tenant:migrate --concurrency=4          # parallel jobs (default 1)
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { controlDb } from '@libriant/db-control';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TENANT_DIR = path.resolve(HERE, '..', 'packages', 'db-tenant');

const SCRIPT = 'tenant-migrate';

const args = parseArgs({
  name: SCRIPT,
  description: 'Apply tenant migrations to every tenant.',
  options: {
    only: { type: 'string' },
    'include-archived': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    concurrency: { type: 'string' },
  },
});

type Tenant = { id: string; slug: string; dbUrl: string; status: string };
type Outcome =
  | { slug: string; ok: true; applied: number; pending: number; summary: string }
  | { slug: string; ok: false; error: string };

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const dryRun = isYes(v['dry-run']);
  const includeArchived = isYes(v['include-archived']);
  const concurrency = Math.max(1, Math.min(16, Number(v.concurrency ?? '1')));
  const only = v.only
    ? String(v.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.status = { not: 'archived' };
  if (only && only.length) where.slug = { in: only };

  const tenants: Tenant[] = await controlDb.tenant.findMany({
    where,
    select: { id: true, slug: true, dbUrl: true, status: true },
    orderBy: { slug: 'asc' },
  });

  if (only) {
    const missing = only.filter((s) => !tenants.find((t) => t.slug === s));
    if (missing.length) die(SCRIPT, `unknown tenant slug(s): ${missing.join(', ')}`);
  }

  log(
    SCRIPT,
    `${tenants.length} tenant(s) to process (concurrency=${concurrency}, dryRun=${dryRun})`,
  );

  if (dryRun) {
    for (const t of tenants) log(SCRIPT, `  ${t.slug} (${t.status})`);
    await controlDb.$disconnect();
    return;
  }

  const outcomes: Outcome[] = [];
  const queue = [...tenants];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const t = queue.shift();
      if (!t) return;
      outcomes.push(await migrateOne(t));
    }
  });
  await Promise.all(workers);

  await controlDb.$disconnect();

  // Stable ordering for the summary
  outcomes.sort((a, b) => a.slug.localeCompare(b.slug));
  log(SCRIPT, '---');
  let okCount = 0;
  let failCount = 0;
  for (const o of outcomes) {
    if (o.ok) {
      okCount++;
      log(SCRIPT, `  ${o.slug.padEnd(20)} ✓ ${o.summary}`);
    } else {
      failCount++;
      log(SCRIPT, `  ${o.slug.padEnd(20)} ✗ ${o.error}`);
    }
  }
  log(SCRIPT, `done. ${okCount} ok, ${failCount} failed.`);
  if (failCount > 0) process.exit(2);
}

async function migrateOne(t: Tenant): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DB_TENANT_DIR,
      env: { ...process.env, TENANT_DATABASE_URL: t.dbUrl },
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${stdout}\n${stderr}`;
    // Parse Prisma's summary line. Two shapes commonly seen:
    //   "No pending migrations to apply."
    //   "The following migration(s) have been applied:\n  └─ ..."
    if (/No pending migrations/.test(out)) {
      return { slug: t.slug, ok: true, applied: 0, pending: 0, summary: 'up to date' };
    }
    const applied = (out.match(/└─\s*\d+/g) ?? []).length;
    return {
      slug: t.slug,
      ok: true,
      applied,
      pending: 0,
      summary: `${applied} applied`,
    };
  } catch (err) {
    const msg = (err as Error).message.split('\n').slice(0, 3).join(' ');
    return { slug: t.slug, ok: false, error: msg };
  }
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
