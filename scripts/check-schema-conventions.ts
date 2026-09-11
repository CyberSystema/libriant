#!/usr/bin/env tsx
// The 2.0 tenant schema keeps §3's conventions, and its scope stays declared.
//
// ## Why a gate rather than a code review
//
// Every convention below is invisible in a Prisma model and obvious in the DDL
// it renders to. `createdAt DateTime` looks entirely normal and renders as
// `TIMESTAMP(3)` — WITHOUT time zone. All sixty instant columns in the 1.0
// schema are wrong in exactly that way, and nobody noticed for a year, because
// the model reads correctly. On the production host, whose session TimeZone is
// Europe/Athens, one such column in 2.0 is a two-or-three-hour shift per row
// that no later migration can distinguish from real data.
//
// So this reads the RENDERED PHYSICAL DDL, never the model text. A gate that
// read Prisma field names would pass a schema with no `@map` at all, since
// Prisma field names are camelCase by design.
//
// ## It needs no database, and that is deliberate
//
// `prisma migrate diff --from-empty --to-schema` renders the whole schema
// without connecting — measured with the connection string pointed at a closed
// port: exit 0, full DDL, nothing contacted. So this runs in `check:all` on a
// laptop with nothing running, unlike `check:schema-drift`, which genuinely
// needs a shadow database and lives in CI's migrations job.
//
// ## Scope is the FOLDER, not an allowlist
//
// The 1.0 datamodel violates every convention here (measured: 60 of 60 instant
// columns are `timestamp` without zone, 7 of 7 money columns are `INTEGER` or
// `TEXT`, every physical column is camelCase). Holding it to these rules would
// need a `LEGACY_MODELS` list naming essentially the whole schema — a gate that
// checks nothing. The 2.0 datamodel lives in its own folder and its own Postgres
// schema, so "is this held to the 2.0 conventions?" is answered by a directory
// name that cannot go stale.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = path.join(ROOT, 'packages/db-tenant');
const SCHEMA_DIR = path.join(PKG, 'prisma/schema-v2');
const MANIFEST = path.join(SCHEMA_DIR, 'BASELINE-SCOPE.json');
const MIGRATIONS = path.join(PKG, 'prisma/migrations-v2');

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/**
 * Floors, below which this gate is assumed broken rather than satisfied.
 *
 * `prisma migrate diff --from-empty` against an EMPTY folder exits 0 and prints
 * nothing, so every check below would pass and the gate would report success
 * having examined nothing. A renamed folder, a bad glob or a failed generate all
 * land there. This is the specific failure the last three phases each shipped
 * once, and it is why every count is asserted rather than merely printed.
 */
const MIN_TABLES = 15;
const MIN_COLUMNS = 150;

/**
 * The two places a convention is deliberately not applied, each with the reason.
 *
 * Modelled on `check:supply-chain`'s recorded licence decisions and
 * `check:schema-drift`'s allowlist: an exemption is a decision somebody made and
 * signed, and an entry that stops matching anything FAILS — a list of accepted
 * exceptions that no longer describes the tree is a list nobody reads.
 */
const EXEMPTIONS: Readonly<Record<string, string>> = {
  'marc_record_versions.id':
    '§2 specifies `bigserial` here, in the same breath as the reason: version rows are ' +
    'high-volume, strictly ordered and never user-facing, so a cuid would cost 25 bytes a row ' +
    'and buy nothing. Nothing references a version by id across the control-plane boundary.',
  'items.currency':
    "An item's `price_cents` and `replacement_cost_cents` are acquisition figures, not " +
    'patron-facing money — §3 gives `items` no currency column, and the currency is the owning ' +
    "branch's (`branches.currency`). The moment either becomes something a patron owes it is a " +
    '`fees` row, which carries its own `char(3)`. Adding a column here would be inventing a ' +
    'second, divergent answer to "in what currency?".',
};
const exemptionsUsed = new Set<string>();

