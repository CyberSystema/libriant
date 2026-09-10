import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Roll the monthly partition window forward, before it runs out.
 *
 * ## The baseline named this job, and this phase, by name
 *
 * `20260907120000_baseline_2_0/migration.sql`, on `audit_log`:
 *
 *   "No DEFAULT partition, deliberately. A missing future partition makes the
 *    INSERT fail with 23514, which is loud and fixable; a DEFAULT partition
 *    silently swallows those rows into a heap that can never be partitioned
 *    afterwards without rewriting it. PHASE 16 OWNS THE JOB THAT ROLLS THE
 *    WINDOW FORWARD, and its alert is what stops the loud failure ever
 *    happening."
 *
 * So the loudness is the design and this job is the thing that means nobody ever
 * hears it. The window is created 24 months ahead AT PROVISIONING, which sounds
 * generous and is a deadline: a library provisioned today stops being able to
 * write an audit row in two years, on a Tuesday, in the middle of a checkout.
 *
 * ## A REGISTRY, not two hand-written loops
 *
 * `audit_log` was the first partitioned table, `circulation_statistics` is the
 * second, and §6 phase 26 adds `analytics.fact_circulation (partitioned
 * monthly)` as the third. Two copies of this loop would already be one too many;
 * three would guarantee that one of them gets a fix the others do not.
 *
 * ## The metric is HEADROOM, not a run counter
 *
 * The failure being prevented is a future INSERT raising `23514`, so an alert
 * has to fire BEFORE the window closes, not after. A "did the job run" counter
 * says nothing until the day it is already too late; months-of-headroom says
 * "this library has four months left" while there is still time to do something
 * about it. `check:alerts` requires both directions — a declared metric with no
 * rule, and a rule with no metric, both fail the build — so the two land in the
 * same commit.
 *
 * ## Idempotent, and it has to be
 *
 * `CREATE TABLE … PARTITION OF … IF NOT EXISTS` per month, so a tick that
 * overlaps a previous one (the runner retries a failed tick) adds nothing and
 * throws nothing. That is the registry's own rule: "every job here is an
 * idempotent sweep; a handler that is not re-runnable does not belong in it".
 */
const logger = new Logger('PartitionMaintenance');

export const PARTITION_MAINTENANCE_JOB = 'partition-maintenance';
export const PARTITION_MAINTENANCE_COUNTS = {
  created: 'created',
  minHeadroomMonths: 'minHeadroomMonths',
} as const;

/**
 * How far ahead the window is kept.
 *
 * The baseline creates 24 months at provisioning; this keeps it there, so the
 * horizon moves with the calendar instead of expiring. Twelve would be enough
 * and twenty-four is what the baseline chose, and matching it means an operator
 * comparing a fresh tenant with an old one sees the same shape.
 */
const MONTHS_AHEAD = 24;

/**
 * The partitioned tables, and the column each is ranged on.
 *
 * Adding one is a line here. §6 phase 26's `analytics.fact_circulation` is the
 * next, and it lives in a different Postgres SCHEMA, which is why the schema is
 * a field rather than assumed to be `lbr2`.
 */
type PartitionTarget = {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  /**
   * THE TYPE OF THE PARTITION KEY, and the two values are not interchangeable.
   *
   * A bare bound literal — `FOR VALUES FROM ('2026-10-01')` — is resolved
   * against the key's type in the CREATING SESSION's timezone. For a
   * `timestamptz` key that makes the boundary local midnight, so two sessions in
   * two zones produce two different instants from the same string. MEASURED, and
   * it is not theoretical: `prisma migrate deploy` creates the first 27
   * partitions and this job creates the rest, and once the application pins its
   * own sessions to UTC while the CLI inherits the server default, the two
   * disagree at the seam:
   *
   *     audit_log_2026_09  [2026-08-31 21:00+00, 2026-09-30 21:00+00)   Athens
   *     audit_log_2026_10  [2026-10-01 00:00+00, 2026-11-01 00:00+00)   UTC
   *
   * A three-hour hole, which Postgres accepts silently at DDL time and which
   * `audit_log` — with no DEFAULT partition, deliberately — turns into a hard
   * `23514` on every audited write for those three hours.
   *
   * So a `timestamptz` key gets an EXPLICIT `+00`. A `date` key must NOT: its
   * bounds carry no zone at all (`FROM ('2026-06-01')`) and are already immune,
   * and handing it a timestamptz literal would cast the value back through the
   * session zone and introduce the defect where none exists.
   */
  readonly bound: 'timestamptz' | 'date';
};

