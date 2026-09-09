import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This provisions a database and reads pg_statio. No plan gate is exercised, so it runs the ' +
    'shipped configuration.',
);

/**
 * Phase 11a — the claim the whole bibliographic design rests on, measured.
 *
 * §2: "nothing that scans reads the document. Facets, reports, OPAC and
 * OpenSearch read the relational projection… TOAST keeps fat JSONB off the heap
 * page **provided nothing selects it** — and Prisma's default `findMany`
 * selects every scalar column."
 *
 * `bib_records` is the projection, and it has fat columns of its own: `summary`
 * is a 520 note and `search_text` is the union of every indexed subfield. So the
 * same discipline the 1:1 document split enforces structurally has to be a
 * habit here, and this is the test that makes the habit checkable.
 *
 * ## Why `pg_statio_user_tables` and not EXPLAIN
 *
 * The obvious instrument is wrong, and measurably so. Against the fixture below:
 *
 *     real SELECT projecting the fat column   → toast blocks 300
 *     EXPLAIN (ANALYZE, BUFFERS) of the SAME  → "Buffers: shared hit=185", and
 *                                                no TOAST line at all
 *
 * TOAST fetches happen during output-tuple formation, outside the executor's
 * buffer accounting, so an EXPLAIN-based test reports zero for a query that
 * performs three hundred reads in production — and would pass, silently, on the
 * exact regression it exists to catch. `pg_statio_user_tables` counts them
 * because it counts the buffer manager, not the plan.
 *
 * ## Why the fixture is forced rather than catalogued
 *
 * Records created through the API do NOT reach TOAST, and that is worth knowing:
 * the projector clamps `summary` to 2,000 characters and `search_text` to 8,000,
 * and both columns are `SET COMPRESSION lz4`, so real prose compresses under the
 * ~2 KB threshold and stays inline. A fixture built from realistic records would
 * therefore measure zero TOAST reads for BOTH queries and assert nothing — which
 * is precisely how a test like this goes quietly green. The rows here are
 * incompressible `md5()` noise, forced past the threshold on purpose, and
 * {@link guard} refuses to let the suite proceed if they did not get there.
 */
const provisioning = new TenantProvisioningService();
const tenantId = `p11toast${randomBytes(8).toString('hex')}`;
let dbUrl = '';

const ROWS = 300;

/**
 * Run `sql`, then close the connection.
 *
 * Closing is not tidiness: a backend flushes its pending statistics on exit, so
 * a measurement taken after the connection has gone is the one guaranteed to
 * include the query that was just run. `pg_stat_force_next_flush()` is belt as
 * well as braces — without either, the counters lag behind by up to
 * `PGSTAT_MIN_INTERVAL` and the delta reads as zero.
 */
async function run(sql: string): Promise<void> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(sql);
    await client.query('SELECT pg_catalog.pg_stat_force_next_flush()');
  } finally {
    await client.end();
  }
}

