#!/usr/bin/env tsx
/**
 * Which databases are on a UTC session, and which carry the damage.
 *
 *   pnpm tsx scripts/tenant-timezone-audit.ts                # report, read-only
 *   pnpm tsx scripts/tenant-timezone-audit.ts --all-databases # every tenant_* on the server
 *   pnpm tsx scripts/tenant-timezone-audit.ts --pin           # apply the pin
 *
 *   ENV (required):
 *     PG_SUPERUSER_URL       — superuser URL; ALTER DATABASE needs ownership
 *   ENV (optional):
 *     CONTROL_DATABASE_URL   — read the tenant list from the control plane
 *                              instead of from pg_database
 *
 * ## WHAT THIS REPAIRS, AND WHAT IT REFUSES TO
 *
 * `@prisma/adapter-pg` requires a UTC session and does not say so.
 * `packages/shared/src/postgres-session.ts` carries the measurement. On a
 * non-UTC session it stores every instant wrong by the offset AT THAT INSTANT,
 * and once a year — the spring-forward hour — it silently moves the value.
 *
 * There are three kinds of damage and only two are repairable:
 *
 *   THE SESSION      a database with no `TimeZone` in `pg_db_role_setting`.
 *                    `--pin` fixes it, idempotently. This is the repair.
 *   THE PARTITIONS   `audit_log` bounds created by a non-UTC session sit on
 *                    LOCAL midnight. Reported, never rewritten: recreating a
 *                    partition means moving its rows, and the safe version of
 *                    that is a re-provision, not a script that rewrites a
 *                    library's audit trail at 03:00.
 *   THE ROW VALUES   NOT REPAIRABLE, and this script does not pretend.
 *
 * ## WHY THERE IS NO ROW-VALUE REPAIR
 *
 * The instruction that created this script asked for one. It cannot be written
 * honestly, and the reasons are worth stating rather than discovering later:
 *
 *   1. NO WITNESS. To correct a row you must know it was written in the shifted
 *      frame. Almost everything in `lbr2` is Prisma-written, so almost nothing
 *      has an unshifted sibling to be compared against. The one column filled by
 *      a non-Prisma writer is `change_events.occurred_at` (the changelog
 *      trigger), which covers a fraction of the rows and only while `xmin` is
 *      unfrozen — `track_commit_timestamp` is off, so a vacuum erases the
 *      evidence.
 *   2. THE SHIFT IS PER-ROW. It is the session offset at that row's own nominal
 *      instant: two hours for a winter row and three for a summer one in
 *      Athens. A blanket `- INTERVAL '3 hours'` is wrong for half the table.
 *   3. IT IS NOT INVERTIBLE. In the spring-forward hour the naive local time did
 *      not exist and Postgres moved it, so two different inputs produced the
 *      same stored value; in the autumn overlap one stored value has two
 *      pre-images. No arithmetic recovers those.
 *   4. THE FRAMES ARE MIXED IN ONE COLUMN. A table written partly by Prisma and
 *      partly by a trigger or by hand has rows in both frames with nothing to
 *      tell them apart.
 *
 * So the honest answer is: pin, report, and RE-PROVISION anything that already
 * holds rows. There are no libraries in production, so today that costs nothing;
 * every day it is deferred, it costs more. That trade is the whole reason this
 * script reports loudly rather than repairing quietly.
 */
import { Client } from 'pg';
import {
  PG_SESSION_OPTIONS,
  PG_SESSION_TIMEZONE,
  pinDatabaseTimezoneSql,
} from '@libriant/shared/postgres-session';

const args = process.argv.slice(2);
const APPLY = args.includes('--pin');
const ALL = args.includes('--all-databases');

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

const urlFor = (db: string) => {
  const u = new URL(reqEnv('PG_SUPERUSER_URL'));
  u.pathname = `/${db}`;
  return u.toString();
};

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  // The audit's OWN connections carry the option, because the partition-bound
  // question is only answerable on a UTC session: Postgres renders a bound in
  // the session's zone, so on an Athens session this very query falsely accuses
  // a date-keyed table and falsely clears a timestamptz one.
  const c = new Client({ connectionString: url, options: PG_SESSION_OPTIONS });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

