#!/usr/bin/env tsx
// The Prisma schema and the migrations must still describe the same database.
//
// They drift in one direction almost every time, and always silently: someone
// adds a model or a field to `schema.prisma`, `prisma generate` happily emits a
// client for it, TypeScript compiles, the code reads and writes the new column
// — and no migration was ever written, so the column does not exist on any
// real database. Nothing fails until deploy, on a tenant, at the point the
// first query runs.
//
// `prisma migrate diff --from-migrations --to-schema` answers exactly this
// question: replay every migration into a throwaway database, compare the
// result with the datamodel, and print the SQL that would close the gap.
//
// WHY THE ANSWER IS NOT SIMPLY "THE DIFF MUST BE EMPTY". It never is, and it
// never can be here. These migrations deliberately create objects Prisma's
// datamodel cannot express — GIN trigram indexes, a `text_pattern_ops` index,
// a generated tsvector column — so the diff always proposes DROPPING them.
// That is not drift; it is the surplus this repo signed up for the day it
// chose raw SQL over what the ORM can model.
//
// So the gate is a DIRECTION check, not an emptiness check:
//
//   Statements that DROP something  -> expected, and each one must be in the
//                                      allowlist below with a reason.
//   Statements that CREATE or ADD   -> the schema has something the migrations
//                                      do not. That is the missing migration,
//                                      and it fails.
//
// An allowlist entry that matches nothing also fails: a list of accepted
// exceptions that no longer describes the tree is a list nobody reads.
//
// NEEDS A DATABASE, so it is not part of `pnpm check:all` (which must stay
// runnable on a laptop with nothing running) and instead runs in CI's
// `migrations` job, next to the migrate/seed/DR steps that already have
// Postgres. It REFUSES to run without one rather than skipping: a gate that
// quietly passes when it could not do its job is worse than no gate.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

interface Pkg {
  readonly dir: string;
  readonly schema: string;
  /** Statements the migrations legitimately have and the datamodel cannot express. */
  readonly allowed: Readonly<Record<string, string>>;
}

const GIN_JSONB = 'A GIN index on a jsonb custom-fields column. Prisma cannot express `USING gin`.';
const TRGM =
  'A GIN trigram index backing substring search. Prisma cannot express `gin_trgm_ops`, and ' +
  'without it every search degrades to a sequential scan (performance-12).';

const PACKAGES: Pkg[] = [
  {
    dir: 'packages/db-tenant',
    schema: './prisma/schema',
    allowed: {
      'DROP INDEX "authors_sortname_trgm";': TRGM,
      'DROP INDEX "books_search_trgm";': TRGM,
      'DROP INDEX "members_search_trgm";': TRGM,
      'DROP INDEX "collection_records_search_trgm";': TRGM,
      'DROP INDEX "books_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "book_copies_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "members_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "loans_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "fines_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "reservations_custom_fields_gin";': GIN_JSONB,
      'DROP INDEX "collection_records_data_gin";': GIN_JSONB,
      'DROP INDEX "members_member_number_pattern_idx";':
        'A `text_pattern_ops` index. Prisma cannot express an operator class, and under the ' +
        '`el_GR.UTF-8` collation these databases are created with, a plain btree cannot serve ' +
        "`LIKE 'M-2026-%'` at all (perf-13).",
    },
  },
  {
    dir: 'packages/db-control',
    schema: './prisma/schema.prisma',
    allowed: {
      'DROP INDEX "tenants_name_trgm";': TRGM,
      'DROP INDEX "tenants_slug_trgm";': TRGM,
      'DROP INDEX "tenants_tags_gin";': 'A GIN index on a text[] column. Prisma cannot express it.',
      'DROP INDEX "help_articles_search_gin";':
        'A GIN index on the generated tsvector column below.',
      'ALTER TABLE "help_articles" DROP COLUMN "search_tsv";':
        'A STORED generated column (`to_tsvector(... immutable_unaccent(...))`). Prisma has no ' +
        'generated-column concept, so the datamodel cannot hold it and the diff always proposes ' +
        'dropping it. See 20260825200000_qualify_immutable_unaccent for why its body is qualified.',
    },
  },
];

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

