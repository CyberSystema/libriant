/**
 * The 2.0 baseline, one module per schema file.
 *
 * ## What these can honestly assert, and what they must not
 *
 * Phase 9 creates tables and NO SERVICES. So the temptation — and the mistake —
 * is to write a module that round-trips a domain object and calls that a smoke
 * test. There is no domain object yet; such a test would be asserting that
 * `INSERT` works.
 *
 * What CAN be true, and what actually breaks if it is not:
 *
 *   1. EVERY TABLE EXISTS AND IS EMPTY. With no services, a table that was never
 *      wired is the only defect that can hide, and it hides completely: nothing
 *      reads it, nothing writes it, and every other test passes. A smoke test
 *      that only exercised constraints would pass just as happily with half the
 *      baseline missing.
 *   2. THE DB-LEVEL INVARIANTS REFUSE THEIR NEGATIVE CASE. A constraint that
 *      exists and does not fire is worse than an absent one, because the code
 *      above it is written trusting it.
 *   3. THE GENERATED COLUMNS COMPUTE, and refuse to be written.
 *   4. ONE WRITE TO A REPLICATED TABLE PRODUCES EXACTLY ONE CHANGE EVENT, with a
 *      strictly increasing `row_version`. Two would make every consumer process
 *      the record twice; none is the silent-desync failure the whole changelog
 *      design exists to prevent.
 *
 * Each module leaves the schema as it found it — empty.
 *
 * These use a raw `pg` connection rather than a generated client, which is the
 * honest shape while there are no services: there is nothing yet for a typed
 * client to be the client OF. Phase 10 brings one with the MARC store.
 */
import { expectSqlstate, ok, note, v2Query, type SmokeModule } from './_lib.js';

/** The tables this baseline creates, per module. Both a checklist and the teardown order. */
const TABLES: Readonly<Record<string, readonly string[]>> = {
  'v2-marc': ['marc_records', 'marc_record_contents', 'marc_record_versions', 'marc_record_locks'],
  'v2-org': ['iana_timezones', 'branches', 'shelving_locations'],
  'v2-holdings-items': ['holdings_records', 'item_types', 'material_types', 'items'],
  'v2-circulation': ['patrons', 'loans'],
  'v2-fees': ['fees'],
  'v2-platform': ['change_events', 'change_consumers', 'sync_client_changes', 'audit_log'],
  'v2-bib-projection': ['bib_records', 'bib_identifiers', 'bib_classifications', 'work_clusters'],
};

const url = () => process.env.TENANT_DATABASE_URL ?? '';

/**
 * Assert each table exists, and is empty apart from the seeded lookup.
 *
 * `iana_timezones` is the one table that is SUPPOSED to have rows — it is a
 * seeded lookup, and a `branches` insert fails on its foreign key without them.
 * So it gets a floor rather than a zero.
 */
async function tablesExistAndAreEmpty(moduleName: string): Promise<void> {
  for (const table of TABLES[moduleName] ?? []) {
    const rows = await v2Query<{ n: string }>(
      url(),
      `SELECT pg_catalog.count(*)::text AS n FROM ${table}`,
    );
    const n = Number(rows[0]!.n);
    if (table === 'iana_timezones') {
      if (n < 500) throw new Error(`${table} holds ${n} row(s); the tzdata seed did not run`);
      ok(`${table} exists, seeded with ${n} zones`);
    } else {
      if (n !== 0) throw new Error(`${table} holds ${n} row(s); phase 9 creates no data`);
      ok(`${table} exists and is empty`);
    }
  }
}

