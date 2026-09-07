#!/usr/bin/env tsx
// Migration SQL that cannot run, or runs and quietly corrupts, fails here
// instead of at 03:00 on a customer's database.
//
// Five rules, each one a mistake this repository has already made or is one
// phase away from making. Every rule matches against SCRUBBED sql — comments
// and string literals blanked out, dollar-quoted bodies kept AND scrubbed
// recursively — because these migrations explain themselves at length and
// quote the very constructs a gate looks for. `-- Not CONCURRENTLY, because
// prisma migrate deploy wraps each file in a transaction` appears in SEVEN
// migrations, and `-- MUST be UTC wall time, not bare now()` appears inside a
// DO block. A plain grep fails all of them and teaches everyone to distrust
// the gate; a scrubber that stopped at the dollar-quote boundary reported that
// second warning as the very violation it warns about.
//
//   1. CONCURRENTLY IN THE TRANSACTIONAL TRACK. A transactional migration is
//      atomic because it OPENS ITS OWN BEGIN/COMMIT, and CREATE INDEX
//      CONCURRENTLY cannot run inside one — it fails at apply time, on the
//      tenant, halfway through a fan-out. Index builds that must not hold a
//      write lock belong in prisma/online/.
//
//      The seven migrations that say so in prose give a DIFFERENT reason —
//      "prisma migrate deploy wraps each file in a transaction" — and phase 9
//      measured that to be false: Prisma 7.9.1 applied a file containing
//      `CREATE TABLE …; SELECT 1/0;` and the table SURVIVED, with a
//      `finished_at IS NULL` row poisoning every later deploy on that tenant.
//      Those seven files are left as written, because Prisma checksums a
//      migration and editing an applied one breaks every database that has run
//      it — the same reason a bad migration is fixed with a NEW migration here.
//      The rule stands; only its stated reason changes.
//
//   2. UNQUALIFIED FUNCTION CALLS IN PERSISTED EXPRESSIONS. An index
//      expression, generated column, CHECK or DEFAULT is re-evaluated later,
//      under whatever search_path the session happens to have. This repo has
//      already shipped 20260825200000_qualify_immutable_unaccent for exactly
//      this, and lost a control-plane restore to an unqualified
//      gen_random_uuid. Phase 20 moves unaccent and pg_trgm out of `public`,
//      which turns every remaining unqualified call into a broken index.
//
//   3. A timestamptz CAST WITHOUT AN EXPLICIT SOURCE ZONE. Prisma renders
//      `ALTER COLUMN … TYPE timestamptz` as a bare cast, which interprets the
//      existing value in the SESSION's TimeZone. The production host is
//      Europe/Athens, so the 2.0 upgrade would silently move every stored
//      instant by two or three hours — every due date, every fine accrual,
//      every audit timestamp. `USING col AT TIME ZONE 'UTC'` is the fix and it
//      has to be written by hand every time.
//
//   4. NON-IDEMPOTENT DDL IN THE ONLINE TRACK. An online script runs OUTSIDE a
//      transaction and is resumable by design: a CREATE INDEX CONCURRENTLY
//      that fails leaves an INVALID index behind, and the retry must step over
//      it. Without IF NOT EXISTS the retry dies on the object its own previous
//      attempt created, and a half-built index is exactly when someone reaches
//      for the retry.
//
//   5. AN UNQUALIFIED now() OR gen_random_uuid(), ANYWHERE. Not only inside a
//      persisted expression. The repo wrote the rule down itself, in
//      20260826085000_repair_orphan_ready_holds: "TIMESTAMPS. pg_catalog.now()
//      AT TIME ZONE 'UTC', never bare now()." Tenant timestamp columns are
//      `timestamp(3)` WITHOUT a zone, so a bare now() writes the session's
//      local wall clock into a column every reader treats as UTC — on the
//      production host, a silent two-or-three-hour shift, per row, forever.
//
// Rules 1-3 and 5 apply everywhere. RULE 4 APPLIES TO THE ONLINE TRACK ONLY, and
// that scope is the whole point of it. A regular migration runs once, inside a
// transaction, under Prisma's ledger; there, IF NOT EXISTS does not add safety
// — it HIDES a real conflict, turning "this object already exists and nobody
// knows why" into silence. 153 CREATE statements in the existing migrations
// are Prisma-generated DDL for tables that did not exist yet, and demanding
// IF NOT EXISTS of them would have meant a grandfather list of every migration
// ever written, which is a gate that checks nothing.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineAt, lineTextAt, scrubSql } from './_lib/sql-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_PATH = path.join(HERE, 'migration-safety-baseline.json');

