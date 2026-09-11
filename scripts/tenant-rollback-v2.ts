#!/usr/bin/env tsx
/**
 * Undo a committed 2.0 cutover, putting the 1.0 schema back (2.0 phase 20b).
 *
 * ## §6's recipe destroys the archive it exists to restore
 *
 * The plan of record writes the rollback as
 *
 *     DROP SCHEMA public CASCADE; ALTER SCHEMA v1_archive RENAME TO public;
 *
 * and measured against a correctly cut-over clone, that is a data-loss bug. The
 * cutover leaves all six extensions in `public` — that is exactly what makes the
 * archive safe to drop later — so dropping `public` drops the extensions, and
 * every 1.0 object depending on them goes too:
 *
 *     NOTICE:  drop cascades to 148 other objects
 *       drop cascades to extension unaccent / pg_trgm / citext / pgcrypto / …
 *       drop cascades to column email of table v1_archive.members
 *       drop cascades to index v1_archive.books_search_trgm
 *       drop cascades to index v1_archive.members_search_trgm
 *       drop cascades to index v1_archive.authors_sortname_trgm
 *       drop cascades to index v1_archive.collection_records_search_trgm
 *
 * The "restored" library comes back with no member email column, no search
 * indexes, and plpgsql as its only extension. As a NOTICE, so a script with
 * `ON_ERROR_STOP` set does not stop — verified, not assumed.
 *
 * SEND THE EXTENSIONS HOME FIRST and the same three statements are correct:
 *
 *     ALTER EXTENSION … SET SCHEMA v1_archive;   -- ×6
 *     DROP SCHEMA public CASCADE;                -- 137 objects, all 2.0's own
 *     ALTER SCHEMA v1_archive RENAME TO public;
 *
 * Measured on a committed clone: 6 extensions survive, `members.email` survives,
 * all four 1.0 trigram indexes survive, and a case-insensitive email match still
 * returns true.
 *
 * ## It refuses to run twice
 *
 * The second run of a rollback is the dangerous one: `public` then holds the
 * RESTORED 1.0 schema, and the same three statements would drop the library.
 * So this checks the shape before it touches anything — `public` must look like
 * 2.0 and `v1_archive` must look like 1.0 — and refuses by name otherwise.
 *
 * ## What it cannot undo
 *
 * Anything written to the 2.0 schema since the cutover. A rollback restores the
 * library as it was the moment the cutover committed; a day of circulation done
 * afterwards is in `public` and goes with it. That is stated here rather than
 * discovered, and it is why the runbook's answer to "should we roll back?" has a
 * time limit on it.
 */
import { Client } from 'pg';
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const NAME = 'tenant-rollback-v2';

/** The same six the cutover moved, sent back the way they came. */
const EXTENSIONS = [
  'unaccent',
  'pg_trgm',
  'citext',
  'pgcrypto',
  'btree_gist',
  'btree_gin',
] as const;

const args = parseArgs({
  name: NAME,
  description: 'Undo a committed 2.0 cutover: restore the 1.0 schema from v1_archive.',
  options: { url: { type: 'string' }, yes: { type: 'boolean' } },
  required: ['url'],
});

async function main(): Promise<void> {
  const targetUrl = args.values.url as string;
  if (!isYes(args.values.yes)) {
    die(
      NAME,
      'This DROPS the live 2.0 schema and restores 1.0 from v1_archive. Everything written ' +
        'since the cutover is in the 2.0 schema and goes with it. Add --yes to confirm.',
    );
  }

  const client = new Client({ connectionString: targetUrl, options: PG_SESSION_OPTIONS });
  await client.connect();
  try {
    // THE SHAPE CHECK, before anything is touched.
    //
    // `marc_records` exists only in 2.0 and `books` only in 1.0, so the pair
    // identifies which way round the database currently is. Running this twice
    // would otherwise drop the library it had just restored.
    const shape = await client.query<{ v2_in_public: boolean; v1_in_archive: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'public' AND table_name = 'marc_records') AS v2_in_public,
             EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'v1_archive' AND table_name = 'books') AS v1_in_archive`);
    const row = shape.rows[0];
    if (row === undefined || !row.v2_in_public || !row.v1_in_archive) {
      die(
        NAME,
        'This database is not in the shape a cutover leaves. Expected the 2.0 schema in ' +
          `\`public\` (marc_records: ${row?.v2_in_public === true ? 'yes' : 'NO'}) and 1.0 in ` +
          `\`v1_archive\` (books: ${row?.v1_in_archive === true ? 'yes' : 'NO'}). ` +
          'If the rollback has already run, there is nothing to undo; if the cutover has not ' +
          'run, there is nothing to undo either.',
      );
    }

    await client.query('BEGIN');
    try {
      // Extensions FIRST. This is the whole correction to §6's recipe: they are
      // in `public` because the cutover put them there, and 1.0's own objects in
      // `v1_archive` depend on them.
      for (const ext of EXTENSIONS) {
        await client.query(`ALTER EXTENSION ${ext} SET SCHEMA v1_archive`);
      }
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('ALTER SCHEMA v1_archive RENAME TO public');

      // Assert the restoration under the 1.0 client's own search_path, inside
      // the transaction, so a failure rolls back rather than leaving a database
      // with neither schema in place.
      await client.query(`SET LOCAL search_path TO "$user", public`);
      const checks = await client.query<{ id: string; ok: boolean }>(`
        SELECT 'members.email survives' AS id,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'members'
                          AND column_name = 'email') AS ok
        UNION ALL
        SELECT 'the 1.0 trigram indexes survive',
               (SELECT count(*) FROM pg_catalog.pg_indexes
                 WHERE schemaname = 'public' AND indexname LIKE '%trgm') >= 4
        UNION ALL
        SELECT 'every extension survives',
               (SELECT count(*) FROM pg_catalog.pg_extension
                 WHERE extname <> 'plpgsql') = ${EXTENSIONS.length}
        UNION ALL
        SELECT 'citext still compares case-insensitively',
               ('A@B.GR'::citext = 'a@b.gr'::citext)`);
      const bad = checks.rows.filter((c) => !c.ok);
      if (bad.length > 0) {
        await client.query('ROLLBACK');
        die(NAME, `the restored 1.0 schema is not sound: ${bad.map((b) => b.id).join('; ')}`);
      }
      await client.query('COMMIT');
      for (const c of checks.rows) log(NAME, `✓ ${c.id}`);
      log(NAME, 'rolled back. This tenant is 1.0 again; the 2.0 schema is gone.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