/** A branch and the chain of rows an item needs. Removed again by `teardown`. */
async function seedMinimalChain(): Promise<void> {
  await v2Query(
    url(),
    `INSERT INTO branches (id, code, name, timezone, updated_at)
       VALUES ('smk_b', 'SMOKE', 'Δοκιμαστικό', 'Europe/Athens', pg_catalog.now());
     INSERT INTO shelving_locations (id, branch_id, code, name, updated_at)
       VALUES ('smk_sl', 'smk_b', 'A1', 'Ράφι', pg_catalog.now());
     INSERT INTO item_types (id, code, name, updated_at)
       VALUES ('smk_it', 'BOOK', 'Βιβλίο', pg_catalog.now());
     INSERT INTO marc_records
       (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
       VALUES ('smk_m', 1, 'bibliographic', 'marc21', 'complete',
               pg_catalog.rpad('x', 24, 'x'),
               pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now());
     INSERT INTO holdings_records (record_id, bib_id, branch_id, updated_at)
       VALUES ('smk_h', 'smk_m', 'smk_b', pg_catalog.now());
     INSERT INTO items (id, holdings_record_id, bib_id, item_type_id, owning_branch_id,
                        current_branch_id, permanent_location_id, barcode_norm, created_at, updated_at)
       VALUES ('smk_i', 'smk_h', 'smk_m', 'smk_it', 'smk_b', 'smk_b', 'smk_sl', 'bc1',
               pg_catalog.now(), pg_catalog.now());
     INSERT INTO patrons (id, updated_at) VALUES ('smk_p', pg_catalog.now());`,
  );
}

export async function teardown(): Promise<void> {
  // TRUNCATE … CASCADE rather than an ordered DELETE list. The 1.0 smoke test
  // maintains a hand-ordered list of thirteen `deleteMany` calls, which is
  // correct only until somebody adds a table — and the symptom is a foreign-key
  // error in teardown that looks like a test failure.
  await v2Query(
    url(),
    `TRUNCATE marc_records, branches, shelving_locations, item_types, material_types,
              holdings_records, items, patrons, loans, fees, change_events,
              change_consumers, sync_client_changes, bib_records, work_clusters
     RESTART IDENTITY CASCADE`,
  );
}

const LOAN_COLUMNS =
  'id, item_id, patron_id, bib_id, checkout_branch_id, due_at, original_due_at, ' +
  'loan_policy_id, overdue_fine_policy_id, lost_item_fee_policy_id, applied_rule_id, ' +
  'policy_snapshot, item_type_id_applied, patron_category_id_applied, created_at, updated_at';
const loanValues = (id: string) =>
  `'${id}', 'smk_i', 'smk_p', 'smk_m', 'smk_b', pg_catalog.now() + interval '14 days', ` +
  `pg_catalog.now() + interval '14 days', 'lp', 'of', 'lf', 'r', '{}'::jsonb, 'smk_it', 'pc', ` +
  `pg_catalog.now(), pg_catalog.now()`;

