#!/usr/bin/env node
// Generates the changelog triggers from the `/// @replicated` markers in the
// 2.0 datamodel, and prints the SQL.
//
// ## Why triggers, and why generated
//
// §4.2 of the master architecture makes `change_events` the ONE outbox, and
// makes it trigger-written rather than application-emitted. The argument is
// asymmetric: a forgotten `emit()` breaks a replica and the search index
// silently and permanently — the write succeeds, the response is 200, and the
// only symptom is a record that never appears in search — whereas a trigger
// cannot be forgotten by anybody writing a service. It can only be forgotten by
// somebody writing a migration, which is a much smaller surface and is what
// `check:changelog-coverage` watches.
//
// Generated rather than hand-written because 62 tables will eventually carry one
// and they must be identical. A hand-written trigger that differs from its
// neighbours in one table is exactly the defect nobody finds by reading.
//
// ## The output is COMMITTED, not applied
//
// This prints SQL. The SQL is pasted into a migration and committed there, and
// `check:changelog-coverage` compares the `@replicated` markers against THAT
// COMMITTED TEXT — never against this generator's output. That distinction is
// the whole value of the gate: a gate that regenerated the triggers and compared
// them to the markers they were generated from would be comparing a function to
// its own input, and could not fail for any reason.
//
//   node scripts/gen-changelog-triggers.mjs            # print
//   node scripts/gen-changelog-triggers.mjs --check    # exit 1 if any marker is malformed
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const SCHEMA_DIR = path.join(ROOT, 'packages/db-tenant/prisma/schema-v2');

/**
 * The marker, anchored hard.
 *
 * It matches a triple-slash doc line whose entire content is the marker and an
 * `entity_kind=` slug — and nothing looser. Two lines in this
 * datamodel mention `@replicated` in PROSE — `50-fees.prisma` explains why
 * `fees` deliberately has no trigger, and `60-platform.prisma` documents what
 * the `entity_kind` column holds — and a regex that merely searched for the word
 * would generate a trigger on `fees` from the sentence saying it must not have
 * one. Those two lines are kept as a standing test of this anchor.
 */
const MARKER = /^\s*\/\/\/\s*@replicated\s+entity_kind=([a-z][a-z0-9_]*)\s*$/;
const MODEL = /^\s*model\s+([A-Za-z0-9_]+)\s*\{/;
const MAP = /^\s*@@map\("([^"]+)"\)/;
const ID_FIELD = /^\s*([A-Za-z0-9_]+)\s+\S+.*@id\b/;
const FIELD_MAP = /@map\("([^"]+)"\)/;

/** Every model carrying the marker, with the physical facts a trigger needs. */
export function replicatedModels() {
  const found = [];
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma')).sort()) {
    const lines = readFileSync(path.join(SCHEMA_DIR, file), 'utf8').split('\n');
    let pendingKind = null;
    let model = null;

    for (const line of lines) {
      const marker = MARKER.exec(line);
      if (marker) {
        pendingKind = marker[1];
        continue;
      }

      const start = MODEL.exec(line);
      if (start) {
        // A marker only binds to the model it immediately precedes. Anything
        // between them (a blank line is fine; another declaration is not)
        // means the docblock was detached by an edit, and silently attaching
        // it to the next model would put a trigger on the wrong table.
        model = pendingKind
          ? { file, name: start[1], entityKind: pendingKind, pk: null, table: null, hasBranchId: false }
          : null;
        pendingKind = null;
        continue;
      }

      if (!model) continue;

      const id = ID_FIELD.exec(line);
      if (id && !model.pk) {
        const mapped = FIELD_MAP.exec(line);
        model.pk = mapped ? mapped[1] : id[1];
      }
      if (/^\s*branchId\s/.test(line)) model.hasBranchId = true;

      const map = MAP.exec(line);
      if (map) {
        model.table = map[1];
        found.push(model);
        model = null;
      }
    }
  }
  return found.sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * The shared trigger function.
 *
 * Written once and shared by every trigger, so the twelve facts a change event
 * carries are decided in exactly one place.
 *
 * ACTOR. A trigger cannot see who is logged in, so the actor arrives through
 * two session settings that the request-scoped Prisma middleware sets. When they
 * are absent — a psql session, a migration, the nightly sweep — the event is
 * attributed to `system`, which is true. `current_setting(…, true)` is the
 * missing-is-NULL form; without the second argument an unset GUC raises 42704
 * and would abort the librarian's transaction.
 *
 * OP. `archive` and `restore` are distinguished from `update` here rather than
 * left to consumers, because a soft delete is a DISAPPEARANCE to every consumer
 * — the OPAC must drop the record, the index must remove it — and making each
 * replica infer that from an `archived_at` column it would have to know about is
 * the coupling the projection exists to prevent. Tables with no `archived_at`
 * (and `marc_records`, which uses `deleted_at`) simply never emit them.
 *
 * PAYLOAD. `to_jsonb(NEW)` for now, NULL on delete. This is a whole-row
 * projection and is deliberately temporary: §4.3 gives phase 11 a single
 * projection function that serves the indexer, the OPAC record page, the OAI
 * rendition and the report builder, and this is replaced by a call to it. The
 * one thing it must not do meanwhile is omit the payload entirely, because then
 * a consumer would have to read back through the row it is being told about and
 * would race the next write.
 */