type Verdict = {
  readonly db: string;
  /** The database's own default, read WITHOUT the option so it is the truth. */
  readonly defaultTimezone: string | null;
  readonly badPartitions: readonly string[];
  readonly lbr2Rows: number | null;
};

async function inspect(db: string): Promise<Verdict> {
  const defaultTimezone = await withClient(reqEnv('PG_SUPERUSER_URL'), async (c) => {
    const r = await c.query<{ setconfig: string[] | null }>(
      `SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
         JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = $1 AND s.setrole = 0`,
      [db],
    );
    const entry = (r.rows[0]?.setconfig ?? []).find((x) => x.startsWith('TimeZone='));
    return entry ? entry.slice('TimeZone='.length) : null;
  });

  return withClient(urlFor(db), async (c) => {
    const hasLbr2 = await c.query(`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'lbr2'`);
    if (hasLbr2.rowCount === 0) {
      return { db, defaultTimezone, badPartitions: [], lbr2Rows: null };
    }

    // Every partition of every TIMESTAMPTZ-keyed partitioned table. Date-keyed
    // parents are excluded by KEY TYPE rather than by pattern: their bounds
    // carry no zone and are immune, and handing them a zoned literal would
    // introduce the defect where none exists.
    const parts = await c.query<{ parent: string; part: string; bound: string }>(
      `SELECT p.relname AS parent, ch.relname AS part,
              pg_catalog.pg_get_expr(ch.relpartbound, ch.oid) AS bound
         FROM pg_catalog.pg_inherits i
         JOIN pg_catalog.pg_class ch ON ch.oid = i.inhrelid
         JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
         JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
         JOIN pg_catalog.pg_partitioned_table pt ON pt.partrelid = p.oid
         JOIN pg_catalog.pg_attribute a ON a.attrelid = p.oid AND a.attnum = pt.partattrs[0]
        WHERE n.nspname = 'lbr2' AND ch.relkind = 'r'
          AND a.atttypid = 'timestamptz'::regtype`,
    );
    // "Midnight UTC", not "ends in +00": on this UTC session Postgres renders
    // EVERY bound with `+00`, including one created in Athens, which comes back
    // as `'2026-08-31 21:00:00+00'`. Suffix-matching passes exactly the rows
    // this exists to catch.
    const midnightUtc = /'\d{4}-\d{2}-\d{2} 00:00:00\+00'/g;
    const badPartitions = parts.rows
      .filter((r) => {
        const literals = r.bound.match(/'[^']*'/g) ?? [];
        const midnights = r.bound.match(midnightUtc) ?? [];
        return literals.length === 0 || midnights.length !== literals.length;
      })
      .map((r) => `${r.parent}.${r.part}`);

    // "Does this database hold anything yet?" — the question that decides
    // whether pinning it is safe or whether it needs re-provisioning. Three
    // tables that a library cannot be used without.
    let lbr2Rows = 0;
    for (const t of ['audit_log', 'change_events', 'loans']) {
      const exists = await c.query(
        `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='lbr2' AND c.relname=$1`,
        [t],
      );
      if (exists.rowCount === 0) continue;
      const n = await c.query<{ n: string }>(
        `SELECT pg_catalog.count(*)::text AS n FROM lbr2.${t}`,
      );
      lbr2Rows += Number(n.rows[0]?.n ?? 0);
    }
    return { db, defaultTimezone, badPartitions, lbr2Rows };
  });
}