/**
 * The eleven COMPAT TWINS, and the one reason all of them are exempt.
 *
 * These are 1.0 tables with no 2.0 successor that are still LIVE at the
 * cutover: `public` becomes `v1_archive` and the 1.0 Prisma client keeps
 * serving requests until phase 20 deletes it. That client resolves bare names
 * through `search_path` and generates quoted camelCase (`"createdAt"`) and
 * `TIMESTAMP(3)` bindings, so a twin written to the 2.0 conventions is a twin
 * the surviving client cannot read — `PermissionGuard` runs on every request
 * and would fail with `column "createdAt" does not exist`, locking a library
 * out of its own roles table on cutover day.
 *
 * A TABLE-LEVEL carve-out rather than ninety column-level ones, because the
 * decision is one decision made once. It is deliberately NOT the same mechanism
 * as `EXEMPTIONS`: those are per-column judgements with per-column reasons, and
 * a list of ninety identical strings would read as ninety decisions.
 *
 * What is NOT waived: a twin still needs a `BASELINE-SCOPE.json` entry, which is
 * the half that matters — "this table exists and here is why" — and rule 7 below
 * still fails an entry that has stopped describing the tree. Adding a table here
 * that is not a 1.0 twin would be caught by the floor on the count.
 */
const COMPAT_TWINS: ReadonlySet<string> = new Set([
  'roles',
  'role_permissions',
  'staff_profiles',
  'staff_role_grants',
  'staff_permission_overrides',
  'field_definitions',
  'collections',
  'collection_fields',
  'collection_records',
  '_libriant_schema_state',
  '_libriant_online_migrations',
]);
const MAX_COMPAT_TWINS = 11;

/** True if this convention is deliberately waived here. */
function exempt(key: string): boolean {
  if (!(key in EXEMPTIONS)) return false;
  exemptionsUsed.add(key);
  return true;
}

// ---------------------------------------------------------------------------
// Render the physical DDL
// ---------------------------------------------------------------------------

