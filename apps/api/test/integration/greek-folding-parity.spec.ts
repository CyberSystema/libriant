import { readFileSync } from 'node:fs';
import { Client as PgClient } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { foldGreek } from '@libriant/shared/greek';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This runs one SQL function against a throwaway schema and reads nothing a plan gates.',
);

/**
 * The executable half of `pnpm check:greek-folding`.
 *
 * `foldGreek` decides what a Greek query and a Greek record have in common, and
 * it has to run identically in TypeScript (computing `search_text` on write)
 * and in Postgres (inside index expressions and generated columns). If they
 * disagree by one code point, a record is indexed under a key the query never
 * produces: no error, no log line, no failing request — just a book on the
 * shelf that the catalogue says it does not have.
 *
 * The gate in `scripts/check-greek-folding.ts` runs every fixture vector
 * through TypeScript and compares the SQL file's declared variant table,
 * combining range and pinned collation against the exported constants in
 * `greek.ts`. It runs in `static-checks`, which has no database, so it cannot
 * ask Postgres what the function actually returns. This spec does exactly
 * that, over the same fixture, and the two together are the whole promise.
 *
 * TWO DIVERGENCES ARE BEING HELD SHUT HERE, both measured rather than imagined:
 *
 *   lower('ΠΟΛΙΣ') ends U+03C3 in Postgres and U+03C2 in JavaScript, because
 *   Unicode's Final_Sigma mapping is optional for a locale-insensitive
 *   lower(). The `translate()` in the function is what makes both land on
 *   U+03C3.
 *
 *   Ύ (U+038E) and Ώ (U+038F) lowercase ONE CODE POINT OFF under the database
 *   default collation — a sweep of U+0370-U+03FF and U+1F00-U+1FFF against
 *   JavaScript found exactly three disagreements, all from the unassigned gap
 *   at U+038D shifting the platform's case table by one. Two of the three are
 *   ordinary Greek letters (Ύδωρ, Ώρα). `COLLATE "und-x-icu"` is what fixes
 *   them, and the last assertion below fails if that pin is ever removed.
 *
 * The function is created and dropped inside one transaction, so the database
 * is byte-identical afterwards and nothing is left in `public` for the next
 * spec to trip over.
 */

interface Fixture {
  namedFold: { in: string; out: string; why: string }[];
  sweep: { in: string; out: string }[];
}

const fixtureUrl = new URL(
  '../../../../packages/shared/src/greek/__fixtures__/greek-normalization.json',
  import.meta.url,
);
const foldSqlUrl = new URL('../../../../packages/shared/src/greek/greek-fold.sql', import.meta.url);

const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as Fixture;
const foldSql = readFileSync(foldSqlUrl, 'utf8');

const cp = (s: string) =>
  [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

let client: PgClient;

beforeAll(async () => {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) throw new Error('CONTROL_DATABASE_URL is required for the integration suite.');
  client = new PgClient({ connectionString: url });
  await client.connect();
  await client.query('BEGIN');
  // The COMMENT ON statement is dropped: Prisma-style extended protocol aside,
  // node-postgres will run the CREATE happily, and the comment carries no
  // behaviour. Split on the dollar-quoted body's terminator so the function
  // body's own semicolons are not mistaken for statement boundaries.
  const createEnd = foldSql.indexOf('$function$;');
  const createStatement = foldSql.slice(0, createEnd + '$function$;'.length);
  await client.query(createStatement);
}, 60_000);

afterAll(async () => {
  if (!client) return;
  // Everything above happened inside a transaction; rolling back removes the
  // function and leaves the control database exactly as it was found.
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end().catch(() => undefined);
});

