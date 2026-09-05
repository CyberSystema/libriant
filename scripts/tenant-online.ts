/**
 * Libriant — run the online migration track across tenants.
 *
 * Online scripts live in `packages/db-tenant/prisma/online/*.sql` and do the
 * work `prisma migrate deploy` structurally cannot: index builds that must not
 * hold a write lock, and backfills too large for one transaction. See
 * `scripts/_lib/online-track.ts` for the format and for why the ledger exists.
 *
 * A tenant with an unfinished online script is a BARRIER: `pnpm tenant:migrate`
 * refuses to apply further migrations to it, because half a backfill plus the
 * next migration is a state nothing reports. This command is what clears it.
 *
 *   USAGE:
 *     pnpm tenant:online                       # every pending script, all tenants
 *     pnpm tenant:online --plan                # read-only: what would run where
 *     pnpm tenant:online --only=acme           # one tenant
 *     pnpm tenant:online --script=0001_backfill_x
 *     pnpm tenant:online --include-archived
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient } from '@libriant/db-tenant';
import { die, isYes, log, parseArgs } from './_lib/cli.js';
import { parseOnlineScript, runOnlineScript, type OnlineScript } from './_lib/online-track.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONLINE_DIR = path.resolve(HERE, '..', 'packages', 'db-tenant', 'prisma', 'online');
const SCRIPT = 'tenant-online';

const args = parseArgs({
  name: SCRIPT,
  description: 'Run resumable, non-transactional migrations across tenants.',
  options: {
    only: { type: 'string' },
    script: { type: 'string' },
    plan: { type: 'boolean' },
    'include-archived': { type: 'boolean' },
  },
});

function loadScripts(filter: string | null): OnlineScript[] {
  let files: string[];
  try {
    files = readdirSync(ONLINE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return [];
  }
  return files
    .map((f) => f.replace(/\.sql$/, ''))
    .filter((name) => !filter || name === filter)
    .map((name) =>
      parseOnlineScript(name, readFileSync(path.join(ONLINE_DIR, `${name}.sql`), 'utf8')),
    );
}

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const planOnly = isYes(v.plan);
  const includeArchived = isYes(v['include-archived']);
  const filter = v.script ? String(v.script) : null;
  const only = v.only
    ? String(v.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const scripts = loadScripts(filter);
  if (scripts.length === 0) {
    log(SCRIPT, filter ? `no online script named "${filter}"` : 'no online scripts to run.');
    await controlDb.$disconnect();
    return;
  }
  log(
    SCRIPT,
    `${scripts.length} script(s): ${scripts.map((s) => `${s.name} (${s.steps.length} steps)`).join(', ')}`,
  );

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.status = { not: 'archived' };
  if (only && only.length) where.slug = { in: only };
  const tenants = await controlDb.tenant.findMany({
    where,
    select: { id: true, slug: true, dbUrl: true },
    orderBy: { slug: 'asc' },
  });
  if (only) {
    const missing = only.filter((s) => !tenants.find((t) => t.slug === s));
    if (missing.length) die(SCRIPT, `unknown tenant slug(s): ${missing.join(', ')}`);
  }

  let failures = 0;
  for (const t of tenants) {
    const db = makeTenantPrismaClient({ databaseUrl: t.dbUrl, maxPoolSize: 1 });
    try {
      for (const script of scripts) {
        if (planOnly) {
          const rows = await db.$queryRawUnsafe<
            { finishedAt: Date | null; cursor: string | null; attempts: number }[]
          >(
            `SELECT "finishedAt", "cursor", "attempts" FROM "_libriant_online_migrations" WHERE "name" = $1`,
            script.name,
          );
          const r = rows[0];
          const state = !r
            ? 'not started'
            : r.finishedAt
              ? 'complete'
              : `resumable after step "${r.cursor ?? '(none)'}", ${r.attempts} attempt(s)`;
          log(SCRIPT, `  ${t.slug.padEnd(20)} ${script.name.padEnd(34)} ${state}`);
          continue;
        }

        const result = await runOnlineScript(db, script, {
          onProgress: (p) => {
            if (p.pass === 1 || p.pass % 25 === 0) {
              log(
                SCRIPT,
                `    ${t.slug}/${script.name}: ${p.step} pass ${p.pass}, ${p.rows} row(s)`,
              );
            }
          },
        });
        log(
          SCRIPT,
          `  ${t.slug.padEnd(20)} ${script.name.padEnd(34)} ` +
            (result.alreadyComplete
              ? 'already complete'
              : `${result.stepsRun} step(s) run, ${result.stepsSkipped} resumed past, ` +
                `${result.rowsAffected} row(s)`),
        );
      }
    } catch (err) {
      failures += 1;
      log(SCRIPT, `  ${t.slug.padEnd(20)} ✗ ${String((err as Error).message).split('\n')[0]}`);
      log(SCRIPT, `    the ledger kept its place; re-running this command continues from there.`);
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  }

  await controlDb.$disconnect();
  if (failures > 0) process.exit(2);
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