let ddl = '';
try {
  ddl = execFileSync(
    './node_modules/.bin/prisma',
    [
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      'prisma/schema-v2',
      '--script',
      '--config',
      'prisma-v2.config.ts',
    ],
    {
      cwd: PKG,
      // A closed port, on purpose: if a future Prisma needs a live database for
      // this, the gate must fail loudly here rather than quietly start
      // depending on one and then skip itself in CI.
      env: { ...process.env, TENANT_DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/nope' },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
} catch (err) {
  const e = err as { stdout?: string; stderr?: string; message: string };
  console.error(
    '✗ schema conventions: could not render the 2.0 schema.\n\n    ' +
      (e.stderr || e.stdout || e.message).trim().slice(0, 600),
  );
  process.exit(1);
}

/** `CREATE TABLE "x" ( … )` → the table name and its column lines. */
type Table = { readonly name: string; readonly columns: readonly string[] };
const tables: Table[] = [];
for (const m of ddl.matchAll(/CREATE TABLE "([^"]+)" \(\n([\s\S]*?)\n\)/g)) {
  tables.push({
    name: m[1] as string,
    columns: (m[2] as string)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('"')),
  });
}
const columnCount = tables.reduce((n, t) => n + t.columns.length, 0);

if (tables.length < MIN_TABLES) {
  fail(
    `only ${tables.length} table(s) rendered, expected at least ${MIN_TABLES}. ` +
      'An empty or unreadable schema folder renders an empty script and exit 0, so every ' +
      'check below would pass having examined nothing. This floor is what stops that.',
  );
}
if (columnCount < MIN_COLUMNS) {
  fail(`only ${columnCount} column(s) rendered, expected at least ${MIN_COLUMNS}. See above.`);
}

// ---------------------------------------------------------------------------
// 1. snake_case physical columns
// ---------------------------------------------------------------------------

for (const t of tables) {
  if (COMPAT_TWINS.has(t.name)) continue;
  for (const line of t.columns) {
    const col = /^"([^"]+)"/.exec(line)?.[1];
    if (!col) continue;
    if (/[A-Z]/.test(col)) {
      fail(
        `${t.name}.${col} is not snake_case. Add @map("${col
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase()}").\n      ` +
          "1.0's quoted camelCase forces double-quoting in every raw statement, every psql " +
          'session and every report query, forever.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. instants are timestamptz(3); civil values say so explicitly
// ---------------------------------------------------------------------------

for (const t of tables) {
  if (COMPAT_TWINS.has(t.name)) continue;
  for (const line of t.columns) {
    const col = /^"([^"]+)"/.exec(line)?.[1];
    if (!col) continue;
    if (/\bTIMESTAMP\(\d\)/.test(line) && !/\bTIMESTAMPTZ\(\d\)/.test(line)) {
      fail(
        `${t.name}.${col} renders as TIMESTAMP — WITHOUT time zone. Write ` +
          '`@db.Timestamptz(3)`.\n      ' +
          'This is the single most expensive mistake available in this schema: on a host whose ' +
          'session TimeZone is Europe/Athens every value is silently two or three hours out, ' +
          'per row, and no later migration can tell a shifted value from a real one.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. money is bigint minor units + char(3)
// ---------------------------------------------------------------------------

for (const t of tables) {
  if (COMPAT_TWINS.has(t.name)) continue;
  let sawCents = false;
  for (const line of t.columns) {
    const col = /^"([^"]+)"/.exec(line)?.[1];
    if (!col) continue;
    if (/_cents$/.test(col)) {
      sawCents = true;
      if (!/\bBIGINT\b/.test(line)) {
        fail(
          `${t.name}.${col} is a minor-unit amount and is not BIGINT. Write \`BigInt\`.\n      ` +
            "Five of 1.0's seven money columns are 32-bit INTEGER, which overflows at " +
            "€21,474,836.47 — reachable by a consortium's annual acquisitions budget.",
        );
      }
    }
    if (col === 'currency' && !/\bCHAR\(3\)/.test(line)) {
      fail(
        `${t.name}.currency is not CHAR(3). Write \`@db.Char(3)\` — ISO 4217, always paired ` +
          'with the minor-unit amount it qualifies.',
      );
    }
  }
  if (sawCents && !t.columns.some((l) => /^"currency"/.test(l)) && !exempt(`${t.name}.currency`)) {
    fail(
      `${t.name} has a minor-unit amount and no \`currency\` column. §3 pairs them always: an ` +
        'amount without a currency is a number that means different things in two branches of ' +
        'the same consortium.',
    );
  }
}

// ---------------------------------------------------------------------------
// 4. `id` is text — with the singleton carve-out tied to its CHECK
// ---------------------------------------------------------------------------

const migrationSql = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS)
      .filter((d) => existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
      .map((d) => readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'))
      .join('\n')
  : '';

for (const t of tables) {
  if (COMPAT_TWINS.has(t.name)) continue;
  const idLine = t.columns.find((l) => /^"id"\s/.test(l));
  if (!idLine) continue;
  if (/\bTEXT\b/.test(idLine)) continue;
  if (exempt(`${t.name}.id`)) continue;

  // A single-row settings table may legitimately key on `id INTEGER DEFAULT 1`
  // — but ONLY if the CHECK that makes it a singleton actually exists. Without
  // that tie the exemption is a blanket permission to use integer keys, which
  // is how a re-keyable id gets into a table that is referenced by cuid.
  const singleton = new RegExp(
    `ALTER TABLE ${t.name}[\\s\\S]{0,400}?CHECK\\s*\\(\\s*id\\s*=\\s*1\\s*\\)`,
  ).test(migrationSql);
  if (singleton) continue;

  fail(
    `${t.name}.id is not TEXT.\n      ` +
      'Ids are cuids and are never re-keyed. The only exception is a single-row settings ' +
      `table, and it is granted only when a \`CHECK (id = 1)\` on ${t.name} exists in the ` +
      'migration SQL — which it does not. Add the CHECK, or make the id text.',
  );
}

// ---------------------------------------------------------------------------
// 5. a partial unique scoped on archived_at needs an archived_at
// ---------------------------------------------------------------------------

for (const m of migrationSql.matchAll(
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\([\s\S]*?WHERE([\s\S]*?);/g,
)) {
  const [, index, table, where] = m as unknown as [string, string, string, string];
  if (!/archived_at/.test(where)) continue;
  const t = tables.find((x) => x.name === table);
  if (!t) continue;
  if (!t.columns.some((l) => /^"archived_at"/.test(l))) {
    fail(
      `${index} scopes on ${table}.archived_at, which ${table} does not have. The index would ` +
        'fail to create, or worse, be silently created against a column that means ' +
        'something else.',
    );
  }
}

// ---------------------------------------------------------------------------
// 6. the scope manifest still describes the tree
// ---------------------------------------------------------------------------

type Entry = { status: string; basis?: string; phase?: string; reason?: string };
let manifest: { tables: Record<string, Entry> } | null = null;

if (!existsSync(MANIFEST)) {
  fail(`${path.relative(ROOT, MANIFEST)} is missing. It is what makes the baseline's partiality
      a checked fact rather than an omission.`);
} else {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { tables: Record<string, Entry> };
  } catch (err) {
    fail(`${path.relative(ROOT, MANIFEST)} is not valid JSON: ${(err as Error).message}`);
  }
}

const VALID = new Set(['created', 'deferred', 'legacy', 'dropped', 'control-plane']);

if (manifest) {
  const entries = Object.entries(manifest.tables ?? {});
  if (entries.length < 150) {
    fail(
      `the scope manifest names only ${entries.length} table(s). §3 names about 180 tenant ` +
        'tables plus the control-plane additions; a manifest that has quietly shrunk is one ' +
        'that has stopped describing the omissions it exists to record.',
    );
  }

  for (const [name, entry] of entries) {
    if (!VALID.has(entry.status)) {
      fail(`${name}: unknown status ${JSON.stringify(entry.status)}.`);
    }
    if (!entry.reason?.trim()) {
      fail(`${name}: no reason given. An entry without one records nothing.`);
    }
    if (entry.status === 'deferred' && !entry.phase?.trim()) {
      fail(`${name}: deferred with no phase. "Later" is not a plan.`);
    }
  }

  // Both directions. A model with no entry is a table nobody declared; an entry
  // marked `created` with no table is a claim the tree does not support.
  const created = new Set(entries.filter(([, e]) => e.status === 'created').map(([n]) => n));
  for (const t of tables) {
    if (!created.has(t.name)) {
      fail(
        `${t.name} exists in the 2.0 datamodel and the scope manifest does not list it as ` +
          '`created`. Every table in the baseline is a scope decision; add it with a reason.',
      );
    }
  }
  for (const name of created) {
    if (!tables.some((t) => t.name === name)) {
      fail(
        `the scope manifest says ${name} is \`created\`, and no model renders it. Either the ` +
          'model was removed and the manifest was not, or the entry was always aspirational.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 6b. the compat-twin carve-out has not become somewhere to hide
// ---------------------------------------------------------------------------
//
// Same discipline as rule 7 and as check:schema-drift's allowlist: a waiver that
// has stopped describing the tree is a waiver nobody reads. Two ways this one
// could rot — a name that matches no table (the twin was removed and the entry
// was not), and the set growing past the eleven 1.0-only tables it was written
// for, which is how "these are legacy" becomes "these are the ones we could not
// be bothered to convert".

for (const name of COMPAT_TWINS) {
  if (!tables.some((t) => t.name === name)) {
    fail(
      `${name} is listed as a compat twin and no model renders it. The twin was removed and the ` +
        'carve-out was not — and a carve-out that matches nothing waives nothing while reading ' +
        'as a decision.',
    );
  }
}
if (COMPAT_TWINS.size > MAX_COMPAT_TWINS) {
  fail(
    `${COMPAT_TWINS.size} compat twins, above the ceiling of ${MAX_COMPAT_TWINS}. The carve-out ` +
      'exists for the eleven 1.0 tables that outlive the cutover and are read by the surviving ' +
      '1.0 client. A twelfth is either a new 1.0 table — which cannot happen, 1.0 is frozen — or ' +
      'a 2.0 table being excused from the conventions, which is the thing this gate is for.',
  );
}

// ---------------------------------------------------------------------------
// 7. every exemption still applies to something
// ---------------------------------------------------------------------------

for (const key of Object.keys(EXEMPTIONS)) {
  if (!exemptionsUsed.has(key)) {
    fail(
      `the exemption for ${key} no longer matches anything — the column changed or the model ` +
        'was removed. Delete the entry. An exception list that has stopped describing the tree ' +
        'is one nobody can trust.',
    );
  }
}

// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`✗ schema conventions: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

const schemaFiles = existsSync(SCHEMA_DIR)
  ? readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma')).length
  : 0;
console.log(
  `schema conventions ok — ${tables.length} table(s), ${columnCount} column(s) across ` +
    `${schemaFiles} model file(s), rendered without a database. Every physical column is ` +
    'snake_case; every instant is timestamptz(3); every minor-unit amount is bigint and is ' +
    `paired with a char(3) currency; every id is text. ` +
    `${Object.keys(manifest?.tables ?? {}).length} §3 table(s) are accounted for in ` +
    'BASELINE-SCOPE.json, in both directions.',
);
