#!/usr/bin/env tsx
// Every 1.0 column has a verdict, and the verdict still describes the tree.
//
// ## Why this gate and not a careful reviewer
//
// Phase 19's copy-forward is a ONE-WAY migration of a real library's catalogue.
// The failure mode is not a wrong value — a wrong value is visible. It is a
// column nobody thought about: the transformation is written from the 2.0 side
// ("what does `patrons` need?"), so a 1.0 column with no obvious home is not
// rejected, it is never mentioned, and once `v1_archive` is dropped there is
// nothing to go back to.
//
// That is not hypothetical. Three independent designs for this phase were
// written by three authors working from the same survey, and ALL THREE silently
// lost the same four things:
//
//   tenant_settings.lostItemFeesEnabled      a library that charges 25 EUR for a
//   tenant_settings.lostItemDefaultFeeCents  lost book starts charging the seed
//                                            default, unrecoverably
//   tenant_settings.notify* (four columns)   a library with overdue notices ON
//                                            comes up with them OFF
//   book_authors.role on the order-0 creator a book whose first listed creator
//                                            is a TRANSLATOR is migrated as
//                                            having written it
//
// None of those is a bug in a transformation. Each is a column that was never
// considered, and no amount of care finds the fifth one. A list that must be
// TOTAL does.
//
// ## The three ways it fails
//
//   MISSING   a column in the 1.0 datamodel with no entry. The build stops until
//             somebody decides where it goes — including deciding to drop it.
//   STALE     an entry for a column that no longer exists. A routing file that
//             has stopped describing the schema is one nobody can trust, which
//             is the same argument check-schema-drift makes about its allowlist.
//   UNREASONED  a `dropped` verdict with no reason. "We are not carrying this"
//             is a decision; recording it without the why makes it a shrug.
//
// ## It needs no database
//
// `prisma migrate diff --from-empty --to-schema` renders the 1.0 datamodel
// without connecting (measured by check-schema-conventions against a closed
// port), so this runs in `check:all` on a laptop with nothing running.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG = path.join(ROOT, 'packages/db-tenant');
const ROUTING = path.join(PKG, 'prisma/upgrade/routing.json');

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/**
 * Below these the gate is assumed broken rather than satisfied.
 *
 * `--from-empty` against a renamed folder exits 0 and prints nothing, so every
 * check here would pass having examined nothing. check-schema-conventions
 * carries the same floors for the same reason, and names the three phases that
 * each shipped this failure.
 */
const MIN_TABLES = 18;
const MIN_COLUMNS = 200;

