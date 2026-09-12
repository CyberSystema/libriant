#!/usr/bin/env tsx
// Every Postgres session this product opens is UTC, and this is the gate.
//
// ## THE PRECONDITION NOBODY WROTE DOWN
//
// `@prisma/adapter-pg` requires a UTC session and does not say so.
// `packages/shared/src/postgres-session.ts` carries the whole measurement; the
// short version is that both halves of its `timestamptz` handling assume it and
// both are silent when it is false:
//
//     WRITE   a JS Date reaches the server as `2026-03-01 10:00:00` — naive, no
//             zone — so Postgres resolves it in the SESSION zone. node-pg, by
//             contrast, sends `2026-03-01T12:00:00.000+02:00`.
//     READ    `normalize_timestamptz` strips the rendered offset and asserts
//             `+00:00`, declaring the local wall clock to be UTC.
//
// The two errors are equal and opposite, so a Prisma-only round trip agrees with
// itself and nothing inside the application can notice. What is wrong is the
// instant physically stored — by the offset AT THAT INSTANT, so two hours in
// winter and three in summer — and, on the spring-forward night, the value
// itself: MEASURED, `2027-03-28T03:30:00Z` written and read back as
// `04:30:00Z`, silently, because that local time does not exist.
//
// ## WHY A STATIC GATE AND NOT A RUNTIME CHECK
//
// Because the runtime check cannot fail on the machines that run it. Every
// deployed cluster is UTC — `postgres:16-alpine` ships no TZ, in both compose
// files and in CI — so the offset is zero and the defect is invisible. The one
// cluster that is NOT UTC is a developer's local Postgres. A gate is the only
// instrument that says the same thing everywhere.
//
// `apps/api/test/integration/session-timezone.spec.ts` is the other half: it
// makes its OWN non-UTC database and proves the option is load-bearing. This
// gate proves the option is THERE. Neither substitutes for the other — a literal
// is not a session, and a session on one machine is not a rule.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/** Trees that may open a Postgres connection or create a database. */
const ROOTS = ['apps', 'packages', 'scripts', 'infra', '.github'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.sql', '.sh', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '.git']);

/** The one file allowed to spell the option. Everything else imports it. */
const OPTION_HOME = 'packages/shared/src/postgres-session.ts';

/**
 * The three Prisma client factories. There are no others, and that is the point:
 * `new PrismaPg` anywhere else is a pool nobody pinned.
 */
const FACTORIES = ['packages/db-tenant/src/client.ts', 'packages/db-control/src/client.ts'];

/**
 * `CREATE DATABASE` sites that legitimately carry no pin, each with its reason.
 *
 * An entry that stops matching FAILS, on the rule every gate here follows: a
 * list of accepted exceptions that no longer describes the tree is a list nobody
 * reads.
 */
const CREATE_WITHOUT_PIN: Readonly<Record<string, string>> = {
  'apps/api/src/provisioning/tenant-defaults.spec.ts':
    'A sibling gate. It DISCOVERS provisioners by looking for the same phrase this one does, so ' +
    'it carries it as a pattern and in the reason for its own exception. It opens no connection ' +
    'and creates nothing.',
  'scripts/dr-drill.sh':
    'The disaster-recovery drill builds a throwaway cluster and then restores it from pg_dumpall, ' +
    'which carries the source cluster’s per-database settings — the pin among them. A pin beside ' +
    'these CREATEs would assert the very property the drill exists to VERIFY was restored, and ' +
    'would mask a restore that lost it.',
};

/** This file. It quotes every pattern it hunts, so it matches itself. */
const SELF = 'scripts/check-session-timezone.ts';

/**
 * Blank COMMENTS, and only comments.
 *
 * `check-advisory-locks.ts` blanks string bodies too, because the token it hunts
 * lives inside SQL template literals and its doc mentions do not. This gate is
 * the other way round: the things it looks for — an option string, an ALTER
 * DATABASE, a URL parameter — are all INSIDE string literals, and it is the
 * prose about them that produces false positives. Blank one, keep the other.
 *
 * BLOCK COMMENTS ONLY IN TYPESCRIPT, and that restriction is not pedantry: a
 * shell script is full of path GLOBS that open and close like a block comment,
 * so a language-blind block-comment stripper swallows everything between two of
 * them. It did —
 * `scripts/dr-drill.sh` went from three `CREATE DATABASE` matches to zero, and
 * the gate reported the allowance covering them as stale rather than reporting
 * the sites. A stripper that removes more than it should turns a gate green.
 *
 * Line comments are matched by their leading token, which covers a docblock's
 * `*` continuation lines and every whole-line `//`, `#` and `--`. A trailing
 * comment on a line of code survives, which is the safe direction: this gate
 * over-reports rather than under-reports, and an over-report is one line to fix.
 */
function blankComments(source: string, file: string): string {
  const isTs = /\.(ts|tsx|mts)$/.test(file);
  const withoutBlocks = isTs
    ? source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    : source;
  return withoutBlocks
    .split('\n')
    .map((line) => (/^\s*(\*|\/\/|#|--)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const files: string[] = [];
for (const r of ROOTS) {
  const dir = path.join(ROOT, r);
  try {
    if (statSync(dir).isDirectory()) walk(dir, files);
  } catch {
    // A tree that is not present in this checkout is not a failure.
  }
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

let optionHomeSeen = false;
let factoriesSeen = 0;
let createSites = 0;
const allowedUsed = new Set<string>();

for (const file of files) {
  const r = rel(file);
  if (r === SELF) continue;
  const text = blankComments(readFileSync(file, 'utf8'), file);

  // R2 — the option is spelled in exactly one file.
  const literal = /-c\s+timezone\s*=/i.exec(text);
  if (literal) {
    if (r === OPTION_HOME) optionHomeSeen = true;
    else if (!/PG_SESSION_OPTIONS/.test(text)) {
      fail(
        `${r}:${lineOf(text, literal.index)} spells the session option as a literal.\n      ` +
          `Import PG_SESSION_OPTIONS from @libriant/shared/postgres-session instead. Three copies ` +
          'of a string is three chances for one of them to be edited, and the failure mode of the ' +
          'odd one out is silent.',
      );
    }
  }

  // R1/R2 — every PrismaPg carries the option, and only the factories build one.
  for (const m of text.matchAll(/new PrismaPg\s*\(/g)) {
    const at = lineOf(text, m.index);
    if (!FACTORIES.includes(r)) {
      fail(
        `${r}:${at} constructs a Prisma pg adapter outside the three client factories.\n      ` +
          `Build it in ${FACTORIES.join(' or ')}, which carry PG_SESSION_OPTIONS. An adapter ` +
          'without that option is a pool on whatever timezone the server happens to have, and ' +
          'every instant it writes is stored wrong by that offset.',
      );
      continue;
    }
    const tail = text.slice(m.index, m.index + 400);
    // `v2SessionOptions(schema)` is accepted alongside the bare constant (2.0
    // phase 20f). It RETURNS `PG_SESSION_OPTIONS` with the tenant's
    // `search_path` appended — the 2.0 connection needs both, and building the
    // string at the call site would be the third copy this gate exists to
    // prevent. `v2.ts` composes it from the constant, and
    // `schema-binding-v2.spec.ts` asserts the result still carries the UTC pin,
    // so accepting the helper does not widen the hole.
    if (!/options:\s*(PG_SESSION_OPTIONS|v2SessionOptions\()/.test(tail)) {
      fail(
        `${r}:${at} constructs a Prisma pg adapter without \`options: PG_SESSION_OPTIONS\`.\n      ` +
          'See packages/shared/src/postgres-session.ts for what a non-UTC session does to every ' +
          'timestamptz it writes.',
      );
    }
  }
  if (FACTORIES.includes(r) && /new PrismaPg\s*\(/.test(text)) factoriesSeen += 1;

  // R4 — the option must NEVER travel on a URL.
  //
  // MEASURED: `withV2Schema` (packages/db-tenant/src/v2.ts) puts the schema on
  // with `searchParams.set`, and URLSearchParams re-serialises a space as `+`.
  // `?options=-c%20timezone%3DUTC` survives one `set()` as
  // `options=-c+timezone%3DUTC`, which node-pg accepts silently and libpq
  // answers with `FATAL: unrecognized configuration parameter "+timezone"`. So
  // the app would look fine while psql, pg_dump and `prisma migrate deploy`
  // broke.
  for (const m of text.matchAll(/[?&]options=|searchParams\.set\(\s*['"`]options['"`]/g)) {
    fail(
      `${r}:${lineOf(text, m.index)} puts \`options\` on a connection URL.\n      ` +
        'It must go on the adapter/pool config instead. URLSearchParams re-encodes the space as ' +
        '`+`, and libpq then answers FATAL: unrecognized configuration parameter "+timezone" — ' +
        'while node-pg accepts it silently, so only psql, pg_dump and migrate break.',
    );
  }

  // R5 — nothing may move the session zone at runtime; a session SET outranks
  // the connection option and is invisible to every check above.
  // `SET TIME ZONE 'x'` / `SET timezone = 'x'` / `SET timezone TO 'x'`. The
  // trailing zone is what distinguishes a statement from a sentence: an
  // assertion message that says "a session-level SET TIME ZONE would" is prose,
  // and a gate that cannot tell is a gate somebody turns off.
  for (const m of text.matchAll(
    /\bSET\s+(SESSION\s+)?(TIME\s+ZONE|timezone)\s*(=|TO)?\s*['"`$]/gi,
  )) {
    if (r === OPTION_HOME) continue;
    // `ALTER DATABASE … SET TimeZone` is the MECHANISM, not a session SET: it
    // writes a per-database default (PGC_S_DATABASE) that the connection option
    // still outranks. Only a SESSION-scoped SET is the thing that silently
    // disables the fix.
    // The SAME STATEMENT, not a fixed-width window: `ALTER DATABASE "${DB}" SET
    // TimeZone …` is longer than any window worth guessing at once the database
    // name is an interpolation.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/ALTER\s+(DATABASE|ROLE|SYSTEM)/i.test(text.slice(lineStart, m.index))) continue;
    fail(
      `${r}:${lineOf(text, m.index)} sets the session time zone.\n      ` +
        'A session SET is PGC_S_SESSION and OUTRANKS the connection option, so it silently ' +
        'disables the fix for that backend — and on a pool it lands on one connection out of ' +
        'several, which makes the result depend on which one you get.',
    );
  }

  // R3 — every CREATE DATABASE is pinned in the same file.
  for (const m of text.matchAll(/CREATE\s+DATABASE/gi)) {
    // A REGEX LITERAL is not a creation site. `check-permissions.ts` and
    // friends carry `/CREATE DATABASE/` as a pattern they hunt for, and a gate
    // that failed another gate for containing its own subject would be
    // unusable.
    if (text[m.index - 1] === '/') continue;
    createSites += 1;
    const pinned =
      /pinDatabaseTimezoneSql|ALTER\s+DATABASE[^;]*SET\s+TimeZone/i.test(text) ||
      /timezone=UTC/i.test(text);
    if (pinned) continue;
    const allowance = CREATE_WITHOUT_PIN[r];
    if (allowance) {
      allowedUsed.add(r);
      continue;
    }
    fail(
      `${r}:${lineOf(text, m.index)} creates a database and never pins its timezone.\n      ` +
        'Call `pinDatabaseTimezoneSql(dbName)` from @libriant/shared/postgres-session beside it ' +
        "(or `ALTER DATABASE … SET TimeZone TO 'UTC'` in SQL). MEASURED: the setting is NOT " +
        'inherited — `CREATE DATABASE child TEMPLATE pinned` came back Europe/Athens — so this ' +
        'is a per-site obligation and a template cannot be trusted for it.',
    );
  }
}

if (!optionHomeSeen) {
  fail(
    `${OPTION_HOME} no longer spells the session option.\n      ` +
      'That file is where the precondition and its measurement live. If the option moved, move ' +
      'this gate with it; if @prisma/adapter-pg fixed `normalize_timestamptz` upstream, delete ' +
      'both and say so there.',
  );
}
if (factoriesSeen !== FACTORIES.length) {
  fail(
    `expected ${FACTORIES.length} Prisma client factories to build an adapter, found ${factoriesSeen}.\n      ` +
      'A factory that stopped building one, or a new one that this gate does not know about, is ' +
      'exactly the pool that would go unpinned.',
  );
}
for (const [file, reason] of Object.entries(CREATE_WITHOUT_PIN)) {
  if (allowedUsed.has(file)) continue;
  fail(
    `the allowance for ${file} matches no unpinned CREATE DATABASE any more.\n      ` +
      `Its reason was: ${reason}\n      ` +
      'Delete the entry — a list of accepted exceptions that no longer describes the tree is a ' +
      'list nobody reads.',
  );
}

if (problems.length) {
  console.error(`✗ session timezone: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

console.log(
  `session timezone ok — ${files.length} file(s) scanned across ${ROOTS.length} tree(s); the ` +
    `option is spelled once in ${OPTION_HOME} and imported by ${factoriesSeen} client factor(ies); ` +
    `${createSites} CREATE DATABASE site(s), every one pinned or recorded with a reason ` +
    `(${Object.keys(CREATE_WITHOUT_PIN).length} allowance(s), all still matching); no \`options\` ` +
    'on a URL and no session-level SET TIME ZONE. The runtime half is ' +
    'apps/api/test/integration/session-timezone.spec.ts, which makes its own non-UTC database.',
);
