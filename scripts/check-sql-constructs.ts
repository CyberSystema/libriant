#!/usr/bin/env tsx
/**
 * Refuse `pg_catalog.`-qualified SQL CONSTRUCTS in application raw SQL.
 *
 * ## The trap, and why it needs a gate
 *
 * This repository qualifies every function call in SQL — `pg_catalog.now()`,
 * `pg_catalog.sum()`, `pg_catalog.date_trunc()` — because an unqualified call in
 * a persisted expression resolves through `search_path` and can be shadowed.
 * `check:migration-safety` enforces that for migrations.
 *
 * But a handful of things that LOOK like functions are SQL constructs with their
 * own grammar, and Postgres has no `pg_catalog` entry for any of them:
 *
 *     COALESCE   NULLIF   GREATEST   LEAST   CASE
 *     EXTRACT(x FROM y)   SUBSTRING(x FROM y)
 *
 * Qualifying one is not a style slip, it is a hard `42883` at RUN TIME —
 * `function pg_catalog.greatest(bigint, bigint) does not exist`. The statement
 * parses, the build passes, the types check, and it fails the first time the
 * line is actually executed.
 *
 * ## Why now
 *
 * This is the THIRD time. `checkout.service.ts` and `holds.service.ts` each
 * carry a comment warning about it, written by whoever hit it there. Phase 18
 * then shipped `pg_catalog.greatest(...)` inside `accrueWithin` anyway, and it
 * survived because nothing called that function until the phase-20b-ii overdue
 * sweep did — at which point it refused every loan in the library.
 *
 * A comment in two files did not stop a third. This does.
 *
 * ## What it does NOT check
 *
 * Migrations: `check:migration-safety` already reads those, with its own
 * comment-scrubbing and its own allowlist of accepted history. This is the
 * application half, which nothing looked at.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where SQL is written in this repository.
 *
 * `packages/db-tenant/prisma` was MISSING until 2.0 phase 20e, which is where
 * every migration and the whole v1→v2 upgrade live — so the gate could not see
 * the largest body of hand-written SQL in the product, and a
 * `pg_catalog.coalesce` went into `03-verify.sql` and was caught only by running
 * the upgrade. A gate that cannot reach the code it is about is a gate that
 * reports green for the wrong reason.
 */
const ROOTS = [
  'apps/api/src',
  'packages/db-tenant/src',
  'packages/db-tenant/scripts',
  'packages/db-tenant/prisma',
  'scripts',
];
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'generated']);

/**
 * The constructs Postgres refuses to qualify.
 *
 * `CASE` is absent because `pg_catalog.case` is not expressible — it has no
 * call syntax to mistake for one. The two FROM-forms are absent for the same
 * reason: `pg_catalog.extract(epoch FROM x)` is a syntax error rather than a
 * 42883, so the compiler of the SQL catches it immediately. What is listed here
 * is exactly the set that PARSES and then fails at execution.
 */
const CONSTRUCTS = ['coalesce', 'nullif', 'greatest', 'least'] as const;

/** Strip JS line/block comments and SQL `--` comments, so prose is not a finding. */
function scrub(src: string): string {
  let out = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
  // SQL comments live inside template literals; blank them the same way.
  out = out.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

const files: string[] = [];
for (const r of ROOTS) {
  const start = path.join(ROOT, r);
  try {
    statSync(start);
  } catch {
    continue;
  }
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      // `.sql` as well as `.ts`: a migration is SQL in a file, not SQL in a
      // template literal, and it is exactly as able to qualify a construct
      // Postgres will not resolve.
      else if ((entry.endsWith('.ts') && !entry.endsWith('.d.ts')) || entry.endsWith('.sql')) {
        files.push(p);
      }
    }
  })(start);
}

const problems: string[] = [];
let scanned = 0;
for (const file of files) {
  // This file names every construct it looks for, so it always matches itself.
  if (path.basename(file) === 'check-sql-constructs.ts') continue;
  scanned += 1;
  const lines = scrub(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const c of CONSTRUCTS) {
      const re = new RegExp(`pg_catalog\\.${c}\\s*\\(`, 'i');
      if (!re.test(line)) continue;
      problems.push(
        `${path.relative(ROOT, file)}:${i + 1}: pg_catalog.${c}(...) is a hard 42883 at run time.\n` +
          `      ${c.toUpperCase()} is a SQL CONSTRUCT, not a function, so pg_catalog has no entry ` +
          `for it.\n      Write it bare. The statement parses either way, which is why this is a ` +
          `gate and not a review note.`,
      );
    }
  });
}

if (problems.length > 0) {
  console.error(`✗ sql constructs: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}\n`);
  console.error(
    'Measured on PG 16.15: COALESCE, NULLIF, GREATEST and LEAST cannot be schema-qualified,\n' +
      'and neither can CASE or the FROM-forms of EXTRACT and SUBSTRING. Everything else this\n' +
      'repository qualifies — to_jsonb, jsonb_build_object, date_part, two-arg substring,\n' +
      'format, to_char, string_agg, date_trunc — qualifies fine and must stay qualified.',
  );
  process.exit(1);
}

console.log(
  `sql construct check passed: ${scanned} file(s) scanned with comments scrubbed; no ` +
    `pg_catalog-qualified COALESCE, NULLIF, GREATEST or LEAST in application SQL.`,
);