if (!existsSync(ROUTING)) {
  console.error(`✗ ${path.relative(ROOT, ROUTING)} does not exist.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The 1.0 datamodel, rendered
// ---------------------------------------------------------------------------

let ddl = '';
try {
  ddl = execFileSync(
    './node_modules/.bin/prisma',
    ['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema', '--script'],
    { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err: unknown) {
  console.error(`✗ could not render the 1.0 datamodel: ${String(err)}`);
  process.exit(1);
}

/**
 * Physical tables and columns, from the DDL rather than from the model text.
 *
 * Reading the model would read Prisma FIELD names, which are camelCase by
 * design and are not what the copy-forward selects. 1.0's physical columns are
 * quoted camelCase — `"loanedAt"`, not `loaned_at` — and getting that wrong is
 * the single most common error in a statement against this schema.
 */
const tables = new Map<string, Set<string>>();
for (const block of ddl.split('CREATE TABLE ').slice(1)) {
  const name = /^"?(?:public"?\.)?"?([A-Za-z0-9_]+)"?/.exec(block)?.[1];
  if (name === undefined) continue;
  const body = block.slice(block.indexOf('('), block.indexOf('\n);'));
  const cols = new Set<string>();
  for (const line of body.split('\n')) {
    const col = /^\s*"([^"]+)"\s+\S/.exec(line)?.[1];
    if (col !== undefined) cols.add(col);
  }
  if (cols.size > 0) tables.set(name, cols);
}

if (tables.size < MIN_TABLES) {
  fail(
    `rendered only ${tables.size} table(s) from the 1.0 datamodel, below the floor of ` +
      `${MIN_TABLES}. The folder moved, the render failed, or this gate is now blind.`,
  );
}
const columnCount = [...tables.values()].reduce((n, c) => n + c.size, 0);
if (columnCount < MIN_COLUMNS) {
  fail(`rendered only ${columnCount} column(s), below the floor of ${MIN_COLUMNS}.`);
}

// ---------------------------------------------------------------------------
// The routing file
// ---------------------------------------------------------------------------

type Entry = { verdict: string; to?: string; how?: string; reason?: string; note?: string };
type TableRouting = Record<string, Entry> | '__COMPAT__' | '__COMPAT_INFRA__';

const routing = JSON.parse(readFileSync(ROUTING, 'utf8')) as {
  tables: Record<string, TableRouting>;
};
const VERDICTS = new Set(['copied', 'derived', 'dropped', 'compat']);

for (const [table, cols] of [...tables].sort()) {
  const entry = routing.tables[table];
  if (entry === undefined) {
    fail(
      `${table} exists in the 1.0 datamodel and routing.json does not mention it. Every table ` +
        `is a decision: it is copied forward, or it is a compat twin, or every one of its ` +
        `columns is dropped with a reason.`,
    );
    continue;
  }
  // A whole-table verdict. The eleven 1.0-only tables are carried into lbr2
  // with their 1.0 PHYSICAL shape, so routing them column by column would be
  // 93 entries all saying the same thing.
  if (entry === '__COMPAT__' || entry === '__COMPAT_INFRA__') continue;

  for (const col of [...cols].sort()) {
    const e = entry[col];
    if (e === undefined) {
      fail(
        `${table}."${col}" has no entry in routing.json. Decide where it goes — including ` +
          `deciding it goes nowhere, which needs a reason. This is the check that found the ` +
          `four columns every candidate design for this phase silently lost.`,
      );
      continue;
    }
    if (!VERDICTS.has(e.verdict)) {
      fail(`${table}."${col}": unknown verdict ${JSON.stringify(e.verdict)}.`);
    }
    if (e.verdict === 'dropped' && (e.reason ?? '').trim().length < 20) {
      fail(
        `${table}."${col}" is dropped with no real reason. A one-way migration that discards a ` +
          `column without saying why is indistinguishable from one that forgot it.`,
      );
    }
    if ((e.verdict === 'copied' || e.verdict === 'derived') && (e.to ?? '').trim() === '') {
      fail(`${table}."${col}" is ${e.verdict} and names no target.`);
    }
  }

  // The other direction.
  for (const col of Object.keys(entry)) {
    if (!cols.has(col)) {
      fail(
        `routing.json routes ${table}."${col}", which the 1.0 datamodel no longer has. Either ` +
          `the column was removed and this entry was not, or it never existed — and an entry ` +
          `that describes nothing reads as coverage.`,
      );
    }
  }
}

for (const table of Object.keys(routing.tables)) {
  if (!tables.has(table)) {
    fail(`routing.json routes table ${table}, which the 1.0 datamodel does not have.`);
  }
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`✗ upgrade coverage: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

const routed = Object.values(routing.tables).filter((t) => typeof t === 'object');
const perColumn = routed.reduce((n, t) => n + Object.keys(t as object).length, 0);
const compat = Object.values(routing.tables).filter((t) => typeof t === 'string').length;
const dropped = routed.reduce(
  (n, t) =>
    n + Object.values(t as Record<string, Entry>).filter((e) => e.verdict === 'dropped').length,
  0,
);
console.log(
  `upgrade coverage ok — ${tables.size} table(s) and ${columnCount} column(s) in the 1.0 ` +
    `datamodel; ${perColumn} column(s) individually routed across ${routed.length} table(s), ` +
    `${compat} table(s) carried verbatim as compat twins, ${dropped} column(s) deliberately ` +
    `dropped and every one of them with a reason. Nothing in 1.0 is unaccounted for.`,
);
