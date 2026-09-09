import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { V2_SCHEMA } from '@libriant/db-tenant';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This provisions a database and reads pg_catalog. No plan gate is exercised, so it runs the ' +
    'shipped configuration.',
);

/**
 * Phase 9 — the 2.0 baseline, proved against a database this product actually
 * provisions.
 *
 * ## Why it drives the provisioning service rather than psql
 *
 * The same argument `books-active-index.spec.ts` makes: an index that exists in
 * a migration file is not an index a library has. `TenantProvisioningService
 * .provision()` is what signup calls, and it does three things this migration
 * depends on and that no `.sql` file can prove — it creates the extensions
 * BEFORE any migration runs, it deploys both migration folders, and it points
 * the second one at the `lbr2` schema. Each is a separate place to get wrong,
 * and the extension list in particular lives in two files that have no reason to
 * stay in step.
 *
 * ## Why the census is `pg_get_*def` and not the migration text
 *
 * Postgres rewrites what it stores. Measured, written → read back:
 *
 *     CHECK (qty >= 0)                → CHECK ((qty >= 0))
 *     CHECK (s IN ('a','b'))          → CHECK ((s = ANY (ARRAY['a'::text, 'b'::text])))
 *     GENERATED AS (a IS NULL AND !b) → ((a IS NULL) AND (NOT b))
 *
 * so text-matching the migration means reimplementing `pg_get_constraintdef`. A
 * `pg_dump --schema-only` golden was the other candidate and is worse: it
 * carries a random `\restrict` nonce that changes every run.
 *
 * The fixture is scoped to what Prisma CANNOT express — EXCLUDE, CHECK, STORED
 * generated columns, partial and expression indexes, triggers, partitioning,
 * per-column compression and enum label ORDER — so it churns only when somebody
 * writes raw SQL, which is exactly when a reviewer should be looking.
 *
 * Enum label order is in there deliberately. It is what `ORDER BY` on an enum
 * column sorts by, and it is the one thing in this baseline that cannot be
 * changed later without rewriting every table that uses the type.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '__fixtures__/tenant-schema-v2-census.txt');

/**
 * Below this the census is assumed broken rather than satisfied. A provisioning
 * failure that left an empty schema would otherwise produce an empty census
 * matching an empty fixture, and the suite would go green having asserted
 * nothing.
 */
const MIN_CENSUS_LINES = 90;

/**
 * `_prisma_migrations` is excluded throughout: it is Prisma's ledger, its shape
 * is Prisma's business, and it exists in a provisioned tenant but not in a
 * database somebody built by piping the migration into psql. Censusing it would
 * make the fixture depend on which of those two produced it.
 */
const CENSUS_SQL = `
SELECT line FROM (
  SELECT 'index    ' || pg_catalog.pg_get_indexdef(i.indexrelid) AS line
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${V2_SCHEMA}' AND NOT c.relispartition AND c.relname <> '_prisma_migrations'
  UNION ALL
  SELECT 'constraint ' || co.conname || ' ON ' || cl.relname || ' ' ||
         pg_catalog.pg_get_constraintdef(co.oid)
    FROM pg_catalog.pg_constraint co
    JOIN pg_catalog.pg_class cl ON cl.oid = co.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = '${V2_SCHEMA}' AND NOT cl.relispartition AND cl.relname <> '_prisma_migrations'
     AND co.contype IN ('c','x','p','u')
  UNION ALL
  SELECT 'generated ' || cl.relname || '.' || a.attname || ' = ' ||
         pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = '${V2_SCHEMA}' AND NOT cl.relispartition AND a.attgenerated = 's'
  UNION ALL
  SELECT 'trigger  ' || pg_catalog.pg_get_triggerdef(t.oid)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class cl ON cl.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = '${V2_SCHEMA}' AND NOT t.tgisinternal AND NOT cl.relispartition
  UNION ALL
  SELECT 'compression ' || cl.relname || '.' || a.attname || ' = lz4'
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = '${V2_SCHEMA}' AND a.attcompression = 'l'
  UNION ALL
  SELECT 'partitioned ' || cl.relname || ' BY ' || pg_catalog.pg_get_partkeydef(cl.oid)
    FROM pg_catalog.pg_class cl
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
   WHERE n.nspname = '${V2_SCHEMA}' AND cl.relkind = 'p'
  UNION ALL
  SELECT 'enum     ' || t.typname || ' = ' ||
         pg_catalog.string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = '${V2_SCHEMA}' GROUP BY t.typname
) s
ORDER BY line`;

const provisioning = new TenantProvisioningService();
const tenantId = `p9base${randomBytes(8).toString('hex')}`;
let dbUrl = '';

