#!/usr/bin/env tsx
// Every replicated model has a change trigger, and every change trigger has a
// replicated model.
//
// ## What breaks without this, in each direction
//
// §4.2 makes `change_events` the ONE outbox and makes it trigger-written. The
// argument for triggers is that a forgotten `emit()` in a service is invisible:
// the write succeeds, the response is 200, and the only symptom is a record that
// never reaches the search index, the OPAC cache or an offline replica — and
// stays missing forever, because nothing retries what nothing recorded.
//
// Moving the emit into a trigger moves that failure from "any developer writing
// a service" to "a developer writing a migration". Much smaller, but not zero,
// and both directions matter:
//
//   MISSING TRIGGER — a model declares itself replicated and nothing writes its
//   events. The silent-desync failure above, unchanged.
//
//   ORPHAN TRIGGER — a trigger writes events for a table nobody declares. A
//   renamed or split table leaves one behind, and it fills the feed with an
//   `entity_kind` no consumer knows, which every consumer must then either
//   ignore (and grow a permanent special case) or choke on.
//
// ## The comparison is DECLARATION vs COMMITTED SQL, and that is the whole point
//
// `scripts/gen-changelog-triggers.mjs` generates the triggers FROM the markers.
// A gate that re-ran the generator and compared its output to the markers would
// be comparing a function to its own input: it would pass for every possible
// state of the repository, including one where somebody deleted a trigger from
// the migration by hand. That is exactly the near-vacuous assertion phase 8
// shipped and had to replace, and the break test for it is in the phase notes:
// hand-edit one `CREATE TRIGGER` out of the committed migration WITHOUT
// re-running the generator, and this must fail.
//
// So: markers on one side, the text of the committed migrations on the other,
// and the generator used for nothing here at all except its parser.
//
// ## What this gate cannot do
//
// It reads committed text. Whether a freshly provisioned library actually HAS
// those triggers is a different question, and it is answered by
// `tenant-schema-census.spec.ts`, which provisions a tenant and reads
// `pg_trigger`. The same argument `books-active-index.spec.ts` already makes for
// indexes: an index that exists in a migration file is not an index a library
// has.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The generator's PARSER only. Its SQL output is deliberately never used here —
// see the header: comparing generated triggers against the markers they were
// generated from is comparing a function to its own input.
import { replicatedModels } from './gen-changelog-triggers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIGRATIONS = path.join(ROOT, 'packages/db-tenant/prisma/migrations-v2');

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/**
 * Below this, assume the gate is broken rather than satisfied.
 *
 * Both directions of a both-directions check agree trivially when both sides are
 * empty, and that is the most convincing-looking vacuous gate there is: remove
 * every marker and a naive implementation reports "0 missing, 0 orphaned" and
 * goes green while the entire change feed is switched off.
 */
const MIN_REPLICATED = 5;

// -- the declaration side ----------------------------------------------------

type ReplicatedModel = {
  file: string;
  name: string;
  entityKind: string;
  table: string | null;
  pk: string | null;
  hasBranchId: boolean;
};

const declared = (replicatedModels as () => ReplicatedModel[])();

// -- the committed side ------------------------------------------------------

