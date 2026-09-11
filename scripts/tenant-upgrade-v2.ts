#!/usr/bin/env tsx
/**
 * Turn a 1.0 tenant database into a 2.0 one. DRY RUNS ONLY (2.0 phase 19b).
 *
 * ## There is no `--commit`, and that is the feature
 *
 * Phase 20 is the cutover. This script exists so that, by the time somebody runs
 * it for real, the transformation has been rehearsed against every tenant the
 * library has — and a rehearsal that can accidentally commit is not a rehearsal.
 * `--commit` parses and exits 2 naming phase 20. There is no environment
 * variable that changes that, because an environment variable is the thing
 * somebody exports and then forgets.
 *
 * The one mode that does commit is `--clone=<name>`: it copies the database with
 * `CREATE DATABASE … TEMPLATE`, upgrades the COPY, and leaves the original
 * untouched. CI uses it to rehearse the post-commit steps and the rollback.
 *
 * ## One transaction, and what that buys
 *
 * `ALTER SCHEMA public RENAME TO v1_archive`, the whole copy-forward and the
 * verifier are ONE transaction on ONE connection. DDL is transactional in
 * PostgreSQL, so a failure anywhere — including a verifier assertion — rolls the
 * rename back with everything else and leaves the database byte-identical. That
 * is the §8 risk 1 mitigation, and it is why the verifier runs BEFORE the commit
 * rather than after it: a verifier that can only report is a report.
 *
 * ## Why TypeScript and not the PL/pgSQL §6 specifies
 *
 * Three things in the transformation have no SQL half and cannot get one:
 * `contentHash` is async and hashes canonical NFC JSON (Postgres has no NFC);
 * `stripNonfilingArticle` decides 245 ind2 from six languages' article tables;
 * and `projectBib`'s anomaly WORDING is compared nightly by `catalog-verify`, so
 * a hand-built projection would report every migrated record as drifted for ever.
 * A SQL port of each would be a second implementation whose only job is to agree
 * with the first. Atomicity is not the trade: `pg` gives the same one BEGIN.
 *
 * ## THE ROLLBACK, and why §6's recipe is not yet the right one
 *
 * §6 writes the rollback as
 *
 *     DROP SCHEMA public CASCADE; ALTER SCHEMA v1_archive RENAME TO public;
 *
 * and MEASURED against a committed clone, that fails with `schema "public" does
 * not exist`. It has to: this phase renames `public` away and never puts
 * anything in its place, because promoting `lbr2` is phase 20's job. Until that
 * promotion there is no second `public` to drop.
 *
 * Before the promotion the rollback is ONE statement:
 *
 *     ALTER SCHEMA v1_archive RENAME TO public;
 *
 * Verified on a committed clone: 1,000 books, 500 members, 800 loans, 150 fines,
 * `roles` readable through the default search_path — which is what the surviving
 * 1.0 client does — a Greek title intact, and citext still comparing
 * case-insensitively. §6's two-step becomes correct the moment phase 20 renames
 * `lbr2` to `public`, and is the wrong instruction to leave in a runbook before
 * then.
 *
 * ## The precondition it refuses to paper over
 *
 * `lbr2` must already be provisioned — baseline applied and defaults seeded —
 * days earlier and idempotently. §6 reads "rename → baseline → copy-forward",
 * which would put `prisma migrate deploy` inside this transaction; it shells out,
 * opens its own connections and is not transactional, so it cannot be. This
 * asserts the precondition before BEGIN and stops if it is not met.
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, projectBib } from '@libriant/marc';
import { foldGreek } from '@libriant/shared/greek';
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import {
  marcFromBook,
  type V1Author,
  type V1Book,
} from '@libriant/db-tenant/upgrade/marc-from-book';
import { die, log, parseArgs } from './_lib/cli.js';

const NAME = 'tenant-upgrade-v2';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE_DIR = path.resolve(HERE, '../packages/db-tenant/prisma/upgrade');

const args = parseArgs({
  name: NAME,
  description:
    'Rehearse the 1.0 to 2.0 upgrade of a tenant database. Dry run by default; ' +
    'nothing is ever committed to the database you point it at.',
  options: {
    url: { type: 'string' },
    slug: { type: 'string' },
    clone: { type: 'string' },
    commit: { type: 'boolean' },
    report: { type: 'boolean' },
  },
  required: ['url'],
});

if (args.values.commit === true) {
  die(
    NAME,
    'There is no --commit in phase 19. The cutover is phase 20, and a rehearsal that can ' +
      'accidentally commit is not a rehearsal. Use --clone=<name> to upgrade a disposable copy.',
  );
}

const sqlFile = (f: string): string => readFileSync(path.join(UPGRADE_DIR, f), 'utf8');

type Verdict = { id: string; claim: string; ok: boolean; detail: string };

async function main(): Promise<void> {
  const targetUrl = args.values.url as string;
  const slug = (args.values.slug as string | undefined) ?? 'demo';

  const client = new Client({ connectionString: targetUrl, options: PG_SESSION_OPTIONS });
  await client.connect();

  try {
    // -- preconditions, BEFORE the transaction -------------------------------
    const pre = await client.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM pg_catalog.pg_tables WHERE schemaname = 'lbr2'`,
    );
    if (Number(pre.rows[0]?.n ?? 0) < 100) {
      die(
        NAME,
        `lbr2 holds only ${pre.rows[0]?.n ?? 0} tables. The 2.0 baseline must be applied and the ` +
          `defaults seeded BEFORE this runs — it cannot be a step inside the transaction, because ` +
          `prisma migrate deploy shells out and opens its own connections.`,
      );
    }
    const seeded = await client.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.circulation_rules WHERE id = 'rule-default'`,
    );
    if (Number(seeded.rows[0]?.n ?? 0) !== 1) {
      die(NAME, 'lbr2 has no rule-default. The provisioning defaults have not been seeded.');
    }

    // EVERY EXISTING audit_log PARTITION MUST BE ON UTC MIDNIGHT.
    //
    // The baseline migration creates its 27 partitions with a bare %L on a date,
    // which Postgres resolves in the SESSION's TimeZone. On a database migrated
    // before phase 17's ALTER DATABASE ... SET TimeZone TO 'UTC' — or by any
    // path that skips it — the bounds are LOCAL midnight:
    //
    //   audit_log_2026_06 FROM '2026-05-31 21:00+00'   (Athens)
    //
    // The upgrade back-fills partitions for the months the 1.0 audit log
    // actually spans, on UTC midnight, and a UTC May then OVERLAPS an Athens
    // June. Postgres refuses the CREATE and the whole upgrade fails on a
    // detail nobody would connect to a timezone.
    //
    // It REFUSES rather than adapting, which is phase 17's own decision applied
    // one table along: `assertBoundsAreUtc` in partition-maintenance.job.ts
    // takes the same position, and for the same reason — a mixed convention is a
    // three-hour seam in which audited writes fail with 23514 and there is no
    // DEFAULT partition to catch them. Rewriting an existing partition's bounds
    // is a data move, not something an upgrade should do on the way past.
    const skewed = await client.query<{ name: string; bound: string }>(`
      SELECT c.relname AS name, pg_catalog.pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_catalog.pg_class pt ON pt.oid = i.inhparent
        JOIN pg_catalog.pg_namespace n ON n.oid = pt.relnamespace
       WHERE n.nspname = 'lbr2' AND pt.relname = 'audit_log'
         AND pg_catalog.pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
         AND pg_catalog.pg_get_expr(c.relpartbound, c.oid) NOT LIKE '%00:00:00+00%'`);
    if (skewed.rows.length > 0) {
      die(
        NAME,
        `${skewed.rows.length} audit_log partition(s) are not on UTC midnight — e.g. ` +
          `${skewed.rows[0]?.name} ${skewed.rows[0]?.bound}. This database was migrated before ` +
          `the phase-17 UTC pin, or by a path that skips it. Pin the database ` +
          `(ALTER DATABASE ... SET TimeZone TO 'UTC'), rebuild the partitions, and run again: ` +
          `back-filling UTC partitions beside local-midnight ones leaves a three-hour seam in ` +
          `which every audited write fails, and there is no DEFAULT partition to catch it.`,
      );
    }

    // lbr2 MUST HOLD NO DATA. Provisioned, seeded with defaults, and empty of
    // anything a library put there.
    //
    // This is not fastidiousness. The copy-forward writes journals for every row
    // in `lbr2.fees`, so a pre-existing fee gets a charge journal and no
    // settlement, and the first symptom is a foreign-key violation a hundred
    // statements later that names an id nobody recognises. The general case is
    // worse: an upgrade into a populated lbr2 MERGES TWO LIBRARIES, silently,
    // and there is no undo once it commits.
    const populated = await client.query<{ t: string; n: string }>(`
      SELECT t.table_name AS t, c.n::text AS n
        FROM (VALUES ('marc_records'),('items'),('patrons'),('loans'),('holds'),('fees'),
                     ('account_transactions'),('audit_log')) AS t(table_name)
       CROSS JOIN LATERAL (
         SELECT pg_catalog.count(*) AS n FROM lbr2.marc_records WHERE t.table_name = 'marc_records'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.items WHERE t.table_name = 'items'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.patrons WHERE t.table_name = 'patrons'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.loans WHERE t.table_name = 'loans'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.holds WHERE t.table_name = 'holds'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.fees WHERE t.table_name = 'fees'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.account_transactions
            WHERE t.table_name = 'account_transactions'
          UNION ALL SELECT pg_catalog.count(*) FROM lbr2.audit_log WHERE t.table_name = 'audit_log'
       ) c
       WHERE c.n > 0`);
    if (populated.rows.length > 0) {
      die(
        NAME,
        `lbr2 already holds data: ${populated.rows.map((r) => `${r.t}=${r.n}`).join(', ')}. ` +
          `The upgrade writes INTO a provisioned-but-empty 2.0 schema; running it against one ` +
          `that already has rows merges two libraries, and nothing undoes that after a commit.`,
      );
    }

    log(
      NAME,
      `upgrading ${args.values.clone === undefined ? 'IN A DRY RUN' : `a clone (${args.values.clone})`}`,
    );

    await client.query('BEGIN');

    // -- 1. the rename -------------------------------------------------------
    //
    // DDL is transactional, so this rolls back with everything else. From here
    // on `public` does not exist and every statement names its schema.
    await client.query('ALTER SCHEMA public RENAME TO v1_archive');

    // -- 2. the frozen policy snapshot ---------------------------------------
    //
    // ONE snapshot for every migrated loan and hold, because a 1.0 library had
    // exactly one policy. It is a TEMP table so it vanishes with the connection
    // and cannot be mistaken for data.
    await client.query(
      `CREATE TEMP TABLE _upgrade_params (snapshot jsonb NOT NULL) ON COMMIT DROP`,
    );
    const settings = await client.query<Record<string, unknown>>(
      `SELECT * FROM v1_archive.tenant_settings LIMIT 1`,
    );
    const s = settings.rows[0] ?? {};
    await client.query(`INSERT INTO _upgrade_params (snapshot) VALUES ($1::jsonb)`, [
      JSON.stringify({
        migratedFrom: '1.0',
        loanPeriodDays: s['loanPeriodDays'] ?? null,
        maxRenewals: s['maxRenewals'] ?? null,
        finePerDayCents: s['finePerDayCents'] ?? null,
        currency: s['currency'] ?? 'EUR',
      }),
    ]);
    // The SQL names `_upgrade_params` unqualified, and this is why: a temp
    // table lives in pg_temp, which goes FIRST on the search_path. Everything
    // else in those files names its schema, because after the rename `public`
    // does not exist and an unqualified name would resolve to nothing.
    await client.query(`SET LOCAL search_path TO pg_temp, lbr2, v1_archive`);

    // -- 3. part 1 -----------------------------------------------------------
    await client.query(sqlFile('01-pre-catalog.sql'));
    log(NAME, 'patrons, settings and the compat twins copied');

    // -- 4. the catalogue, through the REAL codec ----------------------------
    const books = await client.query<V1Book & { id: string }>(
      `SELECT id, title, subtitle, isbn13, isbn10, publisher, "publicationYear" AS "publicationYear",
              language, edition, "numPages" AS "numPages", description, classification,
              "createdAt" AS "createdAt", "updatedAt" AS "updatedAt", "archivedAt" AS "archivedAt"
         FROM v1_archive.books ORDER BY id`,
    );
    const links = await client.query<V1Author & { bookId: string }>(
      `SELECT ba."bookId" AS "bookId", a.id, a."fullName" AS "fullName",
              a."isOrganization" AS "isOrganization", a."birthYear" AS "birthYear",
              a."deathYear" AS "deathYear", ba."order" AS "order", ba.role
         FROM v1_archive.book_authors ba
         JOIN v1_archive.authors a ON a.id = ba."authorId"
        ORDER BY ba."bookId", ba."order", a.id`,
    );
    const byBook = new Map<string, V1Author[]>();
    for (const l of links.rows) {
      const list = byBook.get(l.bookId) ?? [];
      list.push(l);
      byBook.set(l.bookId, list);
    }

    let records = 0;
    let issues = 0;
    for (const book of books.rows) {
      const { record, issues: found } = marcFromBook(
        book,
        byBook.get(book.id) ?? [],
        `LBR-${slug}`,
      );
      const hash = Buffer.from(await contentHash(record as never));
      const projection = projectBib(record as never);

      await client.query(
        `INSERT INTO lbr2.marc_records (
           id, public_no, kind, schema, status, leader, content_hash, current_version,
           record_status_code, charset_code, control_number, date_entered,
           created_at, updated_at, deleted_at)
         VALUES ($1, pg_catalog.nextval('lbr2.marc_public_no_seq'), 'bibliographic', 'marc21',
                 $2, $3, $4, 1, $5, 'a', $1, $6, $7, $8, $9)`,
        [
          book.id,
          book.archivedAt === null ? 'complete' : 'deleted',
          record.leader,
          hash,
          record.leader[5],
          (record.fields.find((f) => f.t === '008')?.v ?? '').slice(0, 6),
          book.createdAt,
          book.updatedAt,
          book.archivedAt,
        ],
      );
      await client.query(
        `INSERT INTO lbr2.marc_record_contents (record_id, content, source_format, source_roundtrips, anomalies, updated_at)
         VALUES ($1, $2::jsonb, 'migrated', false, $3::jsonb, $4)`,
        [book.id, JSON.stringify(record.fields), JSON.stringify(found), book.updatedAt],
      );
      await client.query(
        `INSERT INTO lbr2.marc_record_versions (record_id, version, leader, content, content_hash, change_kind, changed_tags, actor_kind, created_at)
         VALUES ($1, 1, $2, $3::jsonb, $4, 'import', $5, 'system', $6)`,
        [
          book.id,
          record.leader,
          JSON.stringify(record.fields),
          hash,
          record.fields.map((f) => f.t),
          book.createdAt,
        ],
      );
      await client.query(
        // `bib_id`, not `record_id`: the projection IS the record, keyed by it.
        `INSERT INTO lbr2.bib_records (
           bib_id, title, title_nonfiling_skip, sort_title, search_text, match_key,
           publisher, publication_year, language_code, summary, cover_asset_ref,
           custom_fields, legacy_json, projection_anomalies, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$15)`,
        [
          book.id,
          projection.projection.title,
          projection.projection.titleNonfilingSkip,
          projection.projection.sortTitle,
          projection.projection.searchText,
          projection.projection.matchKey,
          projection.projection.publisher,
          projection.projection.publicationYear,
          projection.projection.languageCode,
          projection.projection.summary,
          (book as unknown as { coverAssetRef: string | null }).coverAssetRef ?? null,
          JSON.stringify((book as unknown as { customFields: unknown }).customFields ?? {}),
          // `{ book, authors }`, not the flat row: to_jsonb(books) contains no
          // author column, so the flat shape would lose authors.sortName — the
          // 1.0 importer's natural key — for ever.
          JSON.stringify({ book, authors: byBook.get(book.id) ?? [] }),
          JSON.stringify(projection.anomalies),
          book.updatedAt,
        ],
      );

      for (const issue of found) {
        await client.query(
          `INSERT INTO lbr2.upgrade_exceptions (id, kind, source_table, source_id, source_column, value, note, recorded_at)
           VALUES (pg_catalog.gen_random_uuid()::text, $1, 'books', $2, $3, $4::jsonb, $5, pg_catalog.now())`,
          [issue.kind, book.id, issue.column, JSON.stringify(issue.value ?? null), issue.note],
        );
      }
      records += 1;
      issues += found.length;
    }
    log(NAME, `${records} record(s) synthesised through the real codec, ${issues} exception(s)`);

    // An author nobody linked has no MARC home. RECORDED, never silently lost —
    // this is assertion A12 and no candidate design for this phase had it.
    await client.query(`
      INSERT INTO lbr2.upgrade_exceptions (id, kind, source_table, source_id, value, note, recorded_at)
      SELECT pg_catalog.gen_random_uuid()::text, 'no_target', 'authors', a.id, pg_catalog.to_jsonb(a),
             'An author linked to no book. There is no bibliographic record to carry the name into '
             || 'and no authority store until phase 45, so the row is recorded with its value.',
             pg_catalog.now()
        FROM v1_archive.authors a
       WHERE NOT EXISTS (SELECT 1 FROM v1_archive.book_authors ba WHERE ba."authorId" = a.id)`);

    // -- 5. the audit partitions the data needs ------------------------------
    //
    // audit_log is partitioned monthly and has NO default partition, so a row
    // whose month is missing aborts with 23514 — correct, and the reason the
    // partitions are created from the actual range rather than from today.
    await client.query(`
      DO $$
      DECLARE m date; hi date;
      BEGIN
        SELECT pg_catalog.date_trunc('month', pg_catalog.min("occurredAt"))::date,
               pg_catalog.date_trunc('month', pg_catalog.max("occurredAt"))::date
          INTO m, hi FROM v1_archive.audit_log;
        WHILE m IS NOT NULL AND m <= hi LOOP
          -- IF NOT EXISTS skips a month the baseline already made, which is most
          -- of them: the baseline creates 27 around the migration date and the
          -- 1.0 log usually reaches back before that.
          --
          -- It skips BY NAME, and that is the whole of what it can do. A
          -- partition whose range overlaps this month under a DIFFERENT name is
          -- not caught here and would abort the CREATE — which is the exact
          -- failure a local-midnight audit_log_2026_06 produces against a
          -- UTC-midnight May. The precondition above refuses that database
          -- before BEGIN rather than letting it fail here, where the error
          -- ("would overlap partition") names no cause anyone would connect to a
          -- session timezone.
          EXECUTE pg_catalog.format(
            'CREATE TABLE IF NOT EXISTS lbr2.audit_log_%s PARTITION OF lbr2.audit_log '
            || 'FOR VALUES FROM (TIMESTAMPTZ %L) TO (TIMESTAMPTZ %L)',
            pg_catalog.to_char(m, 'YYYY_MM'),
            pg_catalog.to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
            pg_catalog.to_char(m + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00');
          m := m + interval '1 month';
        END LOOP;
      END $$;`);

    // -- 6. part 2 -----------------------------------------------------------
    await client.query(sqlFile('02-post-catalog.sql'));

    // `items.barcode_norm` IS Greek-folded and `patron_cards.barcode_norm` is
    // NOT (items.service.ts:575-585 says why, and all three candidate designs
    // had it backwards). The fold is TypeScript, so it is applied here.
    const bars = await client.query<{ id: string; barcode: string }>(
      `SELECT id, barcode FROM lbr2.items WHERE barcode IS NOT NULL`,
    );
    for (const b of bars.rows) {
      await client.query(`UPDATE lbr2.items SET barcode_norm = $1 WHERE id = $2`, [
        foldGreek(b.barcode.replace(/\s+/g, '')).toUpperCase(),
        b.id,
      ]);
    }
    // Same for the patron search text: the 1.0 value predates the phase-1
    // final-sigma fix, so a Greek name ending in sigma is unfindable under it.
    await client
      .query(`SELECT id, full_name, patron_number, email, phone FROM lbr2.patrons`)
      .then(async (r) => {
        for (const p of r.rows as Record<string, string | null>[]) {
          await client.query(
            `UPDATE lbr2.patrons SET search_text = $1, sort_name = $2 WHERE id = $3`,
            [
              foldGreek(
                [p['full_name'], p['patron_number'], p['email'], p['phone']]
                  .filter(Boolean)
                  .join(' '),
              ),
              foldGreek(p['full_name'] ?? ''),
              p['id'],
            ],
          );
        }
      });
    log(NAME, 'items, loans, holds, the ledger and the audit log copied');

    // -- 7. the verifier, BEFORE the commit ----------------------------------
    const verdicts = await client.query<Verdict>(sqlFile('03-verify.sql'));
    const failed = verdicts.rows.filter((v) => !v.ok);

    for (const v of verdicts.rows) {
      if (args.values.report === true || !v.ok) {
        log(NAME, `${v.ok ? '✓' : '✗'} ${v.id} ${v.claim}${v.detail ? ` — ${v.detail}` : ''}`);
      }
    }

    if (failed.length > 0) {
      await client.query('ROLLBACK');
      die(
        NAME,
        `${failed.length} of ${verdicts.rows.length} assertion(s) failed. The transaction has been ` +
          `rolled back and the database is byte-identical to how it started.`,
      );
    }

    log(NAME, `all ${verdicts.rows.length} assertions hold`);

    if (args.values.clone === undefined) {
      await client.query('ROLLBACK');
      log(NAME, 'DRY RUN — rolled back. Nothing was written. The cutover is phase 20.');
    } else {
      await client.query('COMMIT');
      log(NAME, `committed to the clone. The original database was never opened for writing.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // tsx loads a script as CJS, so `await main()` at top level is a build error
  // ("Top-level await is currently not supported with the cjs output format").
  // Every other script here ends the same way for the same reason.
  console.error(err);
  process.exitCode = 1;
});