/**
 * Findings in migrations that have already been applied.
 *
 * An applied migration is HISTORY. Prisma checksums every migration file and
 * refuses to deploy when one it has already recorded no longer hashes the
 * same, so "just fix it" would break every database that has run it — and the
 * fix for a bad migration is a NEW migration, which is exactly what
 * 20260825200000_qualify_immutable_unaccent is.
 *
 * So the gate carries a baseline, the way `check:supply-chain` carries its
 * recorded licence decisions. Entries are matched on file + rule + line + the
 * exact source text, so editing an applied migration breaks the baseline as
 * loudly as it breaks Prisma. A baseline entry that stops matching anything is
 * also a failure: a list of accepted problems that no longer describes the
 * tree is a list nobody can trust.
 *
 * Nothing new goes in here. Regenerate with `--write-baseline` only when a
 * finding has been genuinely superseded and you are removing its entry.
 */
interface BaselineEntry {
  readonly file: string;
  readonly rule: string;
  readonly line: number;
  readonly source: string;
  readonly why: string;
}

const PACKAGES = ['db-tenant', 'db-control'] as const;

/**
 * Every transactional migration FOLDER, as `packages/<pkg>/prisma/<dir>`.
 *
 * `migrations-v2` is the Libriant 2.0 baseline, which lives in its own folder
 * because it targets its own Postgres schema (see
 * `packages/db-tenant/prisma-v2.config.ts`). It was invisible to this gate for
 * as long as the folder list was implicit — a 1,100-line migration, the largest
 * in the repository, entirely ungated — which is the argument for naming the
 * folders rather than assuming one.
 */
const MIGRATION_DIRS: ReadonlyArray<readonly [(typeof PACKAGES)[number], string]> = [
  ['db-tenant', 'migrations'],
  ['db-tenant', 'migrations-v2'],
  ['db-control', 'migrations'],
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
  readonly source: string;
}

const findings: Finding[] = [];
const add = (file: string, text: string, offset: number, rule: string, detail: string) =>
  findings.push({
    file,
    line: lineAt(text, offset),
    rule,
    detail,
    source: lineTextAt(text, offset),
  });

/**
 * Functions whose resolution depends on `search_path`, so a persisted
 * expression that calls one unqualified is a time bomb. Extension functions
 * are the real hazard — they live in whichever schema the extension was
 * created in, and phase 20 moves two of them.
 */
/**
 * Functions that must carry a schema prefix ANYWHERE in migration SQL, not
 * only inside a persisted expression.
 *
 * `now()` is here for a reason the repo already wrote down, in
 * 20260826085000_repair_orphan_ready_holds: "TIMESTAMPS. pg_catalog.now() AT
 * TIME ZONE 'UTC', never bare now()." The tenant columns are `timestamp(3)`
 * without a zone, so a bare `now()` writes the SESSION's local wall clock into
 * a column every reader treats as UTC — on the production host that is a
 * silent two-or-three-hour shift, per row, forever.
 *
 * `gen_random_uuid` is here because an unqualified one cost this project a
 * control-plane restore.
 */
const ALWAYS_QUALIFIED = ['now', 'gen_random_uuid', 'unaccent', 'immutable_unaccent'];

const SEARCH_PATH_SENSITIVE = [
  'unaccent',
  'immutable_unaccent',
  'gen_random_uuid',
  'gen_random_bytes',
  'digest',
  'crypt',
  'uuid_generate_v4',
  'similarity',
  'word_similarity',
  'normalize',
  'libriant_fold_greek',
];

