/**
 * Libriant — fleet / capacity report.
 *
 * Prints the tenant census (ALL libraries, by status / plan / cell — not just
 * active), per-tenant DB + storage sizes, and host capacity signals (Postgres
 * connections vs. max, cache hit ratio, Redis memory, disk on the storage
 * volume). Read-only.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL  (required — control-plane DB)
 *     REDIS_URL             (optional — Redis memory stats)
 *     STORAGE_ROOT          (optional — disk usage on the storage volume)
 *
 *   USAGE:
 *     pnpm tsx scripts/fleet-report.ts            # human-readable
 *     pnpm tsx scripts/fleet-report.ts --json     # machine-readable
 *
 *   On a server (via the deployment guide's `ops` helper):
 *     ops "pnpm tsx scripts/fleet-report.ts"
 *
 *   As a daily cron snapshot:
 *     0 7 * * * ... pnpm tsx scripts/fleet-report.ts >> /var/log/libriant/fleet.log 2>&1
 */
import { statfs } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { controlDb, disconnectControlDb } from '@libriant/db-control';
import { dbNameForTenant } from './_lib/cli.js';

const asJson = process.argv.includes('--json');

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[i]}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  // --- tenant census ---
  const tenants = await controlDb.tenant.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      cellId: true,
      storageUsedBytes: true,
      createdAt: true,
      cell: { select: { slug: true } },
      subscription: { select: { plan: { select: { slug: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // --- DB sizes (control + every tenant_*) ---
  const sizeRows = await controlDb.$queryRaw<Array<{ datname: string; bytes: number }>>`
    SELECT datname, pg_database_size(datname)::float8 AS bytes
    FROM pg_database
    WHERE datname = 'libriant_control' OR datname LIKE 'tenant_%'`;
  const dbBytesByName = new Map(sizeRows.map((r) => [r.datname, Number(r.bytes)]));

  // --- connections + cache hit ratio ---
  const connRows = await controlDb.$queryRaw<Array<{ total: number; max_conn: number }>>`
    SELECT
      (SELECT count(*)::int FROM pg_stat_activity) AS total,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn`;
  const conns = { total: Number(connRows[0]?.total ?? 0), max: Number(connRows[0]?.max_conn ?? 0) };

  const cacheRows = await controlDb.$queryRaw<Array<{ ratio: number | null }>>`
    SELECT (sum(blks_hit)::float8 / NULLIF(sum(blks_hit) + sum(blks_read), 0)) AS ratio
    FROM pg_stat_database`;
  const cacheHitRatio = cacheRows[0]?.ratio == null ? null : Number(cacheRows[0].ratio);

  // --- redis (best-effort) ---
  let redisStats: { usedMemoryBytes: number; keys: number } | null = null;
  if (process.env.REDIS_URL) {
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      const info = await redis.info('memory');
      const m = /used_memory:(\d+)/.exec(info);
      redisStats = { usedMemoryBytes: m ? Number(m[1]) : 0, keys: Number(await redis.dbsize()) };
    } catch {
      redisStats = null;
    } finally {
      redis.disconnect();
    }
  }

  // --- disk on the storage volume (best-effort) ---
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  if (process.env.STORAGE_ROOT) {
    try {
      const s = await statfs(process.env.STORAGE_ROOT);
      disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      disk = null;
    }
  }

  // --- aggregate ---
  const rows = tenants.map((t) => ({
    slug: t.slug,
    name: t.name,
    status: t.status as string,
    plan: t.subscription?.plan?.slug ?? 'none',
    cell: t.cell?.slug ?? t.cellId,
    storageBytes: Number(t.storageUsedBytes),
    dbBytes: dbBytesByName.get(dbNameForTenant(t.id)) ?? 0,
  }));
  const tally = (key: 'status' | 'plan' | 'cell') =>
    rows.reduce<Record<string, number>>(
      (acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc),
      {},
    );
  const sum = (k: 'storageBytes' | 'dbBytes') => rows.reduce((a, r) => a + r[k], 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          total: rows.length,
          byStatus: tally('status'),
          byPlan: tally('plan'),
          byCell: tally('cell'),
          storageBytes: sum('storageBytes'),
          tenantDbBytes: sum('dbBytes'),
          controlDbBytes: dbBytesByName.get('libriant_control') ?? 0,
          connections: conns,
          cacheHitRatio,
          redis: redisStats,
          disk,
          tenants: rows.sort((a, b) => b.dbBytes + b.storageBytes - (a.dbBytes + a.storageBytes)),
        },
        null,
        2,
      ),
    );
    return;
  }

  const line = (label: string, value: string) => console.log(`  ${pad(label, 22)}${value}`);
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || '—';

  console.log(`\nLIBRIANT FLEET REPORT  —  ${new Date().toISOString()}`);
  console.log('='.repeat(64));
  line('Libraries (total)', String(rows.length));
  line('  by status', kv(tally('status')));
  line('  by plan', kv(tally('plan')));
  line('  by cell', kv(tally('cell')));
  console.log('');
  line('Control DB', fmtBytes(dbBytesByName.get('libriant_control') ?? 0));
  line('Tenant DBs total', `${fmtBytes(sum('dbBytes'))} across ${rows.length}`);
  line('Storage (tracked)', fmtBytes(sum('storageBytes')));
  const connPct = conns.max ? `(${Math.round((conns.total / conns.max) * 100)}%)` : '';
  line('PG connections', `${conns.total} / ${conns.max} ${connPct}`);
  line(
    'PG cache hit ratio',
    cacheHitRatio == null ? 'n/a' : `${(cacheHitRatio * 100).toFixed(2)}%`,
  );
  if (redisStats)
    line('Redis', `${fmtBytes(redisStats.usedMemoryBytes)} used, ${redisStats.keys} keys`);
  if (disk) {
    const usedPct = Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100);
    line(
      'Disk (storage vol)',
      `${fmtBytes(disk.totalBytes - disk.freeBytes)} / ${fmtBytes(disk.totalBytes)} (${usedPct}%)`,
    );
  }

  console.log('\nTop libraries by total size:');
  console.log(
    `  ${pad('slug', 22)}${pad('status', 11)}${pad('plan', 12)}${pad('db', 10)}${pad('storage', 10)}total`,
  );
  for (const r of rows
    .slice()
    .sort((a, b) => b.dbBytes + b.storageBytes - (a.dbBytes + a.storageBytes))
    .slice(0, 15)) {
    console.log(
      `  ${pad(r.slug, 22)}${pad(r.status, 11)}${pad(r.plan, 12)}${pad(fmtBytes(r.dbBytes), 10)}${pad(fmtBytes(r.storageBytes), 10)}${fmtBytes(r.dbBytes + r.storageBytes)}`,
    );
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('[fleet-report] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectControlDb());
