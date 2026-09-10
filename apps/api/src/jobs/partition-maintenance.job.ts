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
const PARTITIONED: readonly { schema: string; table: string; column: string }[] = [
  { schema: 'lbr2', table: 'audit_log', column: 'occurred_at' },
  { schema: 'lbr2', table: 'circulation_statistics', column: 'period_start' },
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
  target: { schema: string; table: string; column: string },
): Promise<{ created: number; headroomMonths: number }> {
  const before = await countFrom(client, target, monthName(target.table, 0));

  for (let i = 0; i <= MONTHS_AHEAD; i += 1) {
    await client.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${quote(target.schema)}.${quote(monthName(target.table, i))} ` +
        `PARTITION OF ${quote(target.schema)}.${quote(target.table)} ` +
        `FOR VALUES FROM ('${monthStart(i)}') TO ('${monthStart(i + 1)}')`,
    );
  }

  const after = await countFrom(client, target, monthName(target.table, 0));
  // `after - 1`: the current month is not headroom, it is today.
  return { created: Math.max(0, after - before), headroomMonths: Math.max(0, after - 1) };
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