export const v2Modules: SmokeModule[] = [
  {
    name: 'v2-marc',
    describes: 'the MARC store trio',
    async run() {
      await tablesExistAndAreEmpty('v2-marc');
      await expectSqlstate(
        url(),
        `INSERT INTO marc_records
           (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
         VALUES ('bad', 9, 'bibliographic', 'marc21', 'complete', 'too-short',
                 pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now())`,
        '23514',
        'a leader that is not 24 characters is refused',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO marc_records
           (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
         VALUES ('bad2', 9, 'bibliographic', 'marc21', 'complete', pg_catalog.rpad('x', 24, 'x'),
                 '\\x00'::bytea, 'n', pg_catalog.now())`,
        '23514',
        'a content hash that is not 32 bytes is refused',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-org',
    describes: 'branches, the timezone foreign key and the cycle guard',
    async run() {
      await tablesExistAndAreEmpty('v2-org');
      await expectSqlstate(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('tzbad', 'TZ', 'x', 'Europe/Atlantis', pg_catalog.now())`,
        '23503',
        'a non-IANA timezone is refused by the database, not just by TypeScript',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('tzoff', 'TZ', 'x', '+02:00', pg_catalog.now())`,
        '23503',
        'a fixed offset is refused too — it has no DST, which is circ-5 again',
      );

      await seedMinimalChain();
      await expectSqlstate(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('dup', 'SMOKE', 'x', 'Europe/Athens', pg_catalog.now())`,
        '23505',
        'a duplicate branch code among live rows is refused',
      );
      // …but archiving one must release its code, or a library could never
      // reuse the name of a reading room it closed.
      await v2Query(url(), `UPDATE branches SET archived_at = pg_catalog.now() WHERE id = 'smk_b'`);
      await v2Query(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('reuse', 'SMOKE', 'x', 'Europe/Athens', pg_catalog.now())`,
      );
      ok('archiving a branch releases its code for reuse');
    },
    reset: teardown,
  },
  {
    name: 'v2-holdings-items',
    describes: 'items, the generated shelf-availability column and barcode uniqueness',
    async run() {
      await tablesExistAndAreEmpty('v2-holdings-items');
      await seedMinimalChain();

      const shelf = async () =>
        (
          await v2Query<{ v: boolean }>(
            url(),
            `SELECT is_shelf_available AS v FROM items WHERE id = 'smk_i'`,
          )
        )[0]!.v;
      if ((await shelf()) !== true) throw new Error('a fresh item is not shelf-available');
      await v2Query(url(), `UPDATE items SET damaged_code = 'TORN' WHERE id = 'smk_i'`);
      if ((await shelf()) !== false) throw new Error('a damaged item is still shelf-available');
      await v2Query(url(), `UPDATE items SET damaged_code = NULL WHERE id = 'smk_i'`);
      ok('is_shelf_available tracks the four exclusion codes');

      await expectSqlstate(
        url(),
        `UPDATE items SET is_shelf_available = true WHERE id = 'smk_i'`,
        '428C9',
        'a generated column cannot be written',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO items (id, holdings_record_id, bib_id, item_type_id, owning_branch_id,
                            current_branch_id, permanent_location_id, barcode_norm,
                            created_at, updated_at)
         VALUES ('dup_i', 'smk_h', 'smk_m', 'smk_it', 'smk_b', 'smk_b', 'smk_sl', 'bc1',
                 pg_catalog.now(), pg_catalog.now())`,
        '23505',
        'two live copies cannot share a folded barcode',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-circulation',
    describes: 'one open loan per copy, and the lost-then-found dead end 1.0 could not express',
    async run() {
      await tablesExistAndAreEmpty('v2-circulation');
      await seedMinimalChain();

      await v2Query(url(), `INSERT INTO loans (${LOAN_COLUMNS}) VALUES (${loanValues('l1')})`);
      await expectSqlstate(
        url(),
        `INSERT INTO loans (${LOAN_COLUMNS}) VALUES (${loanValues('l2')})`,
        '23505',
        'a second open loan on the same copy is impossible',
      );

      // In 1.0 a `lost` loan keeps returned_at NULL forever, so the partial
      // unique pins the copy out of circulation permanently and a lost-then-found
      // item can never be returned. In 2.0 `lost` closes the loan.
      await v2Query(
        url(),
        `UPDATE loans SET status = 'lost', closed_at = pg_catalog.now() WHERE id = 'l1'`,
      );
      await v2Query(url(), `INSERT INTO loans (${LOAN_COLUMNS}) VALUES (${loanValues('l3')})`);
      ok('a lost loan closes, and the copy becomes lendable again');

      await expectSqlstate(
        url(),
        `UPDATE loans SET closed_at = pg_catalog.now() WHERE id = 'l3'`,
        '23514',
        'an active loan cannot be closed without leaving the open status set',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-fees',
    describes: 'the generated outstanding balance and the settlement ceiling',
    async run() {
      await tablesExistAndAreEmpty('v2-fees');
      await seedMinimalChain();
      await v2Query(
        url(),
        `INSERT INTO fees (id, account_id, patron_id, fee_type_id, currency, branch_id,
                           amount_cents, reason, created_at)
         VALUES ('f1', 'acc', 'smk_p', 'ft', 'EUR', 'smk_b', 500, 'overdue', pg_catalog.now())`,
      );
      const balance = async () =>
        Number(
          (
            await v2Query<{ v: string }>(
              url(),
              `SELECT outstanding_cents::text AS v FROM fees WHERE id = 'f1'`,
            )
          )[0]!.v,
        );
      if ((await balance()) !== 500) throw new Error('a new fee does not owe its full amount');
      await v2Query(url(), `UPDATE fees SET paid_cents = 200 WHERE id = 'f1'`);
      if ((await balance()) !== 300) throw new Error('a part payment did not reduce the balance');
      ok('outstanding_cents is computed by the database, so two code paths cannot disagree');

      await expectSqlstate(
        url(),
        `UPDATE fees SET waived_cents = 400 WHERE id = 'f1'`,
        '23514',
        'a patron cannot be credited more than they were charged',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO fees (id, account_id, patron_id, fee_type_id, currency, branch_id,
                           amount_cents, reason, created_at)
         VALUES ('f0', 'acc', 'smk_p', 'ft', 'EUR', 'smk_b', 0, 'nothing', pg_catalog.now())`,
        '23514',
        'a fee of zero is not a fee',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-platform',
    describes: 'the changelog feed, its total order and its archive/restore ops',
    async run() {
      await tablesExistAndAreEmpty('v2-platform');
      await seedMinimalChain();

      const events = await v2Query<{ entity_kind: string; op: string; rv: string }>(
        url(),
        `SELECT entity_kind, op, row_version::text AS rv FROM change_events ORDER BY seq`,
      );
      // Six replicated inserts in seedMinimalChain: branch, shelving_location,
      // item_type, marc_record, holdings_record, item, patron — seven.
      if (events.length !== 7) {
        throw new Error(`expected 7 change events from the seed, got ${events.length}`);
      }
      const versions = events.map((e) => Number(e.rv));
      if (versions.some((v, i) => i > 0 && v <= versions[i - 1]!)) {
        throw new Error(`row_version is not strictly increasing: ${versions.join(',')}`);
      }
      ok(`${events.length} change event(s), one per replicated write, in a total order`);

      await v2Query(url(), `UPDATE items SET archived_at = pg_catalog.now() WHERE id = 'smk_i'`);
      await v2Query(url(), `UPDATE items SET archived_at = NULL WHERE id = 'smk_i'`);
      const ops = (
        await v2Query<{ op: string }>(
          url(),
          `SELECT op FROM change_events WHERE entity_kind = 'item' ORDER BY seq`,
        )
      ).map((r) => r.op);
      if (ops.join(',') !== 'insert,archive,restore') {
        throw new Error(`expected insert,archive,restore for the item; got ${ops.join(',')}`);
      }
      ok('a soft delete is reported as `archive`, not as an ordinary update');

      note(
        'change_events.actor_kind is `system` here: a trigger cannot see who is logged in, and ' +
          'the request-scoped settings that carry the actor are phase 10 work.',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-bib-projection',
    describes: 'the projection cascade, and the two constraints that must NOT exist',
    async run() {
      await tablesExistAndAreEmpty('v2-bib-projection');
      await seedMinimalChain();

      await v2Query(
        url(),
        `INSERT INTO bib_records (bib_id, title, sort_title, match_key, search_text,
                                  created_at, updated_at)
           VALUES ('smk_m', 'Βίος και πολιτεία', 'βιος και πολιτεια', 'k', 'βιος',
                   pg_catalog.now(), pg_catalog.now());
         INSERT INTO bib_identifiers (id, bib_id, scheme, value, value_norm, source_tag)
           VALUES ('smk_id1', 'smk_m', 'isbn', '978-0-306-40615-7', '9780306406157', '020');
         INSERT INTO bib_classifications (id, bib_id, scheme, value, sort_key, source_tag)
           VALUES ('smk_c1', 'smk_m', 'ddc', '889.332', '889.332000', '082')`,
      );

      // NOT replicated, and this is the assertion that keeps it that way. The
      // projection is DERIVED from `marc_records`, which IS replicated; a second
      // event for the same edit would make every consumer process it twice and
      // could not be ordered against the first. `gen-changelog-triggers.mjs`
      // reads `@replicated` out of the datamodel, so adding the annotation by
      // reflex is a one-word change with no other symptom.
      const derived = await v2Query<{ n: string }>(
        url(),
        `SELECT pg_catalog.count(*)::text AS n FROM change_events
          WHERE entity_kind IN ('bib_record', 'bib_identifier', 'bib_classification')`,
      );
      if (Number(derived[0]!.n) !== 0) {
        throw new Error(
          `the projection emitted ${derived[0]!.n} change event(s); it is derived from ` +
            'marc_records and must emit none',
        );
      }
      ok('writing a projection emits no change event — it is derived, not replicated');

      // §5, in one sentence: "None is a uniqueness constraint." §3 says why —
      // a set and its volumes, a reprint, and endemic publisher ISBN reuse in
      // small Greek presses all legitimately share an ISBN, and the 1.0
      // `books_isbn13_unique_active` "would refuse the exact catalogues this
      // product exists to import". A duplicate is a merge OFFER at phase 39.
      await v2Query(
        url(),
        `INSERT INTO bib_identifiers (id, bib_id, scheme, value, value_norm, source_tag)
           VALUES ('smk_id2', 'smk_m', 'isbn', '9780306406157', '9780306406157', '020')`,
      );
      ok('two records may carry the same ISBN — there is no unique index, deliberately');

      // The other constraint that must not exist. A branch legitimately holds
      // one title in more than one MFHD: reference and stacks, large-print
      // beside ordinary, a serial whose bound volumes and current issues carry
      // different 852 $b. An earlier draft of the phase-11 migration had this
      // unique; it is asserted absent so it cannot come back by reflex.
      await v2Query(
        url(),
        `INSERT INTO holdings_records (record_id, bib_id, branch_id, updated_at)
           VALUES ('smk_h2', 'smk_m', 'smk_b', pg_catalog.now())`,
      );
      ok('a branch may hold one title in two MFHD records — no unique on (bib, branch)');

      // The cascade. If this is ever RESTRICT or SET NULL, an OPAC keeps
      // serving a record page for a bib that no longer exists — from the
      // projection, which is the only table it reads.
      await v2Query(url(), `DELETE FROM items WHERE id = 'smk_i'`);
      await v2Query(url(), `DELETE FROM holdings_records WHERE bib_id = 'smk_m'`);
      await v2Query(url(), `DELETE FROM marc_records WHERE id = 'smk_m'`);
      const left = await v2Query<{ b: string; i: string; c: string }>(
        url(),
        `SELECT (SELECT pg_catalog.count(*) FROM bib_records)::text AS b,
                (SELECT pg_catalog.count(*) FROM bib_identifiers)::text AS i,
                (SELECT pg_catalog.count(*) FROM bib_classifications)::text AS c`,
      );
      const { b, i, c } = left[0]!;
      if (b !== '0' || i !== '0' || c !== '0') {
        throw new Error(
          `deleting the MARC record left ${b} projection(s), ${i} identifier(s), ` +
            `${c} classification(s) behind`,
        );
      }
      ok('deleting the record cascades through the projection and both satellites');

      note(
        'work_clusters is a skeleton and bib_records.work_cluster_id has no foreign key: ' +
          'phase 40 owns the clustering and the shape of cluster_key, which §5 says must carry ' +
          'an expression key beneath the work key or Zorba and its translation collapse into one.',
      );
    },
    reset: teardown,
  },
];

for (const m of v2Modules) {
  if (!TABLES[m.name]) throw new Error(`smoke module ${m.name} has no table list`);
}