/** `CREATE INDEX … (expr)`, `GENERATED ALWAYS AS (expr)`, `CHECK (expr)`, `DEFAULT expr`. */
function persistedExpressions(code: string): { start: number; end: number; kind: string }[] {
  const spans: { start: number; end: number; kind: string }[] = [];
  const patterns: [RegExp, string][] = [
    [
      /CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?ON\s+[^\s(]+(?:\s+USING\s+\w+)?\s*\(/gi,
      'index expression',
    ],
    [/GENERATED\s+ALWAYS\s+AS\s*\(/gi, 'generated column'],
    [/\bCHECK\s*\(/gi, 'CHECK constraint'],
    [/\bDEFAULT\s+(?=[A-Za-z_])/gi, 'DEFAULT'],
  ];
  for (const [re, kind] of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const openAt = m[0].endsWith('(') ? m.index + m[0].length - 1 : -1;
      if (openAt === -1) {
        // DEFAULT: the expression runs to the next comma or close paren at depth 0.
        let j = m.index + m[0].length;
        let depth = 0;
        while (j < code.length) {
          const c = code[j];
          if (c === '(') depth += 1;
          else if (c === ')') {
            if (depth === 0) break;
            depth -= 1;
          } else if (c === ',' && depth === 0) break;
          j += 1;
        }
        spans.push({ start: m.index, end: j, kind });
        continue;
      }
      let depth = 0;
      let j = openAt;
      for (; j < code.length; j += 1) {
        if (code[j] === '(') depth += 1;
        else if (code[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      spans.push({ start: m.index, end: Math.min(j + 1, code.length), kind });
    }
  }
  return spans;
}

function checkFile(
  relPath: string,
  absPath: string,
  opts: { online: boolean; idempotent: boolean },
) {
  const sql = readFileSync(absPath, 'utf8');
  const { code } = scrubSql(sql);

  // --- rule 1: CONCURRENTLY in the transactional track --------------------
  if (!opts.online) {
    const re = /\bCONCURRENTLY\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      add(
        relPath,
        sql,
        m.index,
        'concurrently-in-transaction',
        'a transactional migration opens its own BEGIN/COMMIT, and CONCURRENTLY cannot run ' +
          'inside a transaction. Move this to prisma/online/. (Note: `prisma migrate deploy` ' +
          'does NOT wrap a file for you — measured in phase 9 — which is why the baseline ' +
          'wraps itself and why a mid-file failure otherwise leaves half a schema behind.)',
      );
    }
  }

  // --- rule 2: unqualified search_path-sensitive calls in persisted exprs --
  for (const span of persistedExpressions(code)) {
    const text = code.slice(span.start, span.end);
    for (const fn of SEARCH_PATH_SENSITIVE) {
      const re = new RegExp(`(^|[^.\\w"])(${fn})\\s*\\(`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        add(
          relPath,
          sql,
          span.start + m.index + (m[1] as string).length,
          'unqualified-in-persisted-expression',
          `${fn}() is called unqualified inside a ${span.kind}. Write ` +
            `extensions.${fn}(…) or pg_catalog.${fn}(…): this expression is re-evaluated later ` +
            `under whatever search_path the session has.`,
        );
      }
    }
  }

  // --- rule 5: always-qualified functions, anywhere in the file -----------
  for (const fn of ALWAYS_QUALIFIED) {
    const re = new RegExp(`(^|[^.\\w"])(${fn})\\s*\\(`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      add(
        relPath,
        sql,
        m.index + (m[1] as string).length,
        'unqualified-function',
        `${fn}() must be schema-qualified in migration SQL: write pg_catalog.${fn}(…) ` +
          `(or extensions.${fn}(…) for an extension function). ` +
          (fn === 'now'
            ? 'Tenant timestamps are `timestamp(3)` without a zone, so a bare now() writes the ' +
              'session wall clock into a column every reader treats as UTC.'
            : 'Resolution depends on search_path, which phase 20 changes.'),
      );
    }
  }

  // --- rule 3: timestamptz cast without an explicit source zone -----------
  {
    const re = /ALTER\s+COLUMN\s+[^\s;]+\s+(?:SET\s+DATA\s+)?TYPE\s+timestamptz[^;]*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      if (!/AT\s+TIME\s+ZONE/i.test(m[0])) {
        add(
          relPath,
          sql,
          m.index,
          'timestamptz-cast-without-zone',
          'A bare cast to timestamptz reads the existing value in the SESSION TimeZone. The ' +
            "production host is Europe/Athens. Write USING <col> AT TIME ZONE 'UTC'.",
        );
      }
    }
  }

  // --- rule 4: non-idempotent DDL where a retry must step over it ---------
  if (opts.idempotent) {
    const checks: [RegExp, string][] = [
      [
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)(?!CONCURRENTLY\s+IF\s+NOT\s+EXISTS)(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/gi,
        'CREATE INDEX',
      ],
      [/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE'],
      [/DROP\s+INDEX\s+(?!IF\s+EXISTS)(?:CONCURRENTLY\s+)?(?!IF\s+EXISTS)/gi, 'DROP INDEX'],
    ];
    for (const [re, what] of checks) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        add(
          relPath,
          sql,
          m.index,
          'non-idempotent-ddl',
          `${what} without IF ${what.startsWith('DROP') ? '' : 'NOT '}EXISTS. An online script ` +
            `runs outside a transaction and is resumable: a failed CONCURRENTLY build leaves an ` +
            `INVALID index behind, and the retry must be able to step over its own previous ` +
            `attempt.`,
        );
      }
    }
  }
}

for (const [pkg, folder] of MIGRATION_DIRS) {
  const migrations = path.join(ROOT, 'packages', pkg, 'prisma', folder);
  let entries: string[] = [];
  try {
    entries = readdirSync(migrations).filter((d) =>
      statSync(path.join(migrations, d)).isDirectory(),
    );
  } catch {
    entries = [];
  }
  for (const dir of entries.sort()) {
    const file = path.join(migrations, dir, 'migration.sql');
    try {
      statSync(file);
    } catch {
      continue;
    }
    checkFile(`packages/${pkg}/prisma/${folder}/${dir}/migration.sql`, file, {
      online: false,
      idempotent: false,
    });
  }
}

for (const pkg of PACKAGES) {
  const online = path.join(ROOT, 'packages', pkg, 'prisma', 'online');
  let onlineFiles: string[] = [];
  try {
    onlineFiles = readdirSync(online).filter((f) => f.endsWith('.sql'));
  } catch {
    onlineFiles = [];
  }
  for (const f of onlineFiles.sort()) {
    checkFile(`packages/${pkg}/prisma/online/${f}`, path.join(online, f), {
      online: true,
      idempotent: true,
    });
  }
}

// --- baseline reconciliation ----------------------------------------------
let baseline: BaselineEntry[] = [];
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).accepted as BaselineEntry[];
} catch {
  baseline = [];
}

const keyOf = (f: { file: string; rule: string; line: number; source: string }) =>
  `${f.file}\u0000${f.rule}\u0000${f.line}\u0000${f.source}`;

if (process.argv.includes('--write-baseline')) {
  const seen = new Map(baseline.map((b) => [keyOf(b), b.why]));
  const accepted = findings.map((f) => ({
    file: f.file,
    rule: f.rule,
    line: f.line,
    source: f.source,
    why: seen.get(keyOf(f)) ?? 'TODO: explain why this is accepted history.',
  }));
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        $comment: [
          'Accepted findings in migrations that have already been applied.',
          'An applied migration is history: Prisma checksums it and refuses to deploy a changed one,',
          'so the fix for a bad migration is a NEW migration, never an edit. Entries match on',
          'file + rule + line + exact source text, so editing an applied migration fails this gate',
          'as loudly as it fails Prisma. An entry that matches nothing is also a failure.',
          'Nothing new belongs here. New migrations are written to the rules.',
        ].join(' '),
        accepted,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`wrote ${accepted.length} baseline entries to ${path.relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baselineKeys = new Set(baseline.map(keyOf));
const foundKeys = new Set(findings.map(keyOf));
const unmatched = baseline.filter((b) => !foundKeys.has(keyOf(b)));
const novel = findings.filter((f) => !baselineKeys.has(keyOf(f)));

if (unmatched.length) {
  console.error(
    `✗ migration safety: ${unmatched.length} baseline entr(ies) match nothing in the tree.\n` +
      `  A migration was edited, or a finding was fixed without removing its entry.\n`,
  );
  for (const b of unmatched) console.error(`    ${b.file}:${b.line} [${b.rule}] ${b.source}`);
  process.exit(1);
}

const findingsToReport = novel;
if (findingsToReport.length) {
  console.error(`✗ migration safety: ${findingsToReport.length} problem(s)\n`);
  for (const f of findingsToReport) {
    console.error(`    ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`      ${f.detail}`);
    console.error(`      > ${f.source.slice(0, 110)}`);
    console.error('');
  }
  process.exit(1);
}

