#!/usr/bin/env tsx
// One fold, four runtimes, one gate.
//
// `foldGreek` decides what a Greek search term and a Greek record have in
// common. It has to run in FOUR places that can never see each other:
//
//   1. TypeScript          — computing search_text when a record is written.
//   2. Postgres            — `libriant_fold_greek`, inside index expressions
//                            and generated columns (greek/greek-fold.sql).
//   3. The OpenSearch analysis chain   (phase 82).
//   4. The desktop client's Rust core  (phase 77), folding offline in the stacks.
//
// If any two disagree by one code point, a record is indexed under a key the
// query never produces. There is no error, no log line and no failing request:
// there is a book on the shelf that the catalogue says it does not have. That
// failure is invisible from every side, which is why it gets a build gate
// rather than a test.
//
// TWO DIVERGENCES WERE ALREADY MEASURED between runtimes 1 and 2, before
// either was written down:
//
//   - lower('ΠΟΛΙΣ') ends U+03C3 in Postgres and U+03C2 in JavaScript, because
//     Unicode's Final_Sigma rule is optional for a locale-insensitive lower().
//   - Ύ (U+038E) and Ώ (U+038F) lowercase one code point off under the
//     database's default collation, so every Greek word beginning with an
//     accented capital upsilon or omega folded to the WRONG LETTER in the
//     database and the right one in the application.
//
// Both are repaired in greek-fold.sql, and the fixture is what keeps them
// repaired.
//
// WHAT THIS GATE CHECKS, all without a database, so it runs in `static-checks`:
//
//   1. Every fixture vector, through the TypeScript implementation. The
//      `named*` sets assert the fold is CORRECT; the `sweep` set (the whole
//      Greek, Greek Extended and Latin supplement blocks) asserts it is STABLE,
//      which is the property the other three runtimes are held to.
//   2. The SQL implementation's variant table, combining range and pinned
//      collation, compared against the exported contract constants in
//      greek.ts. This is the drift that actually happens: someone adds a
//      letter to VARIANT_FROM and does not know there is a second copy.
//
// WHAT IT DELIBERATELY DOES NOT CHECK: that Postgres, given the fixture,
// produces the fixture. That needs a database, `static-checks` has none, and
// this phase adds no dependency to reach one. It is asserted for real in
// `apps/api/test/integration/greek-folding-parity.spec.ts`, which runs against
// the live Postgres in the `integration-tests` job. Both halves are wired into
// CI; neither is optional, and neither is silently skipped.
//
// Run through tsx, not plain node: greek.ts is imported here with a `.js`
// specifier, which Node's type stripping does not resolve to a `.ts` file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  foldGreek,
  greekPhoneticKey,
  stripNonfilingArticle,
  toAlaLc,
  toIso843Type1,
  toIso843Type2,
  GREEK_COMBINING_RANGE,
  GREEK_VARIANT_FROM,
  GREEK_VARIANT_TO,
} from '../packages/shared/src/greek.js';

const root = new URL('../packages/shared/src/greek/', import.meta.url);
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('__fixtures__/greek-normalization.json', root)), 'utf8'),
) as {
  namedFold: { in: string; out: string; why: string }[];
  namedPhonetic: { in: string; out: string; why: string }[];
  namedIso843Type1: { in: string; out: string; why: string }[];
  namedIso843Type2: { in: string; out: string; why: string }[];
  namedAlaLc: { in: string; out: string; why: string }[];
  namedNonfiling: { title: string; lang: string | null; skip: number; why: string }[];
  sweep: { in: string; out: string }[];
};
const sql = readFileSync(fileURLToPath(new URL('greek-fold.sql', root)), 'utf8');

