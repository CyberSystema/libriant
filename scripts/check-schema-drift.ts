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
  /**
   * How the "what the migrations built" side is obtained.
   *
   * `replay` is `--from-migrations`: Prisma builds a throwaway copy from the
   * migration files. It is the cheaper form and it is what the 1.0 schemas use.
   *
   * `deploy` runs `prisma migrate deploy` into the shadow database and then
   * diffs against that. Needed for the 2.0 folder because `--from-migrations`
   * always replays into `public`, while the 2.0 datamodel lives in `lbr2` — so
   * the replay form compares the schema against an empty namespace and proposes
   * creating all seventeen tables, every run, forever.
   *
   * It is also the stronger check: it compares the datamodel against what a real
   * deploy actually produces, rather than against a replay of the same files.
   */
  readonly mode?: 'replay' | 'deploy';
  /** Extra CLI args, e.g. selecting a second Prisma config. */
  readonly args?: readonly string[];
  /** Appended to the shadow URL, e.g. `?schema=lbr2`. */
  readonly urlSuffix?: string;
  /** Env var the CLI reads the datasource URL from. */
  readonly urlEnv?: string;
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
    dir: 'packages/db-tenant',
    schema: './prisma/schema-v2',
    mode: 'deploy',
    args: ['--config', 'prisma-v2.config.ts'],
    urlSuffix: '?schema=lbr2',
    urlEnv: 'TENANT_DATABASE_URL',
    allowed: {
      'ALTER TABLE "items" DROP COLUMN "is_shelf_available";':
        'A STORED generated column. Prisma has no generated-column concept, so the datamodel ' +
        'cannot hold it. It is generated rather than an index predicate because Prisma emits ' +
        '`status = CAST($1::text AS item_status)` and `enum_in` is only STABLE, so the planner ' +
        'can never prove an enum-predicate partial index — the reason `loans_active_dueAt_idx` ' +
        'had to be dropped in 1.0.',
      'ALTER TABLE "fees" DROP COLUMN "outstanding_cents", DROP COLUMN "owed_cents";':
        'TWO STORED generated columns, and the diff names them in one statement. ' +
        '`outstanding_cents` is amount + tax - paid - waived - written_off, generated so that two ' +
        'code paths cannot compute a balance differently — the most damaging bug class available ' +
        'in a fee ledger. `owed_cents` (2.0 phase 18) is that number when the row is open and 0 ' +
        'when it is closed, and it exists because two readers already disagreed: ' +
        'patrons.service.ts summed `outstanding_cents > 0` while circulation-state.ts — the gate ' +
        'that blocks a checkout — summed `closed_at IS NULL`. They agree only while nothing writes ' +
        'fees. A CANCELLED charge closes the row without moving a settlement counter, so from the ' +
        'first void the same patron has two different balances at one desk. `owed_cents` is the ' +
        'only predicate a reader should ask.',
      'ALTER TABLE "ledger_discrepancies" DROP COLUMN "difference_cents";':
        'A STORED generated column: actual - expected. The reconciler writes what it measured and ' +
        'what it expected; the gap between them is arithmetic, and a third column somebody fills ' +
        'in by hand is a third opinion about a number that exists to be trusted.',
      'ALTER TABLE "circulation_rules" DROP COLUMN "specificity";':
        'A STORED generated column: the six selectors weighted 32/16/8/4/2/1, so a narrower rule ' +
        'always outranks a vaguer one. Prisma has no generated-column concept. It is a column ' +
        'rather than a service-side computation because `circulation_rules_default_singleton` is ' +
        'a partial unique index `WHERE specificity = 0 AND enabled`, and an index predicate can ' +
        'only read stored values — that index is the only thing standing between a library and ' +
        'two enabled wildcard rules, a state in which `compareRank` decides the default rule of ' +
        'the library by comparing two cuids.',
      'DROP INDEX "circulation_rules_listing_idx";':
        'Doubly inexpressible: `(priority DESC, specificity DESC, id COLLATE "C")` leads with the ' +
        'generated column above, which is not a field of `CirculationRule`, and ends with a ' +
        'per-index collation Prisma has no syntax for. It exists so the matrix editor and ' +
        '`/circulation/explain` list rules in the order `compareRank` ranks them — that tiebreak ' +
        'is UTF-16 code units while the tenant collation is ICU el-GR, measured to disagree ' +
        '(`r_default` and `r-default` invert). Not the `WHERE enabled` resolve index §3 proposed, ' +
        'which was measured harmful — 403 buffers against 5 — and deliberately does not exist.',
      'DROP INDEX "bib_records_search_trgm";':
        `${TRGM} Written \`public.gin_trgm_ops\` rather ` +
        'than bare: an operator class is resolved through `search_path` exactly as a function ' +
        'is, and phase 20 relocates pg_trgm out of `public`.',
      'DROP INDEX "patrons_search_trgm";':
        `${TRGM} On \`search_text\`, the folded name-and-contact column, because what the desk ` +
        'types for a reader who has forgotten their card is a fragment of a Greek name. ' +
        'Qualified `public.gin_trgm_ops` for the reason `bib_records_search_trgm` is.',
      'DROP INDEX "patrons_number_pattern_idx";':
        'A `text_pattern_ops` index; Prisma cannot express an operator class. It is the number ' +
        'this phase is accepted on (perf-13), and that measurement is also the argument against ' +
        'the two shapes that look equivalent. 50,000 rows, a prefix selecting 10%: a plain btree ' +
        'is a Bitmap Index Scan at 21 index buffers under C, and a Seq Scan at 319 under ' +
        'en_US.UTF-8, el_GR.UTF-8 and ICU el-GR alike — still seq-scanning with ' +
        '`enable_seqscan = off`, so there is no index path at all, not a costing preference. ' +
        '`text_pattern_ops` gives the 21-buffer bitmap scan under all four. It also carries the ' +
        'ordinary `=(text,text)` at btree strategy 3, so `patron_number = $1` needs no second ' +
        'index — while `COLLATE "C"`, the obvious thing to copy from ' +
        '`circulation_rules_listing_idx` above, serves `LIKE` and SEQ SCANS that equality, ' +
        'whose collation comes from the column and not from the index.',
      'DROP SEQUENCE "record_version_seq";':
        'A bare sequence shared by `marc_records.row_version` and `change_events.row_version`, ' +
        'so a device replica can order a catalogue change against a circulation change. Prisma ' +
        'has no standalone-sequence concept; it only knows sequences it owns behind ' +
        '`autoincrement()`.',
      'DROP SEQUENCE "marc_public_no_seq";':
        'The `public_no` sequence — the printable record number. A sequence rather than a ' +
        'counter row because `public_no` has no format and no reset, so a counter would ' +
        'serialise every catalogue create behind one row lock for nothing. Prisma has no ' +
        'standalone-sequence concept.',
      'ALTER TABLE "marc_records" ALTER COLUMN "public_no" SET DEFAULT nextval(\'marc_public_no_seq\'::regclass), ALTER COLUMN "public_no" DROP DEFAULT, ALTER COLUMN "row_version" SET DEFAULT nextval(\'record_version_seq\'::regclass), ALTER COLUMN "row_version" DROP DEFAULT;':
        'The other half of dropping those two sequences — Prisma renders every column default ' +
        'it wants to change on one table as a SINGLE statement, so this entry covers both and ' +
        'must be re-recorded whenever a third sequence-defaulted column is added. Both columns ' +
        'keep their `@default(dbgenerated(...))` in the datamodel; only the sequence objects ' +
        'are surplus.',
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
  const migrationsDir = pkg.schema.includes('-v2') ? 'migrations-v2' : 'migrations';
  const lock = path.join(cwd, 'prisma', migrationsDir, 'migration_lock.toml');
  if (!existsSync(lock)) {
    fail(`${pkg.dir}: prisma/${migrationsDir}/migration_lock.toml is missing.`);
    continue;
  }
  if (!/provider\s*=\s*"postgresql"/.test(readFileSync(lock, 'utf8'))) {
    fail(`${pkg.dir}: migration_lock.toml does not record the postgresql provider.`);
    continue;
  }

  const pkgUrl = `${shadowUrl}${pkg.urlSuffix ?? ''}`;
  const extra = pkg.args ? [...pkg.args] : [];
  // In `deploy` mode the shadow database IS the target, so SHADOW_DATABASE_URL
  // must be unset: Prisma refuses outright when the two are the same database
  // ("The shadow database you configured appears to be the same as the main
  // database"). In `replay` mode it is the throwaway Prisma builds into.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (pkg.mode === 'deploy') {
    delete env.SHADOW_DATABASE_URL;
  } else {
    env.SHADOW_DATABASE_URL = pkgUrl;
  }
  if (pkg.urlEnv) env[pkg.urlEnv] = pkgUrl;

  if (pkg.mode === 'deploy') {
    // RESET THE NAMESPACE FIRST, so this gate is repeatable against one shadow
    // database.
    //
    // `migrate deploy` is a no-op on a database that already has the ledger, so
    // without this the second run of the gate reuses whatever the FIRST run left
    // — and the first run left it damaged. `--from-migrations` (the 1.0 and
    // control-plane entries above and below) resets the shadow database by
    // dropping and recreating the extensions, and `bib_records_search_trgm` is
    // the first object in `lbr2` that depends on one, so `DROP EXTENSION
    // pg_trgm` CASCADEs it away while leaving every table and the ledger intact.
    // Run two then reported "allowlisted drift no longer occurs — remove it",
    // telling the operator to delete a correct entry. Reproduced
    // deterministically; CI never saw it only because it creates the shadow
    // database fresh each job.
    //
    // A shadow database is disposable by definition, which is what makes
    // dropping the schema the right answer rather than a heavy one.
    //
    // `prisma db execute --stdin` rather than a `pg` client, because this file
    // is loaded as CJS by tsx and top-level `await` does not compile there — and
    // rather than `--url`, which Prisma 7 refuses once a config file is loaded.
    // The config supplies the datasource, so the reset lands on exactly the
    // database the deploy below will use.
    const namespace = (pkg.urlSuffix ?? '').replace(/^\?schema=/, '') || 'public';
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'db', 'execute', ...extra, '--stdin'], {
        cwd,
        env,
        input: `DROP SCHEMA IF EXISTS "${namespace}" CASCADE;`,
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      fail(
        `${pkg.dir} (${pkg.schema}): could not reset the shadow namespace — ` +
          `${(e.stderr || e.stdout || e.message).trim().slice(0, 400)}`,
      );
      continue;
    }
    // Build the "what the migrations produce" side by actually deploying them.
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy', ...extra], {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      fail(
        `${pkg.dir} (${pkg.schema}): the migrations do not apply to a clean shadow database — ` +
          `${(e.stderr || e.stdout || e.message).trim().slice(0, 400)}`,
      );
      continue;
    }
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
        ...(pkg.mode === 'deploy'
          ? ['--from-config-datasource']
          : ['--from-migrations', './prisma/migrations']),
        '--to-schema',
        pkg.schema,
        '--script',
        ...extra,
      ],
      {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    fail(
      `${pkg.dir} (${pkg.schema}): migrate diff failed — ${(e.stderr || e.stdout || e.message)
        .trim()
        .slice(0, 400)}`,
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