async function read<T>(sql: string): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Every TOAST block one table has touched since the database started. */
async function toastBlocks(relname = 'bib_records'): Promise<number> {
  const rows = await read<{ n: string }>(
    // COALESCE unqualified: it is SQL syntax, not a function, so there is no
    // pg_catalog entry to name and `pg_catalog.coalesce(...)` is a hard error.
    `SELECT (COALESCE(toast_blks_read, 0) + COALESCE(toast_blks_hit, 0))::text
       AS n FROM pg_catalog.pg_statio_user_tables
      WHERE schemaname = 'lbr2' AND relname = '${relname}'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** TOAST blocks a query costs, measured as a delta around it. */
async function toastCostOf(sql: string, relname = 'bib_records'): Promise<number> {
  const before = await toastBlocks(relname);
  await run(sql);
  return (await toastBlocks(relname)) - before;
}

beforeAll(async () => {
  const placement = await provisioning.provision({ tenantId, cellId: 'cell-eu-1' });
  dbUrl = placement.dbUrl;

  // A MARC record per projection row, because `bib_records.bib_id` is a foreign
  // key into it — the projection cannot exist without the record it projects,
  // which is the point of the table.
  await run(`
    SET search_path = lbr2, public;
    INSERT INTO marc_records
      (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
    SELECT 'tp' || g, g, 'bibliographic', 'marc21', 'complete', pg_catalog.rpad('x', 24, 'x'),
           pg_catalog.decode(pg_catalog.md5(g::text) || pg_catalog.md5(g::text), 'hex'),
           'n', pg_catalog.now()
      FROM pg_catalog.generate_series(1, ${ROWS}) g;
    INSERT INTO bib_records
      (bib_id, title, sort_title, match_key, search_text, summary, created_at, updated_at)
    SELECT 'tp' || g, 'Τίτλος ' || g, 'τιτλος ' || g, 'k' || g,
           (SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.random()::text), '')
              FROM pg_catalog.generate_series(1, 120)),
           (SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.random()::text), '')
              FROM pg_catalog.generate_series(1, 120)),
           pg_catalog.now(), pg_catalog.now()
      FROM pg_catalog.generate_series(1, ${ROWS}) g;
    ANALYZE bib_records;
  `);
}, 240_000);

afterAll(async () => {
  await provisioning.teardown(tenantId).catch(() => undefined);
}, 60_000);

describe('the fat columns of bib_records', () => {
  it('guard: the fixture actually reached TOAST', async () => {
    // Without this the suite is theatre. If lz4 squeezed these values back under
    // the threshold — which is exactly what happens to `repeat()`-based test
    // data, measured — both queries below would cost zero blocks and the
    // comparison would pass having proved nothing.
    const [row] = await read<{ toast_bytes: string; stored: string }>(
      `SELECT pg_catalog.pg_relation_size(c.reltoastrelid)::text AS toast_bytes,
              (SELECT pg_catalog.avg(pg_catalog.pg_column_size(summary))::int::text
                 FROM lbr2.bib_records) AS stored
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'lbr2' AND c.relname = 'bib_records'`,
    );
    expect(
      Number(row!.toast_bytes),
      'the TOAST relation for bib_records is empty, so every measurement below is zero and ' +
        'this suite asserts nothing',
    ).toBeGreaterThan(0);
    expect(
      Number(row!.stored),
      'the summaries compressed below the TOAST threshold — which is what happens to ' +
        '`repeat()`-based fixture data under lz4, measured — so the comparison would pass ' +
        'having proved nothing',
    ).toBeGreaterThan(2000);
  });

  it('a browse list costs ZERO toast blocks', async () => {
    // The columns a catalogue list actually renders. This is the number the
    // whole design claims — a 5M-record catalogue browsable without a single
    // TOAST read — and it holds only while nothing widens the select.
    const cost = await toastCostOf(
      `SELECT bib_id, title, sort_title, publication_year, publisher
         FROM lbr2.bib_records ORDER BY sort_title, bib_id`,
    );
    expect(cost).toBe(0);
  });

  it('selecting summary costs one toast read per row, which is the whole point', async () => {
    // The control. If this were also zero, the test above would be measuring a
    // broken instrument rather than a narrow query — which is the failure mode
    // the EXPLAIN version of this test has.
    const cost = await toastCostOf(`SELECT bib_id, title, summary FROM lbr2.bib_records`);
    expect(cost).toBeGreaterThanOrEqual(ROWS);
  });

  it('selecting search_text costs the same — it is not only the 520 note', async () => {
    // `search_text` is the union of every indexed subfield and is the column a
    // careless `SELECT *` is most likely to drag along, because nothing about
    // its name suggests it is large.
    const cost = await toastCostOf(`SELECT bib_id, search_text FROM lbr2.bib_records`);
    expect(cost).toBeGreaterThanOrEqual(ROWS);
  });

  it('a populated source_blob is on the same table and must not be read either', async () => {
    // PHASE 11B PUT BYTES IN `marc_record_contents.source_blob` for the first
    // time. The TOAST discipline this suite measures is about `bib_records`, but
    // the 1:1 document split's stated purpose is that "`source_blob bytea` stays
    // out of `SELECT *` forever" — and until 11b that column was NULL in every
    // database, so nothing had ever tested it against a real blob.
    //
    // The record read path (`BibReadService.read`) computes `source_blob IS NOT
    // NULL` in SQL rather than selecting the column, which is what this measures.
    // INSERTed, not updated: the fixture above creates `marc_records` and
    // `bib_records` and no document at all, which is exactly the state a
    // projection-only fixture is in.
    await run(`
      SET search_path = lbr2, public;
      INSERT INTO marc_record_contents (record_id, content, source_format, source_blob, updated_at)
      SELECT id, '[]'::jsonb, 'iso2709',
             pg_catalog.decode(
               (SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.random()::text), '')
                  FROM pg_catalog.generate_series(1, 200)), 'hex'),
             pg_catalog.now()
        FROM marc_records;
      ANALYZE marc_record_contents;
    `);
    const [guard] = await read<{ stored: string }>(
      `SELECT pg_catalog.avg(pg_catalog.pg_column_size(source_blob))::int::text AS stored
         FROM lbr2.marc_record_contents WHERE source_blob IS NOT NULL`,
    );
    expect(
      Number(guard!.stored),
      'the fixture blobs stayed inline, so the comparison below proves nothing',
    ).toBeGreaterThan(2000);

    const narrow = await toastCostOf(
      `SELECT r.id, c.source_format, (c.source_blob IS NOT NULL) AS has_blob
         FROM lbr2.marc_records r JOIN lbr2.marc_record_contents c ON c.record_id = r.id`,
      'marc_record_contents',
    );
    expect(narrow).toBe(0);

    const fat = await toastCostOf(
      `SELECT c.record_id, c.source_blob FROM lbr2.marc_record_contents c
        WHERE c.source_blob IS NOT NULL`,
      'marc_record_contents',
    );
    expect(fat).toBeGreaterThan(0);
  });

  it('SELECT * costs both — the thing Prisma findMany does by default', async () => {
    // §2 names this exactly: "Prisma's default `findMany` selects every scalar
    // column". Twice the cost of one fat column, on a query a developer writes
    // without thinking about it.
    const cost = await toastCostOf(`SELECT * FROM lbr2.bib_records`);
    expect(cost).toBeGreaterThanOrEqual(ROWS * 2);
  });
});