function functionSql() {
  return `CREATE OR REPLACE FUNCTION lbr2_write_change_event() RETURNS trigger
  LANGUAGE plpgsql AS $lbr2_changelog$
DECLARE
  v_entity_kind  text := TG_ARGV[0];
  v_pk_column    text := TG_ARGV[1];
  v_has_branch   boolean := TG_ARGV[2]::boolean;
  v_row          jsonb;
  v_op           text;
  v_entity_id    text;
  v_branch_id    text;
  v_payload      jsonb;
  v_archived_col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := pg_catalog.to_jsonb(OLD);
    v_op := 'delete';
    v_payload := NULL;
  ELSE
    v_row := pg_catalog.to_jsonb(NEW);
    v_payload := v_row;
    IF TG_OP = 'INSERT' THEN
      v_op := 'insert';
    ELSE
      v_op := 'update';
      -- A soft delete is a disappearance, not an edit. marc_records spells it
      -- deleted_at; everything else spells it archived_at.
      v_archived_col := CASE WHEN v_row ? 'deleted_at' THEN 'deleted_at' ELSE 'archived_at' END;
      IF v_row ? v_archived_col THEN
        IF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NULL
           AND v_row ->> v_archived_col IS NOT NULL THEN
          v_op := 'archive';
        ELSIF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NOT NULL
           AND v_row ->> v_archived_col IS NULL THEN
          v_op := 'restore';
        END IF;
      END IF;
    END IF;
  END IF;

  v_entity_id := v_row ->> v_pk_column;
  IF v_has_branch THEN
    v_branch_id := v_row ->> 'branch_id';
  END IF;

  INSERT INTO change_events (
    entity_kind, entity_id, op, branch_id, row_version, payload,
    actor_kind, actor_id, device_id
  ) VALUES (
    v_entity_kind,
    v_entity_id,
    v_op,
    v_branch_id,
    pg_catalog.nextval('record_version_seq'),
    v_payload,
    COALESCE(
      pg_catalog.current_setting('libriant.actor_kind', true),
      'system'
    )::audit_actor_kind,
    pg_catalog.current_setting('libriant.actor_id', true),
    pg_catalog.current_setting('libriant.device_id', true)
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$lbr2_changelog$;`;
}

function triggerSql(m) {
  return `CREATE TRIGGER ${m.table}_changelog
  AFTER INSERT OR UPDATE OR DELETE ON ${m.table}
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('${m.entityKind}', '${m.pk}', ${m.hasBranchId});`;
}

export function generate() {
  const models = replicatedModels();
  const problems = [];
  for (const m of models) {
    if (!m.table) problems.push(`${m.file}: model ${m.name} is @replicated but has no @@map.`);
    if (!m.pk) problems.push(`${m.file}: model ${m.name} is @replicated but has no @id field.`);
  }
  return { models, problems, sql: [functionSql(), ...models.map(triggerSql)].join('\n\n') };
}

// -- CLI ---------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { models, problems, sql } = generate();

  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }

  // A generator that can silently emit nothing is a generator that will one day
  // turn the whole feed off — a renamed folder, a changed marker spelling, a bad
  // glob. Refusing is the only safe behaviour, and it is also the anti-vacuity
  // guarantee `check:changelog-coverage` leans on.
  if (models.length === 0) {
    console.error(
      '✗ no @replicated models found in packages/db-tenant/prisma/schema-v2.\n' +
        '    Either the marker spelling changed or the folder moved. Emitting zero triggers\n' +
        '    would silently stop the entire change feed, so this refuses instead.',
    );
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    console.log(`gen-changelog-triggers: ${models.length} replicated model(s), all well-formed.`);
    process.exit(0);
  }

  console.log(sql);
}