if (!existsSync(MIGRATIONS)) {
  console.error(`✗ changelog coverage: ${path.relative(ROOT, MIGRATIONS)} does not exist.`);
  process.exit(1);
}

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((d) => existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
  .sort();
const sql = migrationFiles
  .map((d) => readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'))
  .join('\n');

/**
 * Every `CREATE TRIGGER … _changelog … EXECUTE FUNCTION lbr2_write_change_event(
 * 'kind', 'pk', bool)` actually committed, with its arguments.
 *
 * Arguments are captured, not just the table name, because a trigger pointing at
 * the wrong primary-key column writes NULL entity ids — events that name nothing
 * — and a trigger with the wrong `entity_kind` writes events under a name no
 * consumer subscribes to. Both look exactly like a working trigger from a
 * distance.
 */
type Committed = { table: string; entityKind: string; pk: string; hasBranchId: boolean };
const committed: Committed[] = [];
for (const m of sql.matchAll(
  /CREATE TRIGGER\s+(\w+)_changelog\s+AFTER[\s\S]{0,200}?ON\s+(\w+)[\s\S]{0,200}?EXECUTE FUNCTION\s+lbr2_write_change_event\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/g,
)) {
  const [, namePrefix, table, entityKind, pk, branch] = m as unknown as string[];
  if (namePrefix !== table) {
    fail(
      `the trigger named ${namePrefix}_changelog is declared ON ${table}. The name and the ` +
        'target must agree, or `DROP TRIGGER` in a later migration silently misses.',
    );
  }
  committed.push({
    table: table as string,
    entityKind: entityKind as string,
    pk: pk as string,
    hasBranchId: branch === 'true',
  });
}

// The shared function the triggers all call. A migration that creates triggers
// and not the function they call applies cleanly and fails on the first write.
if (!/CREATE OR REPLACE FUNCTION\s+lbr2_write_change_event\b/.test(sql)) {
  fail(
    'no migration creates `lbr2_write_change_event()`, which every trigger below calls. The ' +
      'triggers would be created successfully and every insert would then fail with 42883.',
  );
}

// -- direction 1: declared, not committed ------------------------------------

for (const model of declared) {
  if (!model.table) {
    fail(`${model.file}: model ${model.name} is @replicated and has no @@map.`);
    continue;
  }
  const match = committed.find((c) => c.table === model.table);
  if (!match) {
    fail(
      `${model.table} is marked \`@replicated entity_kind=${model.entityKind}\` in ` +
        `${model.file} and NO committed migration creates its trigger.\n      ` +
        'Nothing would write its change events: the search index, the OPAC cache and every ' +
        'offline replica would silently never see a row of it, and nothing would ever retry.\n' +
        '      Run `node scripts/gen-changelog-triggers.mjs` and put the output in a migration.',
    );
    continue;
  }
  if (match.entityKind !== model.entityKind) {
    fail(
      `${model.table}: the model declares entity_kind=${model.entityKind} and the committed ` +
        `trigger writes ${match.entityKind}. Consumers subscribe by entity_kind, so the events ` +
        'would arrive under a name nobody is listening for.',
    );
  }
  if (match.pk !== model.pk) {
    fail(
      `${model.table}: the model's primary key is ${model.pk} and the committed trigger reads ` +
        `${match.pk}. Every event would carry a NULL entity_id — an event that names nothing.`,
    );
  }
  if (match.hasBranchId !== model.hasBranchId) {
    fail(
      `${model.table}: branch_id presence disagrees (model ${model.hasBranchId}, trigger ` +
        `${match.hasBranchId}). Branch-scoped consumers would either miss the rows or receive ` +
        "someone else's.",
    );
  }
}

// -- direction 2: committed, not declared ------------------------------------

for (const c of committed) {
  if (declared.some((m) => m.table === c.table)) continue;
  fail(
    `a committed migration creates a changelog trigger on ${c.table}, and no model in ` +
      'prisma/schema-v2 is marked `@replicated` for it.\n      ' +
      'Either the marker was dropped in a rename (and the orphan trigger is now filling the ' +
      `feed with entity_kind='${c.entityKind}' that no consumer knows), or the table was ` +
      'removed and its trigger was not. Both directions of this check exist because an ' +
      'over-broad replication set is exactly as invisible as a missing one.',
  );
}

// -- anti-vacuity ------------------------------------------------------------

if (declared.length < MIN_REPLICATED) {
  fail(
    `only ${declared.length} model(s) are marked @replicated, expected at least ` +
      `${MIN_REPLICATED}.\n      ` +
      'With no markers at all, both directions above agree trivially and this gate reports ' +
      'success while the entire change feed is switched off. That is the failure mode this ' +
      'floor exists for — not a style preference.',
  );
}

// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`✗ changelog coverage: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

console.log(
  `changelog coverage ok — ${declared.length} @replicated model(s) in prisma/schema-v2, ` +
    `${committed.length} committed trigger(s) across ${migrationFiles.length} migration(s); ` +
    'they match in both directions, and entity_kind, primary key and branch scoping agree on ' +
    'every one. Compared against the COMMITTED SQL, not against the generator.',
);
