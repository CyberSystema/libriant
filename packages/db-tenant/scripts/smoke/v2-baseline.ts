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
  'v2-fees': [
    'fees',
    'patron_accounts',
    'account_transactions',
    'account_entries',
    'fee_allocations',
    'cash_drawer_sessions',
    'receipts',
    'receipt_number_counters',
    'ledger_discrepancies',
  ],
  'v2-platform': ['change_events', 'change_consumers', 'sync_client_changes', 'audit_log'],
  'v2-bib-projection': ['bib_records', 'bib_identifiers', 'bib_classifications', 'work_clusters'],
  'v2-patrons': [
    'patron_number_counters',
    'patron_cards',
    'patron_identifiers',
    'patron_addresses',
    'patron_relationships',
    'patron_blocks',
    'patron_messages',
    'patron_notes',
    'patron_merges',
    'reading_history_policy',
  ],
  'v2-items': ['item_status_reasons', 'item_status_history', 'item_transfers', 'item_notes'],
  'v2-circulation-events': ['loan_events', 'circulation_statistics'],
  'v2-holds': ['hold_groups', 'holds'],
  'v2-policy': [
    'calendars',
    'calendar_hours',
    'calendar_exceptions',
    'calendar_exception_hours',
    'loan_policies',
    'overdue_fine_policies',
    'lost_item_fee_policies',
    'hold_policies',
    'hold_policy_pickup_branches',
    'notice_policies',
    'notice_policy_templates',
    'fixed_due_date_sets',
    'fixed_due_date_ranges',
    'patron_categories',
    'patron_category_limits',
    'circulation_rules',
    'circulation_policy_version',
    'circulation_settings',
  ],
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
    } else if (
      table === 'circulation_policy_version' ||
      table === 'circulation_settings' ||
      table === 'reading_history_policy'
    ) {
      // Seeded by the phase-13 migration rather than by an application, and the
      // difference matters: `PolicySnapshotService` treats a missing version row
      // as a REFUSAL by name — not as version 0, which never changes and would
      // pin every pod on a snapshot no bump could invalidate. Creating the rows
      // in the migration makes that state unreachable for every tenant,
      // including the ones phase 19's PL/pgSQL copy-forward creates.
      if (n !== 1) throw new Error(`${table} holds ${n} row(s); it is a singleton`);
      ok(`${table} exists with its one row`);
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
     -- The three NOT NULL columns phase 14 added when it filled the skeleton in.
     -- This seed used to name id and updated_at only, and the smoke test is what
     -- noticed: a table that stops being a skeleton breaks every fixture that
     -- relied on it being one. (No backticks in here -- the whole statement is a
     -- JS template literal, and one would end it mid-comment.)
     INSERT INTO patrons (id, full_name, sort_name, search_text, updated_at)
     VALUES ('smk_p', 'Smoke Patron', 'smoke patron', 'smoke patron', pg_catalog.now());
     -- Phase 18 gave fees.account_id and fees.fee_type_id the foreign keys the
     -- phase-9 model docblock promised them, so a fee can no longer be written
     -- against the strings acc and ft. This seed is what noticed, which is the
     -- smoke suite doing its job: a column that stops being bare text breaks
     -- every fixture that relied on it being bare text.
     --
     -- fee_types is NOT seeded here. The migration ships six system rows and
     -- feetype_overdue is one of them; seeding a seventh here would hide a
     -- migration that had stopped shipping them.
     INSERT INTO patron_accounts (id, patron_id, currency, opened_at)
     VALUES ('smk_acc', 'smk_p', 'EUR', pg_catalog.now());
     INSERT INTO service_points (id, branch_id, code, name, created_at)
     VALUES ('smk_sp', 'smk_b', 'DESK', 'Grafeio', pg_catalog.now());`,
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
              change_consumers, sync_client_changes, bib_records, work_clusters,
              calendars, calendar_hours, calendar_exceptions, calendar_exception_hours,
              loan_policies, overdue_fine_policies, lost_item_fee_policies, hold_policies,
              hold_policy_pickup_branches, notice_policies, notice_policy_templates,
              fixed_due_date_sets, fixed_due_date_ranges, patron_categories,
              patron_category_limits, circulation_rules,
              patron_number_counters, patron_cards, patron_identifiers, patron_addresses,
              patron_relationships, patron_blocks, patron_messages, patron_notes, patron_merges,
              item_status_reasons, item_status_history, item_transfers, item_notes,
              loan_events, circulation_statistics, holds, hold_groups,
              patron_accounts, account_transactions, account_entries, fee_allocations,
              service_points, cash_drawer_sessions, receipts, receipt_number_counters,
              ledger_discrepancies
     RESTART IDENTITY CASCADE`,
  );
  // The two singletons are NOT truncated. They are seeded by the migration
  // rather than by any application, and a smoke run that emptied them would
  // leave the database in the one state `PolicySnapshotService` refuses to serve
  // — and leave the NEXT run failing on a table that is supposed to hold exactly
  // one row. The counter is reset instead, so a re-run starts where a fresh
  // tenant does.
  await v2Query(url(), `UPDATE circulation_policy_version SET version = 1 WHERE id = 1`);
  await v2Query(url(), `UPDATE reading_history_policy SET mode = 'anonymised' WHERE id = 1`);
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
         VALUES ('f1', 'smk_acc', 'smk_p', 'feetype_overdue', 'EUR', 'smk_b', 500, 'overdue', pg_catalog.now())`,
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
         VALUES ('f0', 'smk_acc', 'smk_p', 'feetype_overdue', 'EUR', 'smk_b', 0, 'nothing', pg_catalog.now())`,
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
  {
    name: 'v2-policy',
    describes: 'the rules matrix, the generated specificity, and the version counter',
    async run() {
      await tablesExistAndAreEmpty('v2-policy');

      const version = async () =>
        Number(
          (
            await v2Query<{ v: string }>(
              url(),
              `SELECT version::text AS v FROM circulation_policy_version WHERE id = 1`,
            )
          )[0]!.v,
        );

      await v2Query(
        url(),
        `INSERT INTO loan_policies (id, name, profile, period_value, period_unit, created_at, updated_at)
         VALUES ('smk_lp', 'Standard', 'rolling', 14, 'days', pg_catalog.now(), pg_catalog.now());
         INSERT INTO overdue_fine_policies (id, name, interval_value, interval_unit, amount_per_interval_cents, created_at, updated_at)
         VALUES ('smk_fp', 'Fine', 1, 'days', 20, pg_catalog.now(), pg_catalog.now());
         INSERT INTO lost_item_fee_policies (id, name, aged_to_lost_after_value, aged_to_lost_after_unit, created_at, updated_at)
         VALUES ('smk_lf', 'Lost', 30, 'days', pg_catalog.now(), pg_catalog.now());
         INSERT INTO hold_policies (id, name, hold_shelf_expiry_value, hold_shelf_expiry_unit, created_at, updated_at)
         VALUES ('smk_hp', 'Holds', 7, 'days', pg_catalog.now(), pg_catalog.now());
         INSERT INTO notice_policies (id, name, created_at, updated_at)
         VALUES ('smk_np', 'Notices', pg_catalog.now(), pg_catalog.now())`,
      );

      const afterPolicies = await version();
      if (afterPolicies < 6) {
        throw new Error(`five policy inserts moved the version to ${afterPolicies}, expected 6`);
      }
      ok('every policy write bumps circulation_policy_version, from a trigger');

      await v2Query(
        url(),
        `INSERT INTO circulation_rules (id, name, loan_policy_id, overdue_fine_policy_id,
                                        lost_item_fee_policy_id, hold_policy_id, notice_policy_id,
                                        created_at, updated_at)
         VALUES ('smk_default', 'Library default', 'smk_lp', 'smk_fp', 'smk_lf', 'smk_hp', 'smk_np',
                 pg_catalog.now(), pg_catalog.now())`,
      );
      const spec = await v2Query<{ s: number }>(
        url(),
        `SELECT specificity AS s FROM circulation_rules WHERE id = 'smk_default'`,
      );
      if (spec[0]!.s !== 0) throw new Error(`the wildcard rule has specificity ${spec[0]!.s}`);
      ok('specificity is computed by the database — the tiebreak the whole matrix ranks on');

      await expectSqlstate(
        url(),
        `INSERT INTO circulation_rules (id, name, loan_policy_id, overdue_fine_policy_id,
                                        lost_item_fee_policy_id, hold_policy_id, notice_policy_id,
                                        created_at, updated_at)
         VALUES ('smk_second', 'Another default', 'smk_lp', 'smk_fp', 'smk_lf', 'smk_hp', 'smk_np',
                 pg_catalog.now(), pg_catalog.now())`,
        '23505',
        'a library may have exactly one default rule',
      );

      await expectSqlstate(
        url(),
        `DELETE FROM loan_policies WHERE id = 'smk_lp'`,
        '23503',
        'a policy a rule still names cannot be deleted',
      );

      await expectSqlstate(
        url(),
        `INSERT INTO loan_policies (id, name, profile, period_value, created_at, updated_at)
         VALUES ('smk_bad', 'No unit', 'rolling', 14, pg_catalog.now(), pg_catalog.now())`,
        '23514',
        'a duration value without its unit is refused — an unknown unit is priced as DAYS',
      );

      const before0 = await version();
      await v2Query(url(), `UPDATE circulation_rules SET priority = 0 WHERE id = 'no-such-rule'`);
      if ((await version()) !== before0 + 1) {
        throw new Error('a statement affecting no rows did not bump the version');
      }
      note(
        'a zero-row UPDATE bumps the version too. Deliberate over-invalidation: the correctness ' +
          'requirement is one-directional — a different policy state MUST get a different ' +
          'version, while a spurious bump costs one snapshot rebuild.',
      );

      await v2Query(
        url(),
        `INSERT INTO calendars (id, code, name, defined_from, defined_to, created_at, updated_at)
         VALUES ('smk_cal', 'MAIN', 'Main', DATE '2026-01-01', DATE '2028-12-31',
                 pg_catalog.now(), pg_catalog.now());
         INSERT INTO calendar_hours (id, calendar_id, weekday, open_min, close_min)
         VALUES ('smk_h1', 'smk_cal', 1, 480, 840), ('smk_h2', 'smk_cal', 1, 1020, 1260)`,
      );
      ok('the Greek split day fits: 08:00-14:00 and 17:00-21:00 on one weekday');

      await expectSqlstate(
        url(),
        `INSERT INTO calendar_hours (id, calendar_id, weekday, open_min, close_min)
         VALUES ('smk_h3', 'smk_cal', 1, 800, 900)`,
        '23P01',
        'overlapping opening hours are refused — "open until" must not depend on row order',
      );
    },
    reset: teardown,
  },
  {
    name: 'v2-patrons',
    describes: 'the one-hop merge invariant and the block upsert that lets a desk survive a sweep',
    async run() {
      await tablesExistAndAreEmpty('v2-patrons');
      await seedMinimalChain();

      const mk = (id: string, name: string) =>
        v2Query(
          url(),
          `INSERT INTO patrons (id, full_name, sort_name, search_text, created_at, updated_at)
           VALUES ('${id}', '${name}', '${name.toLowerCase()}', '${name.toLowerCase()}',
                   pg_catalog.now(), pg_catalog.now())`,
        );
      await mk('smk_pa', 'A');
      await mk('smk_pb', 'B');
      await mk('smk_pc', 'C');

      await v2Query(url(), `UPDATE patrons SET merged_into_id = 'smk_pa' WHERE id = 'smk_pb'`);
      ok('a plain merge is accepted');

      await expectSqlstate(
        url(),
        `UPDATE patrons SET merged_into_id = 'smk_pc' WHERE id = 'smk_pa'`,
        '23514',
        'a merge that would leave B pointing at a merged-away A is REFUSED at commit',
      );

      // The legal form: both statements, one transaction, judged together by the
      // deferred trigger. Order does not matter, which is the point of deferral.
      await v2Query(
        url(),
        `BEGIN;
         UPDATE patrons SET merged_into_id = 'smk_pc' WHERE id = 'smk_pa';
         UPDATE patrons SET merged_into_id = 'smk_pc' WHERE merged_into_id = 'smk_pa' AND id <> 'smk_pc';
         COMMIT`,
      );
      const chain = await v2Query<{ into: string | null }>(
        url(),
        `SELECT merged_into_id AS into FROM patrons WHERE id = 'smk_pb'`,
      );
      if (chain[0]!.into !== 'smk_pc') {
        throw new Error(`B points at ${chain[0]!.into}, not at the survivor`);
      }
      ok('re-pointing the stranded row in the same transaction is accepted — one hop, always');

      await expectSqlstate(
        url(),
        `UPDATE patrons SET merged_into_id = id WHERE id = 'smk_pc'`,
        '23514',
        'a record cannot be merged into itself',
      );

      // The block upsert, with the exact ON CONFLICT the service issues.
      const upsert = (reason: string) =>
        v2Query(
          url(),
          `INSERT INTO patron_blocks
             (id, patron_id, code, reason, auto_generated, observed, severity, placed_at)
           VALUES (pg_catalog.gen_random_uuid()::text, 'smk_pc', 'too_many_overdues', '${reason}',
                   true, '{}'::jsonb, 'block', pg_catalog.now())
           ON CONFLICT (patron_id, code) WHERE auto_generated AND cleared_at IS NULL
           DO UPDATE SET reason = EXCLUDED.reason`,
        );
      await upsert('first');
      await upsert('second');
      const blocks = await v2Query<{ n: string; reason: string }>(
        url(),
        `SELECT pg_catalog.count(*)::text AS n, pg_catalog.max(reason) AS reason
           FROM patron_blocks WHERE patron_id = 'smk_pc' AND auto_generated AND cleared_at IS NULL`,
      );
      if (blocks[0]!.n !== '1' || blocks[0]!.reason !== 'second') {
        throw new Error(
          `the recompute produced ${blocks[0]!.n} row(s), reason ${blocks[0]!.reason}`,
        );
      }
      ok('a repeated recompute UPDATES the one row rather than duplicating or failing');

      await expectSqlstate(
        url(),
        `INSERT INTO patron_blocks (id, patron_id, code, auto_generated, severity, placed_at)
         VALUES ('smk_b_bad', 'smk_pc', 'too_many_overdues', true, 'block', pg_catalog.now())`,
        '23505',
        'a second live auto block on the same code is refused by the partial unique',
      );

      await v2Query(
        url(),
        `INSERT INTO patron_blocks (id, patron_id, code, reason, auto_generated, severity, placed_at)
         VALUES ('smk_b_man', 'smk_pc', 'too_many_overdues', 'librarian said so', false, 'block',
                 pg_catalog.now())`,
      );
      note(
        'a MANUAL block coexists with the auto one on the same code: the partial unique is scoped ' +
          "to auto_generated, so a sweep structurally cannot clobber a librarian's decision.",
      );

      await expectSqlstate(
        url(),
        `INSERT INTO patron_blocks (id, patron_id, code, auto_generated, severity, placed_at)
         VALUES ('smk_b_nr', 'smk_pc', 'manual', false, 'block', pg_catalog.now())`,
        '23514',
        'a manual block with no reason is refused — nobody could review it',
      );

      await v2Query(
        url(),
        `INSERT INTO patron_cards (id, patron_id, barcode, barcode_norm, issued_at, created_at, updated_at)
         VALUES ('smk_c1', 'smk_pc', 'CARD-1', 'CARD-1', pg_catalog.now(), pg_catalog.now(), pg_catalog.now())`,
      );
      await expectSqlstate(
        url(),
        `INSERT INTO patron_cards (id, patron_id, barcode, barcode_norm, issued_at, created_at, updated_at)
         VALUES ('smk_c2', 'smk_pa', 'CARD-1', 'CARD-1', pg_catalog.now(), pg_catalog.now(), pg_catalog.now())`,
        '23505',
        'one live card per barcode, library-wide — a barcode that resolves to two people is a loan charged to the wrong one',
      );

      const idx = await v2Query<{ def: string }>(
        url(),
        `SELECT indexdef AS def FROM pg_catalog.pg_indexes
          WHERE schemaname = 'lbr2' AND indexname = 'patrons_number_pattern_idx'`,
      );
      if (!idx[0]?.def.includes('text_pattern_ops')) {
        throw new Error('patrons_number_pattern_idx is not a text_pattern_ops index');
      }
      if (idx[0].def.includes('WHERE')) {
        throw new Error(
          'patrons_number_pattern_idx is partial; the counter seed needs archived rows',
        );
      }
      ok('patrons_number_pattern_idx is text_pattern_ops and not partial (perf-13)');
    },
    reset: teardown,
  },
  {
    name: 'v2-items',
    describes: 'the one open transfer per copy, the default holdings claim, and an honest history',
    async run() {
      await tablesExistAndAreEmpty('v2-items');
      await seedMinimalChain();
      await v2Query(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('smk_b2', 'SMOKE2', 'Δεύτερο', 'Europe/Athens', pg_catalog.now())`,
      );

      // ---- the default holdings claim, and the freedom it must not take away
      await expectSqlstate(
        url(),
        `INSERT INTO holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
         VALUES ('smk_h2', 'smk_m', 'smk_b', true, pg_catalog.now()),
                ('smk_h3', 'smk_m', 'smk_b', true, pg_catalog.now())`,
        '23505',
        'a branch cannot hold two AUTO-CREATED DEFAULT holdings records for one title',
      );
      await v2Query(
        url(),
        `INSERT INTO holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
         VALUES ('smk_h2', 'smk_m', 'smk_b', false, pg_catalog.now()),
                ('smk_h3', 'smk_m', 'smk_b', false, pg_catalog.now())`,
      );
      note(
        'and it may still hold as many NON-default ones as it likes — reference and stacks, ' +
          'large-print beside ordinary. That is the freedom phase 11 refused a (bib, branch) ' +
          'unique to protect, and `is_default DEFAULT false` is what preserves it.',
      );

      // ---- open is the absence of both endings
      await v2Query(
        url(),
        `INSERT INTO item_transfers (id, item_id, from_branch_id, to_branch_id, updated_at)
         VALUES ('smk_t1', 'smk_i', 'smk_b', 'smk_b2', pg_catalog.now())`,
      );
      await expectSqlstate(
        url(),
        `INSERT INTO item_transfers (id, item_id, from_branch_id, to_branch_id, updated_at)
         VALUES ('smk_t2', 'smk_i', 'smk_b', 'smk_b2', pg_catalog.now())`,
        '23505',
        'a copy cannot have two open transfers',
      );
      await expectSqlstate(
        url(),
        `UPDATE item_transfers
            SET received_at = pg_catalog.now(), cancelled_at = pg_catalog.now()
          WHERE id = 'smk_t1'`,
        '23514',
        'a transfer cannot be both received and cancelled — the partial unique depends on it',
      );
      await v2Query(
        url(),
        `UPDATE item_transfers SET received_at = pg_catalog.now() WHERE id = 'smk_t1'`,
      );
      await v2Query(
        url(),
        `INSERT INTO item_transfers (id, item_id, from_branch_id, to_branch_id, updated_at)
         VALUES ('smk_t2', 'smk_i', 'smk_b2', 'smk_b', pg_catalog.now())`,
      );
      ok('closing one frees the copy for the next — the index is keyed on the two NULL tests');

      await expectSqlstate(
        url(),
        `INSERT INTO item_transfers (id, item_id, from_branch_id, to_branch_id, updated_at)
         VALUES ('smk_t3', 'smk_i', 'smk_b', 'smk_b', pg_catalog.now())`,
        '23514',
        'a transfer to the branch the copy is already at is not a transfer',
      );

      // ---- a history that says nothing happened is not a history
      await v2Query(
        url(),
        `INSERT INTO item_status_history (id, item_id, from_status, to_status)
         VALUES ('smk_sh1', 'smk_i', NULL, 'available')`,
      );
      note('the creation row is the one row with no from_status, and it is accepted');
      await expectSqlstate(
        url(),
        `INSERT INTO item_status_history (id, item_id, from_status, to_status)
         VALUES ('smk_sh2', 'smk_i', 'available', 'available')`,
        '23514',
        'a history row that records no change is refused',
      );
      await v2Query(
        url(),
        `INSERT INTO item_status_history
           (id, item_id, from_status, to_status, from_branch_id, to_branch_id)
         VALUES ('smk_sh3', 'smk_i', 'available', 'available', 'smk_b', 'smk_b2')`,
      );
      note(
        'a branch move with no status move IS a change — which is what a float is, and what a ' +
          'history keyed only on status would answer wrongly.',
      );

      const cols = await v2Query<{ n: string }>(
        url(),
        `SELECT pg_catalog.count(*)::text AS n
           FROM information_schema.columns
          WHERE table_schema = 'lbr2' AND table_name = 'item_status_history'
            AND column_name IN ('updated_at', 'archived_at')`,
      );
      if (cols[0]!.n !== '0') {
        throw new Error(
          'item_status_history has updated_at or archived_at; it must be append-only',
        );
      }
      ok('item_status_history is append-only — no updated_at, no archived_at');
    },
    reset: teardown,
  },
  {
    name: 'v2-circulation-events',
    describes: 'the two instants, the partitioned rollup, and the three change-feed columns',
    async run() {
      await tablesExistAndAreEmpty('v2-circulation-events');
      await seedMinimalChain();
      await v2Query(url(), `INSERT INTO loans (${LOAN_COLUMNS}) VALUES (${loanValues('l1')})`);

      // ---- occurred_at and effective_at, which is the phase line -----------
      await expectSqlstate(
        url(),
        `INSERT INTO loan_events (id, loan_id, kind, occurred_at, effective_at, branch_id)
         VALUES ('e_future', 'l1', 'checked_out', pg_catalog.now(),
                 pg_catalog.now() + interval '1 hour', 'smk_b')`,
        '23514',
        'an event cannot have happened after Postgres learned of it — the service clamps',
      );
      await v2Query(
        url(),
        `INSERT INTO loan_events (id, loan_id, kind, occurred_at, effective_at, branch_id)
         VALUES ('e_back', 'l1', 'checked_out', pg_catalog.now(),
                 pg_catalog.now() - interval '3 days', 'smk_b')`,
      );
      note(
        'but a BACKDATED one is accepted, and that is the whole point of the pair: a wand that ' +
          'synced on Monday a checkout it took on Friday, and a Saturday book drop opened on ' +
          'Monday. accrueOverdue is fed effective_at, or it charges three days nobody owes.',
      );

      // ---- money on an event: paired, non-negative, and not both ----------
      await expectSqlstate(
        url(),
        `INSERT INTO loan_events (id, loan_id, kind, effective_at, branch_id, overdue_cents)
         VALUES ('e_nc', 'l1', 'returned', pg_catalog.now(), 'smk_b', 250)`,
        '23514',
        'an amount without a currency is refused',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO loan_events
           (id, loan_id, kind, effective_at, branch_id, overdue_cents, currency, fine_error_code)
         VALUES ('e_both', 'l1', 'returned', pg_catalog.now(), 'smk_b', 250, 'EUR', 'CAL')`,
        '23514',
        'a computed fine AND a refusal to compute one are exclusive — phase 18 must be able to ' +
          'tell "nothing was owed" from "we could not work out what was owed"',
      );

      // ---- the partitioned rollup -----------------------------------------
      await expectSqlstate(
        url(),
        `INSERT INTO circulation_statistics
           (period_start, branch_id, item_type_id, patron_category_id)
         VALUES (pg_catalog.date_trunc('month', pg_catalog.now())::date + 5, 'smk_b', 'smk_it', 'pc')`,
        '23514',
        'a rollup row must be the first of a month',
      );
      await expectSqlstate(
        url(),
        `INSERT INTO circulation_statistics
           (period_start, branch_id, item_type_id, patron_category_id)
         VALUES (pg_catalog.date_trunc('month', pg_catalog.now() + interval '40 months')::date,
                 'smk_b', 'smk_it', 'pc')`,
        '23514',
        'a period past the window fails LOUDLY — there is no DEFAULT partition, deliberately',
      );
      const parts = await v2Query<{ n: string }>(
        url(),
        `SELECT pg_catalog.count(*)::text AS n
           FROM pg_catalog.pg_inherits i
           JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
          WHERE p.relname = 'circulation_statistics'`,
      );
      if (Number(parts[0]!.n) < 27) {
        throw new Error(`circulation_statistics has ${parts[0]!.n} partition(s), expected 27`);
      }
      ok('circulation_statistics is partitioned monthly, 27 partitions, same window as audit_log');

      // ---- the three change-feed columns that had no writer ---------------
      await v2Query(
        url(),
        `BEGIN;
         SELECT pg_catalog.set_config('libriant.actor_kind', 'device', true),
                pg_catalog.set_config('libriant.actor_id', 'u1', true),
                pg_catalog.set_config('libriant.device_id', 'dev-1', true),
                pg_catalog.set_config('libriant.client_change_id',
                                      '1e4f8a3c-0000-4000-8000-000000000001', true);
         INSERT INTO item_types (id, code, name, updated_at)
         VALUES ('smk_it2', 'DVD', 'DVD', pg_catalog.now());
         COMMIT`,
      );
      const fed = await v2Query<{ cci: string | null; xmin_set: boolean }>(
        url(),
        `SELECT client_change_id::text AS cci, (commit_xmin IS NOT NULL) AS xmin_set
           FROM change_events WHERE entity_id = 'smk_it2'`,
      );
      if (fed[0]?.cci !== '1e4f8a3c-0000-4000-8000-000000000001' || fed[0]?.xmin_set !== true) {
        throw new Error(
          `change_events did not record the client change id and commit xmin: ` +
            `${JSON.stringify(fed[0])}`,
        );
      }
      ok(
        'change_events records client_change_id and commit_xmin — created in phase 9, filled here',
      );

      const watermark = await v2Query<{ n: string }>(
        url(),
        `SELECT pg_catalog.count(*)::text AS n FROM change_events
          WHERE commit_xmin < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())`,
      );
      if (Number(watermark[0]!.n) === 0) {
        throw new Error('the §4.2 commit-watermark read returns nothing; commit_xmin is unusable');
      }
      note(
        '§4.2 reads the feed "with a commit watermark (row_version < pg_snapshot_xmin(...)) so ' +
          'no late-committing transaction is skipped". That read was impossible against a NULL ' +
          'column, and change_events is append-only — so no later phase could have backfilled it.',
      );

      // An unattributed write on the same backend must still land as `system`
      // rather than raising 22P02 on the new uuid cast: an unset custom GUC is
      // '' and not NULL after the first set_config on that backend.
      await v2Query(
        url(),
        `INSERT INTO material_types (id, code, name, updated_at)
         VALUES ('smk_mt2', 'CD', 'CD', pg_catalog.now())`,
      );
      const plain = await v2Query<{ kind: string; cci: string | null }>(
        url(),
        `SELECT actor_kind AS kind, client_change_id::text AS cci
           FROM change_events WHERE entity_id = 'smk_mt2'`,
      );
      if (plain[0]?.kind !== 'system' || plain[0]?.cci !== null) {
        throw new Error(`an unattributed write landed as ${JSON.stringify(plain[0])}`);
      }
      ok('an unattributed write still lands as system, and NULLIF saves the uuid cast from 22P02');
    },
    reset: teardown,
  },
  {
    name: 'v2-holds',
    describes: 'the queue, and the constraint that makes the 1.0 decrement abort',
    async run() {
      await tablesExistAndAreEmpty('v2-holds');
      await seedMinimalChain();
      await v2Query(
        url(),
        `INSERT INTO patrons (id, full_name, sort_name, search_text, updated_at)
         SELECT 'smk_p' || g, 'Reader ' || g, 'reader ' || g, 'reader ' || g, pg_catalog.now()
           FROM pg_catalog.generate_series(1, 5) AS g`,
      );

      // `hold_policy_id` and `applied_rule_id` carry NO foreign key, deliberately
      // and identically to `loans`: a request must keep naming the policy that
      // priced it after that policy is archived, and ON DELETE RESTRICT would
      // make a policy un-retirable for as long as any historical request named
      // it. So a literal is a valid value here, and the smoke test needs no
      // policy matrix to exercise the queue.
      const hold = (id: string, patron: string, pos: string) =>
        `INSERT INTO holds (id, bib_id, patron_id, pickup_branch_id, queue_position,
                            hold_policy_id, applied_rule_id, policy_snapshot,
                            created_at, updated_at)
         VALUES ('${id}', 'smk_m', '${patron}', 'smk_b', ${pos},
                 'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now())`;

      // ---- one reader, one live request per record ------------------------
      await v2Query(url(), hold('smk_q1', 'smk_p1', '1'));
      await expectSqlstate(
        url(),
        hold('smk_dup', 'smk_p1', '9'),
        '23505',
        'a reader cannot join the same queue twice — a double-click is a mistake at a desk, ' +
          'not a second place in line',
      );
      await expectSqlstate(
        url(),
        hold('smk_dup', 'smk_p2', '1'),
        '23505',
        'two readers cannot share a slot',
      );

      // ---- a position exists exactly while a request is WAITING -----------
      await expectSqlstate(
        url(),
        `UPDATE holds SET assigned_item_id = 'smk_i', assigned_at = pg_catalog.now()
          WHERE id = 'smk_q1'`,
        '23514',
        'a request given a copy has left the queue and must drop its position',
      );
      await expectSqlstate(
        url(),
        `UPDATE holds SET awaiting_pickup_since = pg_catalog.now() WHERE id = 'smk_q1'`,
        '23514',
        'a request cannot be collectable without a copy on the shelf for it',
      );
      await expectSqlstate(
        url(),
        `UPDATE holds SET fulfilled_at = pg_catalog.now(), fulfilled_by_loan_id = 'l',
                          cancelled_at = pg_catalog.now(), queue_position = NULL
          WHERE id = 'smk_q1'`,
        '23514',
        'a request has exactly one ending, or none — the partial uniques depend on it',
      );

      // ---- a level carries the thing it names -----------------------------
      await expectSqlstate(
        url(),
        `INSERT INTO holds (id, bib_id, patron_id, pickup_branch_id, queue_position, level,
                            hold_policy_id, applied_rule_id, policy_snapshot, created_at, updated_at)
         VALUES ('smk_lv', 'smk_m', 'smk_p2', 'smk_b', 2, 'item',
                 'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now())`,
        '23514',
        'an item-level request with no copy named would be silently treated as a title request ' +
          'by the promoter, and hand a reader the wrong physical thing',
      );

      // ---- a copy goes to ONE reader --------------------------------------
      await v2Query(
        url(),
        `UPDATE holds SET assigned_item_id = 'smk_i', assigned_at = pg_catalog.now(),
                          queue_position = NULL
          WHERE id = 'smk_q1'`,
      );
      await expectSqlstate(
        url(),
        `INSERT INTO holds (id, bib_id, patron_id, pickup_branch_id, assigned_item_id, assigned_at,
                            hold_policy_id, applied_rule_id, policy_snapshot, created_at, updated_at)
         VALUES ('smk_q2', 'smk_m', 'smk_p2', 'smk_b', 'smk_i', pg_catalog.now(),
                 'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now())`,
        '23505',
        'a double-assigned copy is impossible — §3 asks for exactly this index by name',
      );

      // ---- THE PHASE, in one statement ------------------------------------
      //
      // Five requests, #1 SUSPENDED, #2 filled. The 1.0 blanket decrement is
      // correct only because the head always leaves; the moment a suspended
      // request can be skipped, the request that leaves is not the head.
      await v2Query(url(), `DELETE FROM holds`);
      await v2Query(
        url(),
        `INSERT INTO holds (id, bib_id, patron_id, pickup_branch_id, queue_position,
                            suspended_until, hold_policy_id, applied_rule_id, policy_snapshot,
                            created_at, updated_at)
         SELECT 'smk_h' || g, 'smk_m', 'smk_p' || g, 'smk_b', g,
                CASE WHEN g = 1 THEN (pg_catalog.now() + interval '30 days')::date END,
                'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
           FROM pg_catalog.generate_series(1, 5) AS g`,
      );
      await v2Query(
        url(),
        `UPDATE holds SET assigned_item_id = 'smk_i', assigned_at = pg_catalog.now(),
                          queue_position = NULL
          WHERE id = 'smk_h2'`,
      );
      await expectSqlstate(
        url(),
        `UPDATE holds SET queue_position = queue_position - 1
          WHERE bib_id = 'smk_m' AND queue_position IS NOT NULL AND queue_position > 0`,
        '23514',
        'THE 1.0 BLANKET DECREMENT ABORTS. It would put the suspended request at position 0, ' +
          'and holds_position_is_one_based turns that from a wrong number into a refusal',
      );
      await v2Query(
        url(),
        `UPDATE holds SET queue_position = queue_position - 1
          WHERE bib_id = 'smk_m' AND queue_position IS NOT NULL AND queue_position > 2`,
      );
      const after = await v2Query<{ id: string; queue_position: number }>(
        url(),
        `SELECT id, queue_position FROM holds
          WHERE queue_position IS NOT NULL ORDER BY queue_position`,
      );
      const shape = after.map((r) => `${r.id}=${r.queue_position}`).join(' ');
      if (shape !== 'smk_h1=1 smk_h3=2 smk_h4=3 smk_h5=4') {
        throw new Error(`the targeted rebalance produced ${shape}`);
      }
      ok(
        'the TARGETED rebalance leaves 1,2,3,4 — contiguous, 1-based, and the suspended reader ' +
          'keeps the place they never gave up',
      );

      // ---- the foreign key phase 15 promised ------------------------------
      await v2Query(
        url(),
        `INSERT INTO branches (id, code, name, timezone, updated_at)
         VALUES ('smk_b2', 'SMOKE2', 'Δεύτερο', 'Europe/Athens', pg_catalog.now())`,
      );
      await v2Query(
        url(),
        `INSERT INTO item_transfers (id, item_id, from_branch_id, to_branch_id, hold_id, updated_at)
         VALUES ('smk_th', 'smk_i', 'smk_b', 'smk_b2', 'smk_h3', pg_catalog.now())`,
      );
      await expectSqlstate(
        url(),
        `DELETE FROM holds WHERE id = 'smk_h3'`,
        '23503',
        'a request a copy is travelling for cannot be deleted out from under the van — phase 15 ' +
          'wrote "no FK: holds is phase 17", and this is phase 17 paying it',
      );
    },
    reset: teardown,
  },
];

for (const m of v2Modules) {
  if (!TABLES[m.name]) throw new Error(`smoke module ${m.name} has no table list`);
}