async function query<T = Record<string, unknown>>(sql: string, setup: string[] = []): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const s of setup) await client.query(s);
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Run `sql` expecting it to fail, and return the SQLSTATE it failed with. */
async function sqlstateOf(sql: string, setup: string[] = []): Promise<string> {
  try {
    await query(sql, setup);
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

const V2 = [`SET search_path = ${V2_SCHEMA}, public`];

beforeAll(async () => {
  const placement = await provisioning.provision({ tenantId, cellId: 'cell-eu-1' });
  dbUrl = placement.dbUrl;
}, 240_000);

afterAll(async () => {
  await provisioning.teardown(tenantId).catch(() => undefined);
}, 60_000);

describe('the 2.0 baseline lands on a provisioned tenant', () => {
  it('creates the lbr2 schema beside an untouched 1.0 public', async () => {
    const rows = await query<{ nspname: string }>(
      `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname IN ('${V2_SCHEMA}', 'public')`,
    );
    expect(rows.map((r) => r.nspname).sort()).toEqual([V2_SCHEMA, 'public']);

    // The 1.0 tables are still there and still 1.0's. If a future change made
    // the baseline write into `public`, this is where it surfaces — before it
    // reaches a library that has data in them.
    const oneOh = await query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(Number(oneOh[0]!.n)).toBeGreaterThan(15);
  });

  it('installs btree_gist and btree_gin — the two-places-to-add-an-extension trap', async () => {
    // The datasource does NOT list these (it lists nothing: extensions live in
    // `public` and are shared). They are created by tenant-create.ts, by
    // TenantProvisioningService, and by the baseline itself. That is three
    // places, and this is the only assertion that catches them disagreeing.
    const rows = await query<{ extname: string }>(
      `SELECT extname FROM pg_catalog.pg_extension
        WHERE extname IN ('btree_gist', 'btree_gin')`,
    );
    expect(rows.map((r) => r.extname).sort()).toEqual(['btree_gin', 'btree_gist']);
  });

  it('matches the committed census of everything Prisma cannot express', async () => {
    const rows = await query<{ line: string }>(CENSUS_SQL);
    const actual = rows.map((r) => r.line.replaceAll(`${V2_SCHEMA}.`, '')).sort();

    expect(
      actual.length,
      'the census is suspiciously small — a provisioning failure that left an empty schema ' +
        'would otherwise produce an empty census matching an empty fixture, and this suite ' +
        'would pass having asserted nothing',
    ).toBeGreaterThanOrEqual(MIN_CENSUS_LINES);

    const expected = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).sort();
    const missing = expected.filter((l) => !actual.includes(l));
    const extra = actual.filter((l) => !expected.includes(l));

    expect(
      missing,
      'objects the fixture records and the database does NOT have. A forgotten migration must ' +
        'fail here rather than in production.',
    ).toEqual([]);
    expect(
      extra,
      'objects the database has and the fixture does not record. If the addition is deliberate, ' +
        'regenerate the fixture and commit it with the migration — an unreviewed constraint is ' +
        'the thing this census exists to make impossible.',
    ).toEqual([]);
  });

  it('partitions audit_log monthly, with no DEFAULT partition', async () => {
    // Partition NAMES are relative to provisioning time, so they are excluded
    // from the census fixture and counted here instead.
    const parts = await query<{ n: string; defaults: string }>(
      `SELECT pg_catalog.count(*)::text AS n,
              pg_catalog.count(*) FILTER (
                WHERE pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
              )::text AS defaults
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
         JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = '${V2_SCHEMA}' AND p.relname = 'audit_log'`,
    );
    expect(Number(parts[0]!.n)).toBe(27);
    // A DEFAULT partition silently swallows rows into a heap that can never be
    // partitioned afterwards without rewriting it. A missing future partition
    // failing loudly is the better trade, and phase 16's maintenance job is what
    // stops the loud failure ever happening.
    expect(Number(parts[0]!.defaults)).toBe(0);
  });
});

describe('the acceptance behaviours, in the only place they can be true', () => {
  it('rejects a non-IANA timezone — in the DATABASE, not just in TypeScript', async () => {
    // Phase 19's copy-forward is PL/pgSQL and writes `branches` without going
    // through the application at all, so an application-layer check alone would
    // be bypassed by the one write that matters most.
    expect(
      await sqlstateOf(
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('tz1', 'TZ1', 'x', 'Not/AZone', pg_catalog.now())`,
        V2,
      ),
    ).toBe('23503');

    // A fixed offset has no DST. Accruing a calendar-day fine against one is
    // circ-5 in a new costume, so it is refused too — and this is the assertion
    // that would fail if somebody "helpfully" seeded the offsets.
    expect(
      await sqlstateOf(
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('tz2', 'TZ2', 'x', '+02:00', pg_catalog.now())`,
        V2,
      ),
    ).toBe('23503');

    expect(
      await sqlstateOf(
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('tz3', 'TZ3', 'Κεντρική', 'Europe/Athens', pg_catalog.now())`,
        V2,
      ),
    ).toBe('NO_ERROR');
  });

  it('seeds a build-independent timezone table', async () => {
    // pg_timezone_names differs between Postgres builds — measured, the two
    // 16.15 builds on the development machine hold 599 and 598 rows, and the one
    // row they disagree on is `posixrules`, which is excluded along with
    // `Factory`. Excluding those two also makes this table a strict subset of
    // what `Intl.DateTimeFormat` can format with.
    const rows = await query<{ n: string; bad: string }>(
      `SELECT pg_catalog.count(*)::text AS n,
              pg_catalog.count(*) FILTER (WHERE name IN ('Factory','posixrules'))::text AS bad
         FROM ${V2_SCHEMA}.iana_timezones`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(500);
    expect(Number(rows[0]!.bad)).toBe(0);
  });

  it('raises 23P01 on an overlapping exclusion — the mechanism 9b needs', async () => {
    // `calendar_exceptions` itself is deferred to 9b (§3 mentions it exactly
    // once and never says what its columns are), so what is proved here is the
    // MECHANISM the acceptance criterion turns on: that btree_gist is installed
    // where lbr2 can reach it and that a scalar-plus-range EXCLUDE is
    // constructible and does raise 23P01. 9b then only has to write the table.
    await query(
      `CREATE TABLE ${V2_SCHEMA}.probe_exclusion (
         id text PRIMARY KEY,
         calendar_id text NOT NULL,
         starts_at timestamptz(3) NOT NULL,
         ends_at timestamptz(3) NOT NULL,
         archived_at timestamptz(3),
         blocked tstzrange GENERATED ALWAYS AS
           (pg_catalog.tstzrange(starts_at, ends_at, '[)')) STORED,
         CONSTRAINT probe_no_overlap
           EXCLUDE USING gist (calendar_id WITH =, blocked WITH &&)
           WHERE (archived_at IS NULL))`,
      V2,
    );
    try {
      await query(
        `INSERT INTO probe_exclusion (id, calendar_id, starts_at, ends_at)
         VALUES ('a', 'c1', '2026-01-01Z', '2026-01-05Z')`,
        V2,
      );
      expect(
        await sqlstateOf(
          `INSERT INTO probe_exclusion (id, calendar_id, starts_at, ends_at)
           VALUES ('b', 'c1', '2026-01-03Z', '2026-01-09Z')`,
          V2,
        ),
      ).toBe('23P01');
      // A different calendar is not an overlap.
      expect(
        await sqlstateOf(
          `INSERT INTO probe_exclusion (id, calendar_id, starts_at, ends_at)
           VALUES ('c', 'c2', '2026-01-03Z', '2026-01-09Z')`,
          V2,
        ),
      ).toBe('NO_ERROR');
    } finally {
      await query(`DROP TABLE ${V2_SCHEMA}.probe_exclusion`);
    }
  });

  it('stores the TOAST-bearing columns as lz4, which the GUC alone cannot promise', async () => {
    // Measured: with database-level lz4 in force, a session that does
    // `SET default_toast_compression='pglz'` writes a pglz row and
    // attcompression stays empty. So the durable, assertable property is the
    // per-column setting, not `SHOW default_toast_compression`.
    //
    // The NAMES rather than a count, changed in phase 11a. A bare number said
    // nothing about which column had lost its setting, and it also silently
    // counted `bib_records_search_trgm.search_text` — an INDEX column, which
    // inherits `attcompression` from the table column it indexes. That is
    // genuine catalogue state and the census fixture records it; it is just not
    // one of the decisions this test is about, so `relkind = 'r'` excludes it
    // here and the census keeps it.
    const rows = await query<{ col: string }>(
      `SELECT c.relname || '.' || a.attname AS col
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${V2_SCHEMA}' AND a.attcompression = 'l' AND c.relkind = 'r'
        ORDER BY col`,
    );
    expect(rows.map((r) => r.col)).toEqual([
      // Phase 11a. `summary` is a 520 note, `search_text` the union of every
      // indexed subfield, and both sit on the table a catalogue list reads —
      // see bib-projection-toast.spec.ts for what selecting either costs.
      'bib_records.projection_anomalies',
      'bib_records.search_text',
      'bib_records.summary',
      'change_events.payload',
      'loans.policy_snapshot',
      'marc_record_contents.anomalies',
      'marc_record_contents.content',
      // Phase 11b. The last column in the MARC store to get a durable setting,
      // and it had to be 11b because `ALTER … SET COMPRESSION` does not rewrite
      // existing rows and 11b's ingest is this column's first writer ever.
      'marc_record_contents.source_blob',
      'marc_record_versions.content',
      'sync_client_changes.response_json',
    ]);
  });

  it('guards the branch hierarchy against cycles and keeps depth true', async () => {
    await query(
      `INSERT INTO branches (id, code, name, timezone, updated_at) VALUES
         ('h0', 'H0', 'Σύστημα', 'Europe/Athens', pg_catalog.now());
       INSERT INTO branches (id, code, name, timezone, parent_branch_id, updated_at) VALUES
         ('h1', 'H1', 'Α', 'Europe/Athens', 'h0', pg_catalog.now()),
         ('h2', 'H2', 'Β', 'Europe/Athens', 'h1', pg_catalog.now()),
         ('h3', 'H3', 'Γ', 'Europe/Athens', 'h2', pg_catalog.now())`,
      V2,
    );

    const depth = async () =>
      (
        await query<{ id: string; depth: number }>(
          `SELECT id, depth FROM branches WHERE id LIKE 'h_' ORDER BY id`,
          V2,
        )
      ).map((r) => `${r.id}=${r.depth}`);
    expect(await depth()).toEqual(['h0=0', 'h1=1', 'h2=2', 'h3=3']);

    // A cycle, direct and indirect.
    expect(
      await sqlstateOf(`UPDATE branches SET parent_branch_id = 'h3' WHERE id = 'h1'`, V2),
    ).toBe('23514');
    expect(
      await sqlstateOf(`UPDATE branches SET parent_branch_id = 'h1' WHERE id = 'h1'`, V2),
    ).toBe('23514');

    // THE CASE AN IMPLEMENTER SKIPS: re-parenting a branch that has children
    // must recompute the whole subtree, not just the branch that moved. §3 says
    // only "maintains depth"; without this, `depth` silently rots the first time
    // anyone reorganises, and it exists precisely so a branch picker is one
    // indexed read rather than a recursive CTE.
    await query(`UPDATE branches SET parent_branch_id = NULL WHERE id = 'h1'`, V2);
    expect(await depth()).toEqual(['h0=0', 'h1=0', 'h2=1', 'h3=2']);
  });

  it('writes exactly one change event per write, in a total order', async () => {
    const before = await query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM change_events`,
      V2,
    );
    await query(
      `INSERT INTO branches (id, code, name, timezone, updated_at)
       VALUES ('ce1', 'CE1', 'Δ', 'Europe/Athens', pg_catalog.now())`,
      V2,
    );
    const rows = await query<{ entity_kind: string; entity_id: string; op: string; rv: string }>(
      `SELECT entity_kind, entity_id, op, row_version::text AS rv
         FROM change_events WHERE entity_id = 'ce1' ORDER BY seq`,
      V2,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_kind).toBe('branch');
    expect(rows[0]!.op).toBe('insert');

    // A soft delete is a DISAPPEARANCE to a consumer, not an edit — the OPAC has
    // to drop the record and the index has to remove it. Making each replica
    // infer that from an `archived_at` column it would have to know about is the
    // coupling the projection exists to prevent.
    await query(`UPDATE branches SET archived_at = pg_catalog.now() WHERE id = 'ce1'`, V2);
    await query(`UPDATE branches SET archived_at = NULL WHERE id = 'ce1'`, V2);
    const ops = await query<{ op: string }>(
      `SELECT op FROM change_events WHERE entity_id = 'ce1' ORDER BY seq`,
      V2,
    );
    expect(ops.map((r) => r.op)).toEqual(['insert', 'archive', 'restore']);

    expect(Number(before[0]!.n)).toBeGreaterThanOrEqual(0);
  });

  it('has a commit-ordered watermark column that actually type-checks', async () => {
    // §4.2 specifies the read watermark as `row_version <
    // pg_snapshot_xmin(pg_current_snapshot())`, which does not run: measured,
    // that function returns `xid8` and `row_version` is `bigint`, so Postgres
    // refuses with `operator does not exist: bigint < xid8`. Casting would make
    // it run and still be wrong — a sequence value and a transaction id are
    // unrelated counters.
    //
    // `seq` is assigned at INSERT and becomes visible at COMMIT, so a reader that
    // has seen seq=100 can still have a transaction holding seq=99 open beside
    // it. Recording 100 as the watermark loses 99 forever. This asserts the
    // column that fixes it exists and that the comparison compiles.
    const rows = await query<{ ok: boolean }>(
      `SELECT pg_catalog.count(*) >= 0 AS ok FROM change_events
        WHERE commit_xmin < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())`,
      V2,
    );
    expect(rows[0]!.ok).toBe(true);
  });
});