async function databases(): Promise<string[]> {
  if (!ALL && process.env.CONTROL_DATABASE_URL) {
    return withClient(reqEnv('CONTROL_DATABASE_URL'), async (c) => {
      // `tenants`, snake_case, with a camelCase `dbUrl` column — the 1.0
      // control-plane convention. Written as `"Tenant"` first and never
      // exercised, because every run used --all-databases; the table does not
      // exist under that name and the path threw on its first real use.
      const r = await c.query<{ dbUrl: string }>(
        `SELECT "dbUrl" FROM tenants WHERE status = 'active' ORDER BY slug`,
      );
      return r.rows
        .map((row) => {
          try {
            return new URL(row.dbUrl).pathname.replace(/^\//, '');
          } catch {
            return '';
          }
        })
        .filter(Boolean);
    });
  }
  return withClient(reqEnv('PG_SUPERUSER_URL'), async (c) =>
    (
      await c.query<{ datname: string }>(
        `SELECT datname FROM pg_catalog.pg_database
          WHERE datname LIKE 'tenant\\_%' OR datname IN ('libriant_control','libriant_demo')
          ORDER BY datname`,
      )
    ).rows.map((r) => r.datname),
  );
}

/**
 * Wrapped in a function because tsx loads a script in this repo as CJS, where
 * top-level `await` does not compile — the same constraint
 * `scripts/check-schema-drift.ts` records.
 */
async function main(): Promise<void> {
  const dbs = await databases();
  console.log(
    `Auditing ${dbs.length} database(s) for the UTC session precondition` +
      `${APPLY ? ' (--pin: the pin WILL be applied)' : ' (read-only)'}\n`,
  );

  let unpinned = 0;
  let skewed = 0;
  let pinned = 0;
  let blocked = 0;

  for (const db of dbs) {
    let v: Verdict;
    try {
      v = await inspect(db);
    } catch (err) {
      console.log(`  ?  ${db.padEnd(44)} could not inspect: ${(err as Error).message}`);
      continue;
    }

    const tz = v.defaultTimezone ?? '(none — inherits the cluster)';
    const parts = v.badPartitions.length;
    if (parts > 0) skewed += 1;
    if (v.defaultTimezone !== PG_SESSION_TIMEZONE) unpinned += 1;

    const state =
      v.defaultTimezone === PG_SESSION_TIMEZONE && parts === 0
        ? 'ok'
        : parts > 0
          ? 'SKEWED'
          : 'unpinned';
    console.log(
      `  ${state.padEnd(8)} ${db.padEnd(44)} TimeZone=${tz}` +
        (parts > 0 ? `  ${parts} partition(s) on local midnight` : '') +
        (v.lbr2Rows === null ? '  (no lbr2 schema)' : `  ${v.lbr2Rows} row(s)`),
    );
    if (parts > 0 && parts <= 3) {
      for (const p of v.badPartitions) console.log(`             ${p}`);
    }

    if (!APPLY || v.defaultTimezone === PG_SESSION_TIMEZONE) continue;

    // THE REFUSAL. Pinning is what SURFACES the shift — every stored instant
    // starts reading three hours away from what it read yesterday — and it is what
    // opens the partition seam, because the maintenance job then creates
    // UTC-bounded partitions beside local-midnight ones with a hole between them.
    // A populated, skewed database must be re-provisioned, not quietly pinned.
    if (parts > 0 && (v.lbr2Rows ?? 0) > 0) {
      blocked += 1;
      console.log(
        `             REFUSING to pin: this database holds ${v.lbr2Rows} row(s) AND has ` +
          `${parts} partition(s) on local midnight.\n` +
          '             Pinning it would change what every stored instant reads and leave a hole ' +
          'in the partition window.\n' +
          `             Re-provision it instead:  dropdb ${db} && pnpm tenant:create …`,
      );
      continue;
    }
    await withClient(reqEnv('PG_SUPERUSER_URL'), async (c) => c.query(pinDatabaseTimezoneSql(db)));
    pinned += 1;
    console.log('             pinned to UTC');
  }

  console.log(
    `\n${dbs.length} database(s): ${unpinned} without a UTC pin, ${skewed} with partitions on ` +
      `local midnight` +
      (APPLY ? `, ${pinned} pinned now, ${blocked} refused (populated and skewed)` : '') +
      '.',
  );
  if (!APPLY && unpinned > 0) {
    console.log('Re-run with --pin to apply. Row VALUES are never rewritten — see the docblock.');
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ tenant timezone audit failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