const PARTITIONED: readonly PartitionTarget[] = [
  { schema: 'lbr2', table: 'audit_log', column: 'occurred_at', bound: 'timestamptz' },
  {
    schema: 'lbr2',
    table: 'circulation_statistics',
    column: 'period_start',
    bound: 'date',
  },
];

export async function maintainPartitions(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let created = 0;
  let failed = 0;
  // Infinity until a real table reports, so a fleet with no tenants does not
  // publish "zero months of headroom" and page.
  let minHeadroom = Number.POSITIVE_INFINITY;

  try {
    for (const t of tenants) {
      // Built INSIDE the per-tenant try: `tenantContextFrom` throws for a tenant
      // with no sealed credential, and a throw out here would end the sweep for
      // every OTHER library at the first one.
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        const client = tenantPrisma.getClientV2(ctx);
        for (const target of PARTITIONED) {
          const result = await ensureWindow(client, target);
          created += result.created;
          if (result.headroomMonths < minHeadroom) minHeadroom = result.headroomMonths;
          if (result.created > 0) {
            logger.log(
              `tenant=${t.slug} ${target.schema}.${target.table}: created ${result.created} ` +
                `partition(s); ${result.headroomMonths} month(s) of headroom`,
            );
          }
        }
      } catch (err) {
        failed++;
        logger.warn(`partition maintenance failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  const headroom = Number.isFinite(minHeadroom) ? minHeadroom : MONTHS_AHEAD;
  return {
    message:
      created === 0
        ? `${tenants.length} tenant(s) × ${PARTITIONED.length} partitioned table(s); the window ` +
          `already reaches ${headroom} month(s) ahead`
        : `created ${created} partition(s); the tightest window now reaches ${headroom} month(s) ahead`,
    counts: {
      [PARTITION_MAINTENANCE_COUNTS.created]: created,
      [PARTITION_MAINTENANCE_COUNTS.minHeadroomMonths]: headroom,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}

type RawClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

/**
 * Make sure every month from this one to `MONTHS_AHEAD` has a partition.
 *
 * `$executeRawUnsafe` because a partition name is an IDENTIFIER and cannot be a
 * bind parameter — `CREATE TABLE $1` is a syntax error. The names are built from
 * `PARTITIONED`, which is a constant in this file, and from a date this function
 * computed; nothing user-supplied reaches the string. That is the same
 * discipline the baseline's `DO $partitions$` block uses, and it is why the
 * schema and table are a fixed list rather than an argument.
 */
async function ensureWindow(
  client: RawClient,
  target: PartitionTarget,
): Promise<{ created: number; headroomMonths: number }> {
  await assertBoundsAreUtc(client, target);
  const before = await countFrom(client, target, monthName(target.table, 0));

  for (let i = 0; i <= MONTHS_AHEAD; i += 1) {
    await client.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${quote(target.schema)}.${quote(monthName(target.table, i))} ` +
        `PARTITION OF ${quote(target.schema)}.${quote(target.table)} ` +
        `FOR VALUES FROM (${bound(target, i)}) TO (${bound(target, i + 1)})`,
    );
  }

  const after = await countFrom(client, target, monthName(target.table, 0));
  // `after - 1`: the current month is not headroom, it is today.
  return { created: Math.max(0, after - before), headroomMonths: Math.max(0, after - 1) };
}

/**
 * One partition bound, in the form its key type actually needs.
 *
 * See {@link PartitionTarget.bound}. `monthStart` already computes a UTC civil
 * month start, so for a `timestamptz` key all this adds is the zone the literal
 * was always meant to carry — and without which the session supplies one.
 */
function bound(target: PartitionTarget, offset: number): string {
  return target.bound === 'timestamptz'
    ? `TIMESTAMPTZ '${monthStart(offset)} 00:00:00+00'`
    : `'${monthStart(offset)}'`;
}

/**
 * Refuse a table whose existing bounds are not on a UTC day boundary.
 *
 * THE HALF THAT MAKES THE EXPLICIT BOUND SAFE. Emitting `+00` on its own is the
 * one actively dangerous change available here: it aligns what this job creates
 * from now on and says nothing about what is already there, so a database
 * provisioned on a non-UTC session gets a silent three-hour hole at the seam —
 * see {@link PartitionTarget.bound} for the measurement.
 *
 * So the job looks first, and a database that needs repair fails LOUDLY, per
 * tenant, through the caller's existing `catch` — which counts it in
 * `tenantsFailed` and names it in the log — rather than creating the partition
 * that opens the gap. `scripts/tenant-timezone-audit.ts` is what reports and
 * repairs the estate.
 *
 * `countFrom` compares partitions by NAME, which is exactly why this cannot be
 * left to it: the names are identical either way. Only the bound differs.
 */
async function assertBoundsAreUtc(client: RawClient, target: PartitionTarget): Promise<void> {
  if (target.bound !== 'timestamptz') return;
  const rows = await client.$queryRawUnsafe<{ name: string; bound: string }[]>(
    `SELECT c.relname AS name, pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
       JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
       JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = $1 AND p.relname = $2 AND c.relkind = 'r'`,
    target.schema,
    target.table,
  );
  // THE TEST IS "MIDNIGHT UTC", NOT "ENDS IN +00", and the difference is the
  // whole check. This job's own session is UTC (the pool carries
  // `PG_SESSION_OPTIONS`), so Postgres renders EVERY bound with a `+00` suffix —
  // including one created in Athens, which comes back as
  // `'2026-08-31 21:00:00+00'`. Suffix-matching would have passed the exact rows
  // it exists to catch. What distinguishes them is the time of day: a UTC month
  // start is `00:00:00`, and local midnight in any other zone is not.
  //
  // Reading the rendered text is what `countFrom`'s docblock warns is
  // version-dependent. Here it is the only thing that CAN distinguish them, and
  // a rendering change makes this refuse rather than pass — the safe direction.
  const utcMidnight = /'\d{4}-\d{2}-\d{2} 00:00:00\+00'/g;
  const wrong = rows
    .filter((r) => {
      const literals = r.bound.match(/'[^']*'/g) ?? [];
      const midnights = r.bound.match(utcMidnight) ?? [];
      return literals.length === 0 || midnights.length !== literals.length;
    })
    .map((r) => r.name);
  if (wrong.length === 0) return;
  throw new Error(
    `${target.schema}.${target.table} has ${wrong.length} partition(s) whose bounds are not UTC ` +
      `day boundaries (${wrong.slice(0, 3).join(', ')}${wrong.length > 3 ? ', …' : ''}). They were ` +
      'created by a session that was not UTC, and adding a UTC-bounded partition beside them ' +
      'would leave a hole that every audited write in it fails into with 23514. Run ' +
      '`pnpm tsx scripts/tenant-timezone-audit.ts` for the estate, and see ' +
      'packages/shared/src/postgres-session.ts.',
  );
}

/**
 * How many partitions this table has from the current month onwards.
 *
 * Compared by NAME, lexicographically, which works because both creators of a
 * partition here — the baseline's `DO $partitions$` block and the loop above —
 * use the same `<table>_YYYY_MM` format, and `YYYY_MM` sorts chronologically as
 * text. Reading the bound out of `pg_get_expr(relpartbound, …)` and parsing it
 * would be more general and would depend on Postgres's rendering of a partition
 * bound not changing between versions, which is a promise nobody made.
 */
async function countFrom(
  client: RawClient,
  target: { schema: string; table: string },
  fromName: string,
): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ months: number }[]>(
    `SELECT pg_catalog.count(*)::int AS months
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
       JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
       JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = $1 AND p.relname = $2 AND c.relname >= $3`,
    target.schema,
    target.table,
    fromName,
  );
  return rows[0]?.months ?? 0;
}

/** `<table>_YYYY_MM` for the month `offset` months from now. */
function monthName(table: string, offset: number): string {
  const start = monthStart(offset);
  return `${table}_${start.slice(0, 4)}_${start.slice(5, 7)}`;
}

/**
 * The first day of the month `offset` months from now, as `YYYY-MM-DD`.
 *
 * Computed in UTC and by CIVIL arithmetic — `setUTCMonth` normalises 13 to
 * January of the next year — rather than by adding milliseconds. A month is not
 * 30 × 86_400_000, and this file is one `Date` slip away from creating a
 * partition boundary that is not a month start, which the
 * `circulation_statistics_period_is_month_start` CHECK would then refuse rows
 * into.
 */
function monthStart(offset: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 10);
}

/** A Postgres identifier, quoted. Nothing user-supplied reaches this. */
function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Refusing to build DDL with the identifier ${JSON.stringify(identifier)}.`);
  }
  return `"${identifier}"`;
}