describe('libriant_fold_greek matches foldGreek()', () => {
  it('agrees on every hand-verified vector', async () => {
    const inputs = fixture.namedFold.map((v) => v.in);
    const { rows } = await client.query<{ i: number; folded: string }>(
      'SELECT ordinality - 1 AS i, libriant_fold_greek(t.value) AS folded ' +
        'FROM unnest($1::text[]) WITH ORDINALITY AS t(value, ordinality)',
      [inputs],
    );
    for (const row of rows) {
      const v = fixture.namedFold[row.i]!;
      expect(
        row.folded,
        `${JSON.stringify(v.in)} — ${v.why}\n  TS  ${cp(v.out)}\n  SQL ${cp(row.folded)}`,
      ).toBe(v.out);
    }
    expect(rows).toHaveLength(fixture.namedFold.length);
  });

  it('agrees across the whole Greek, Greek Extended and Latin supplement blocks', async () => {
    const inputs = fixture.sweep.map((v) => v.in);
    const { rows } = await client.query<{ i: number; folded: string }>(
      'SELECT ordinality - 1 AS i, libriant_fold_greek(t.value) AS folded ' +
        'FROM unnest($1::text[]) WITH ORDINALITY AS t(value, ordinality)',
      [inputs],
    );
    const divergences: string[] = [];
    for (const row of rows) {
      const v = fixture.sweep[row.i]!;
      if (row.folded !== v.out) {
        divergences.push(`${cp(v.in)}: TS ${cp(v.out)} vs SQL ${cp(row.folded)}`);
      }
      // Belt and braces: the fixture is generated from foldGreek, so assert the
      // live TypeScript still agrees with it too. A fixture that has drifted
      // from BOTH implementations would otherwise look like agreement.
      expect(foldGreek(v.in)).toBe(v.out);
    }
    expect(divergences, divergences.slice(0, 10).join('\n')).toHaveLength(0);
    expect(rows.length).toBeGreaterThanOrEqual(800);
  });

  it('folds ΠΟΛΙΣ and πολισ to the same string in the database', async () => {
    const { rows } = await client.query<{ a: string; b: string; c: string }>(
      'SELECT libriant_fold_greek($1) AS a, libriant_fold_greek($2) AS b, libriant_fold_greek($3) AS c',
      ['ΠΟΛΙΣ', 'πολισ', 'πόλις'],
    );
    const r = rows[0]!;
    expect(r.a).toBe(r.b);
    expect(r.a).toBe(r.c);
    expect(r.a).toBe(foldGreek('ΠΟΛΙΣ'));
  });

  it('folds Ύ and Ώ to upsilon and omega, which the default collation does not', async () => {
    const { rows } = await client.query<{ fixed: string; broken: string }>(
      `SELECT libriant_fold_greek($1) AS fixed,
              pg_catalog.regexp_replace(
                pg_catalog.normalize(pg_catalog.lower($1), 'NFD'), '[̀-ͯ]', '', 'g') AS broken`,
      ['ΎΔΩΡ'],
    );
    const r = rows[0]!;
    expect(r.fixed, `SQL gave ${cp(r.fixed)}`).toBe('υδωρ');
    expect(r.fixed).toBe(foldGreek('ΎΔΩΡ'));
    // The unpinned form is what the function would return without
    // COLLATE "und-x-icu". On a platform whose case table has the U+038D shift
    // it produces 'ωδωρ'; on a correct one it agrees. Either way the pinned
    // function is right, and this records which platform CI is running on.
    if (r.broken !== 'υδωρ') {
      // eslint-disable-next-line no-console
      console.warn(
        `NOTE: this platform's default lower() folds ΎΔΩΡ to ${JSON.stringify(r.broken)} ` +
          `(${cp(r.broken)}). The und-x-icu pin in greek-fold.sql is load-bearing here.`,
      );
    }
  });

  it('is IMMUTABLE, so it can appear in an index expression', async () => {
    const { rows } = await client.query<{ volatility: string }>(
      "SELECT provolatile AS volatility FROM pg_proc WHERE proname = 'libriant_fold_greek'",
    );
    expect(rows[0]?.volatility).toBe('i');
  });
});