const shadowUrl = process.env.SHADOW_DATABASE_URL ?? '';
if (!shadowUrl) {
  console.error(
    '✗ schema drift: SHADOW_DATABASE_URL is not set.\n\n' +
      '    This gate replays every migration into a throwaway database and compares the result\n' +
      '    with the Prisma datamodel. It cannot do that without a Postgres to build in, and it\n' +
      '    refuses to pass by default — a gate that goes quiet when it cannot do its job is\n' +
      '    worse than no gate.\n\n' +
      '    Locally:  pnpm db:up && SHADOW_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_shadow pnpm check:schema-drift\n' +
      '    In CI:    it runs in the `migrations` job, which already has a Postgres service.\n',
  );
  process.exit(1);
}

/** Split the emitted script into statements, dropping `-- ` banner comments. */
function statementsOf(script: string): string[] {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--') && !l.startsWith('Loaded Prisma config'))
    .join(' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s.replace(/\s+/g, ' ')};`);
}

let totalAllowed = 0;

for (const pkg of PACKAGES) {
  const cwd = path.join(ROOT, pkg.dir);

  // The lock file records the provider the migrations were written for. Without
  // it `migrate diff --from-migrations` refuses to run at all, which is how its
  // absence from db-tenant went unnoticed until this gate was written.
  const lock = path.join(cwd, 'prisma', 'migrations', 'migration_lock.toml');
  if (!existsSync(lock)) {
    fail(`${pkg.dir}: prisma/migrations/migration_lock.toml is missing.`);
    continue;
  }
  if (!/provider\s*=\s*"postgresql"/.test(readFileSync(lock, 'utf8'))) {
    fail(`${pkg.dir}: migration_lock.toml does not record the postgresql provider.`);
    continue;
  }

  let script: string;
  try {
    script = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-migrations',
        './prisma/migrations',
        '--to-schema',
        pkg.schema,
        '--script',
      ],
      {
        cwd,
        env: { ...process.env, SHADOW_DATABASE_URL: shadowUrl },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    fail(
      `${pkg.dir}: migrate diff failed — ${(e.stderr || e.stdout || e.message).trim().slice(0, 400)}`,
    );
    continue;
  }

  const statements = statementsOf(script);
  const seen = new Set<string>();

  for (const stmt of statements) {
    if (stmt in pkg.allowed) {
      seen.add(stmt);
      totalAllowed += 1;
      continue;
    }
    const creates = /^(CREATE|ALTER TABLE .* ADD|ALTER TABLE .* ALTER)/i.test(stmt);
    fail(
      `${pkg.dir}: unexpected drift\n        ${stmt}\n      ` +
        (creates
          ? 'This is the schema having something the migrations do not — i.e. a MISSING\n' +
            '      MIGRATION. Write one; do not add it to the allowlist.'
          : 'If the migrations legitimately hold something the datamodel cannot express,\n' +
            '      add it to the allowlist in this file WITH A REASON. Otherwise write a migration.'),
    );
  }

  for (const stmt of Object.keys(pkg.allowed)) {
    if (!seen.has(stmt)) {
      fail(
        `${pkg.dir}: allowlisted drift no longer occurs — remove it:\n        ${stmt}\n      ` +
          'An exception list that no longer describes the tree is one nobody reads.',
      );
    }
  }
}

if (problems.length) {
  console.error(`✗ schema drift: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}\n`);
  process.exit(1);
}

console.log(
  `schema drift check passed: ${PACKAGES.length} package(s); every migration replayed into a ` +
    `shadow database and compared with the datamodel. No statement would CREATE or ADD anything ` +
    `(which would mean a missing migration); ${totalAllowed} DROP statement(s) matched the ` +
    `allowlist of objects Prisma cannot express, and every allowlist entry still occurs.`,
);