const counted = MIGRATION_DIRS.map((p) => {
  const dir = path.join(ROOT, 'packages', p[0], 'prisma', p[1]);
  try {
    return readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).length;
  } catch {
    return 0;
  }
}).reduce((a, b) => a + b, 0);
const onlineCount = PACKAGES.map((p) => {
  const dir = path.join(ROOT, 'packages', p, 'prisma', 'online');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}).reduce((a, b) => a + b, 0);

// A gate that reports success having scanned nothing is worse than no gate, and
// this one nearly did: adding the 2.0 folder made the count read 0 for a while
// because the counter and the scanner disagreed about what they were iterating.
if (counted === 0) {
  console.error(
    '✗ migration safety: scanned 0 migrations. Every folder in MIGRATION_DIRS is missing or ' +
      'empty, so every rule above passed by never running.',
  );
  process.exit(1);
}

console.log(
  `migration safety check passed: ${counted} migration(s) and ${onlineCount} online script(s) ` +
    `scanned with comments and string literals scrubbed; no CONCURRENTLY in the transactional ` +
    `track, no unqualified search_path-sensitive call in an index expression, generated column, ` +
    `CHECK or DEFAULT, no unqualified now() or gen_random_uuid() anywhere, no bare ` +
    `timestamptz cast, and every online script idempotent. ` +
    `${baseline.length} finding(s) accepted as applied history, every one still matching.`,
);