const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);
const cp = (s: string) =>
  [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

// --- 1. the TypeScript implementation against every vector -----------------
let checked = 0;
const run = <T>(
  rows: T[],
  label: string,
  actual: (r: T) => string,
  expected: (r: T) => string,
  describe: (r: T) => string,
) => {
  for (const row of rows) {
    checked += 1;
    const got = actual(row);
    if (got !== expected(row)) {
      fail(
        `${label}: ${describe(row)}\n        expected ${JSON.stringify(expected(row))} [${cp(expected(row))}]` +
          `\n        got      ${JSON.stringify(got)} [${cp(got)}]`,
      );
    }
  }
};

run(
  fixture.namedFold,
  'foldGreek',
  (v) => foldGreek(v.in),
  (v) => v.out,
  (v) => `${JSON.stringify(v.in)} — ${v.why}`,
);
run(
  fixture.sweep,
  'foldGreek (sweep)',
  (v) => foldGreek(v.in),
  (v) => v.out,
  (v) => cp(v.in),
);
run(
  fixture.namedPhonetic,
  'greekPhoneticKey',
  (v) => greekPhoneticKey(v.in),
  (v) => v.out,
  (v) => `${JSON.stringify(v.in)} — ${v.why}`,
);
run(
  fixture.namedIso843Type1,
  'toIso843Type1',
  (v) => toIso843Type1(v.in),
  (v) => v.out,
  (v) => `${JSON.stringify(v.in)} — ${v.why}`,
);
run(
  fixture.namedIso843Type2,
  'toIso843Type2 (ELOT 743)',
  (v) => toIso843Type2(v.in),
  (v) => v.out,
  (v) => `${JSON.stringify(v.in)} — ${v.why}`,
);
run(
  fixture.namedAlaLc,
  'toAlaLc',
  (v) => toAlaLc(v.in),
  (v) => v.out,
  (v) => `${JSON.stringify(v.in)} — ${v.why}`,
);
for (const v of fixture.namedNonfiling) {
  checked += 1;
  const got = stripNonfilingArticle(v.title, v.lang).skip;
  if (got !== v.skip) {
    fail(
      `stripNonfilingArticle: ${JSON.stringify(v.title)} — ${v.why}\n        expected skip ${v.skip}, got ${got}`,
    );
  }
}

if (fixture.sweep.length < 800) {
  fail(
    `the sweep has only ${fixture.sweep.length} vectors. It must cover the Greek (U+0370-U+03FF), ` +
      `Greek Extended (U+1F00-U+1FFF) and Latin supplement blocks, or the other runtimes are ` +
      `being held to a corner of the alphabet.`,
  );
}

// --- 2. the SQL implementation states the same contract --------------------
//
// Parsed, not executed. The two literals below are the entire semantic content
// of the SQL function that is not fixed by its structure, and they are exactly
// what someone editing greek.ts would forget to change.
/**
 * Extract the two variant tables from the SQL by finding the balanced span of
 * `pg_catalog.translate( ... )` and taking its LAST two quoted literals.
 *
 * A single regex is not enough and the first attempt proved it: `translate()`
 * wraps a `regexp_replace(..., '[combining]', '', 'g')`, so a lazy match for
 * "two quoted strings before a close paren" happily returned `''` and `'g'`
 * from the inner call. The gate reported a divergence that did not exist,
 * which is the good failure mode — but it would have reported nothing had the
 * inner call been the one that drifted.
 */
function extractTranslateTables(source: string): [string, string] | null {
  const open = source.indexOf('pg_catalog.translate(');
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open + 'pg_catalog.translate'.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const span = source.slice(open, end);
  const literals = [...span.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  if (literals.length < 2) return null;
  return [literals[literals.length - 2] as string, literals[literals.length - 1] as string];
}

const translateArgs = extractTranslateTables(sql);
if (!translateArgs) {
  fail(
    'greek-fold.sql: could not find the pg_catalog.translate(...) variant table. If the function ' +
      'was restructured, this gate has to be taught the new shape — it must not simply stop looking.',
  );
} else {
  const [sqlFrom, sqlTo] = translateArgs;
  if (sqlFrom !== GREEK_VARIANT_FROM) {
    fail(
      `greek-fold.sql variant SOURCE table differs from GREEK_VARIANT_FROM in greek.ts.\n` +
        `        ts  ${JSON.stringify(GREEK_VARIANT_FROM)} [${cp(GREEK_VARIANT_FROM)}]\n` +
        `        sql ${JSON.stringify(sqlFrom)} [${cp(sqlFrom)}]`,
    );
  }
  if (sqlTo !== GREEK_VARIANT_TO) {
    fail(
      `greek-fold.sql variant TARGET table differs from GREEK_VARIANT_TO in greek.ts.\n` +
        `        ts  ${JSON.stringify(GREEK_VARIANT_TO)} [${cp(GREEK_VARIANT_TO)}]\n` +
        `        sql ${JSON.stringify(sqlTo)} [${cp(sqlTo)}]`,
    );
  }
  if (sqlFrom.length !== sqlTo.length) {
    fail(
      `greek-fold.sql: translate() tables are ${sqlFrom.length} and ${sqlTo.length} characters. ` +
        `Postgres silently DELETES characters with no counterpart, so an uneven pair would drop ` +
        `letters from every folded string.`,
    );
  }
}

if (GREEK_VARIANT_FROM.length !== GREEK_VARIANT_TO.length) {
  fail(
    `greek.ts: GREEK_VARIANT_FROM has ${GREEK_VARIANT_FROM.length} characters and ` +
      `GREEK_VARIANT_TO has ${GREEK_VARIANT_TO.length}. They are zipped pairwise.`,
  );
}

const rangeInSql = /regexp_replace\(\s*[\s\S]*?'\[(.)-(.)\]'/.exec(sql);
if (!rangeInSql) {
  fail('greek-fold.sql: could not find the combining-mark character class.');
} else {
  const first = rangeInSql[1]!.codePointAt(0)!;
  const last = rangeInSql[2]!.codePointAt(0)!;
  if (first !== GREEK_COMBINING_RANGE.first || last !== GREEK_COMBINING_RANGE.last) {
    fail(
      `greek-fold.sql strips U+${first.toString(16).toUpperCase().padStart(4, '0')}-` +
        `U+${last.toString(16).toUpperCase().padStart(4, '0')}, greek.ts strips ` +
        `U+${GREEK_COMBINING_RANGE.first.toString(16).toUpperCase().padStart(4, '0')}-` +
        `U+${GREEK_COMBINING_RANGE.last.toString(16).toUpperCase().padStart(4, '0')}. ` +
        `U+0345 (the polytonic iota subscript) sits inside this range and is stripped by it.`,
    );
  }
}

if (!/COLLATE\s+"und-x-icu"/.test(sql)) {
  fail(
    'greek-fold.sql no longer pins `COLLATE "und-x-icu"` on lower(). Without it the database ' +
      'default applies, and Ύ (U+038E) and Ώ (U+038F) lowercase one code point off — every ' +
      'Greek word starting with an accented capital upsilon or omega folds to the wrong letter.',
  );
}
if (!/\bIMMUTABLE\b/.test(sql)) {
  fail(
    'greek-fold.sql: the function must be IMMUTABLE or it cannot appear in an index expression.',
  );
}
for (const call of ['btrim', 'regexp_replace', 'translate', 'normalize', 'lower']) {
  if (!new RegExp(`pg_catalog\\.${call}\\b`).test(sql)) {
    fail(
      `greek-fold.sql calls ${call}() without a pg_catalog. prefix. This repository has already ` +
        `shipped 20260825200000_qualify_immutable_unaccent to repair exactly that.`,
    );
  }
}

if (problems.length) {
  console.error(`✗ Greek folding: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(
    '\nA divergence here is never fixed by editing the expected value. Fix the implementation\n' +
      'that disagrees, or change every implementation together. A record indexed under a key\n' +
      'the query never produces is a book on the shelf that the catalogue denies having.',
  );
  process.exit(1);
}

const named =
  fixture.namedFold.length +
  fixture.namedPhonetic.length +
  fixture.namedIso843Type1.length +
  fixture.namedIso843Type2.length +
  fixture.namedAlaLc.length +
  fixture.namedNonfiling.length;
console.log(
  `greek folding check passed: ${checked} vectors through TypeScript (${named} hand-verified, ` +
    `${fixture.sweep.length} block sweep); greek-fold.sql declares the same ${GREEK_VARIANT_FROM.length}-letter ` +
    `variant table, the same U+0300-U+036F combining range and the pinned und-x-icu collation, ` +
    `with every call schema-qualified. Executable Postgres parity: ` +
    `apps/api/test/integration/greek-folding-parity.spec.ts.`,
);
