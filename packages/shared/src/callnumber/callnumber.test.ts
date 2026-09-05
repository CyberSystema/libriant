/**
 * Shelf-order tests for the call-number sort key.
 *
 * Run from `packages/shared`: node --import tsx --test "src/**{}/*.test.ts".
 *
 * The reference corpora are generated FROM COMPONENTS and sorted as the
 * numbers they are, not by calling the code under test — see the `$comment` in
 * each fixture. Three of the four bugs found while writing this file were
 * found by those corpora and by nothing else.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CALL_NUMBER_KEY_WIDTH,
  CALL_NUMBER_SCHEMES,
  callNumberKey,
  callNumberSortKey,
  compareCallNumbers,
  findShelfOrderIssues,
  type CallNumberScheme,
} from './index.js';

const load = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.json`, import.meta.url)), 'utf8'),
  ) as { scheme: CallNumberScheme; shelfOrder: string[] };

const named = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/named-orderings.json', import.meta.url)),
    'utf8',
  ),
) as { orderings: { scheme: CallNumberScheme; a: string; b: string; why: string }[] };

const CORPORA = ['ddc', 'lcc', 'nlm', 'udc'] as const;

test('every key is pure [0-9A-Z] and exactly one width', () => {
  // Not cosmetic. Under `el_GR.UTF-8` and `el-GR-x-icu`, punctuation is
  // variable-weighted: `AB|C` sorts BEFORE `ABC` in Postgres and AFTER `ABZ`
  // in JavaScript. Restricted to this alphabet the two orders are identical,
  // measured at zero mismatches over 4,000 random keys. A separator sneaking
  // into a key would make a shelf list computed in the browser disagree with
  // the same list computed by an ORDER BY, silently.
  for (const name of CORPORA) {
    const { scheme, shelfOrder } = load(name);
    for (const cn of shelfOrder) {
      const key = callNumberSortKey(scheme, cn);
      assert.match(key, /^[0-9A-Z]+$/, `${scheme} ${cn} -> ${JSON.stringify(key)}`);
      assert.equal(key.length, CALL_NUMBER_KEY_WIDTH, `${scheme} ${cn}`);
    }
  }
});

test('a Greek call number still produces an ASCII key', () => {
  for (const cn of ['ΠΑΙΔ 123 Καζ', 'ΑΝΑΦ 005.133 ΚΕΡ', 'Ώρα 12']) {
    for (const scheme of CALL_NUMBER_SCHEMES) {
      assert.match(callNumberSortKey(scheme, cn), /^[0-9A-Z]+$/, `${scheme} ${cn}`);
    }
  }
});

for (const name of CORPORA) {
  test(`${name}: sorting the reference corpus by key reproduces shelf order`, () => {
    const { scheme, shelfOrder } = load(name);
    const sorted = [...shelfOrder].sort((a, b) => compareCallNumbers(scheme, a, b));
    const firstBad = shelfOrder.findIndex((v, i) => sorted[i] !== v);
    const inversions = shelfOrder.filter((v, i) => sorted[i] !== v).length;
    assert.equal(
      inversions,
      0,
      firstBad >= 0
        ? `${inversions} of ${shelfOrder.length} out of place; first at ${firstBad}: expected ` +
            `${shelfOrder[firstBad]}, got ${sorted[firstBad]}`
        : '',
    );
  });

  test(`${name}: the corpus is large enough to be worth trusting`, () => {
    const { shelfOrder } = load(name);
    assert.ok(
      shelfOrder.length >= (name === 'udc' ? 20 : 2000),
      `${name} has ${shelfOrder.length}`,
    );
  });
}

test('every hand-verified ordering', () => {
  for (const o of named.orderings) {
    assert.ok(
      compareCallNumbers(o.scheme, o.a, o.b) < 0,
      `${o.a} should file before ${o.b} — ${o.why}`,
    );
    assert.ok(compareCallNumbers(o.scheme, o.b, o.a) > 0, 'and the comparison is antisymmetric');
    assert.equal(compareCallNumbers(o.scheme, o.a, o.a), 0, 'and reflexive');
  }
});

test('a decimal that looks like a year is not a year', () => {
  // `005.1999 KER` — a looser year rule stripped the decimal and filed the
  // book under plain 005. 27 inversions in the Dewey corpus.
  assert.ok(compareCallNumbers('ddc', '005.1999 KER', '005.2 KER') < 0);
  assert.ok(compareCallNumbers('ddc', '005.1998 KER', '005.1999 KER') < 0);
});

test('a class number that looks like a year is not a year', () => {
  // `PA1999 .A2` — the same rule destroyed the class number of nearly every
  // LC record whose number happened to look like a date. 1,948 of 2,000.
  assert.ok(compareCallNumbers('lcc', 'PA1999 .A2', 'PA2000 .A2') < 0);
  assert.ok(compareCallNumbers('lcc', 'PA999 .A2', 'PA1999 .A2') < 0);
});

test('the volume designator T does not eat LC class T', () => {
  // `T` is the Greek tomos folded to ASCII and also an LC class letter.
  // Accepting a bare `T665` as "volume 665" filed every technology book under
  // A — and the NLM corpus, which has no class T, reported zero inversions
  // throughout, which is exactly how a bug of this shape survives a smaller
  // test set.
  const key = callNumberKey('lcc', 'T665 .A405 1979');
  assert.ok(key.key.startsWith('00000000T'), key.key);
  assert.ok(compareCallNumbers('lcc', 'T665 .A405', 'T9955 .A548') < 0);
  // A real volume designation, which carries its dot, still works.
  assert.ok(compareCallNumbers('ddc', '005.1 KER t.3', '005.1 KER t.10') < 0);
  assert.ok(compareCallNumbers('ddc', '005.1 KER v.3', '005.1 KER v.10') < 0);
});

test('the Greek volume and copy designations work', () => {
  assert.ok(compareCallNumbers('ddc', '005.1 KER τ.3', '005.1 KER τ.10') < 0);
  assert.ok(compareCallNumbers('ddc', '005.1 KER αντ.1', '005.1 KER αντ.2') < 0);
});

test('a cutter is a decimal fraction', () => {
  assert.ok(compareCallNumbers('lcc', 'PA4037 .A2', 'PA4037 .A21') < 0);
  assert.ok(compareCallNumbers('lcc', 'PA4037 .A19', 'PA4037 .A2') < 0);
});

test('UDC auxiliaries file in the published sign order', () => {
  // Independent regexes matched inside one another: the language pattern found
  // `=411.16` inside the ethnic auxiliary `(=411.16)`, ranking it twice.
  const order = [
    '02',
    '02=14',
    '02(0.034)',
    '02(031)',
    '02(410)',
    '02(=411.16)',
    '02"19"',
    '02*ABC',
    '02-05',
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      compareCallNumbers('udc', order[i - 1] as string, order[i] as string) < 0,
      `${order[i - 1]} should file before ${order[i]}`,
    );
  }
});

test('a point-nought auxiliary is not part of the main number', () => {
  assert.ok(compareCallNumbers('udc', '027.022', '027.4') < 0);
  assert.ok(compareCallNumbers('udc', '621.3', '621.39') < 0, 'but .3 is a real subdivision');
});

test('digit runs in a local shelf code compare numerically', () => {
  assert.ok(compareCallNumbers('alphanum', 'A9', 'A10') < 0);
  assert.ok(compareCallNumbers('local', 'ΠΑΙΔ 2', 'ΠΑΙΔ 10') < 0);
});

test('a malformed number never throws and is flagged instead', () => {
  // A librarian's typo must not be able to 500 a shelf list or abort an
  // inventory upload halfway through a 50,000-item session.
  for (const bad of ['', '   ', '???', '...', '---', 'ΑΒΓ', 'null', 'a'.repeat(500)]) {
    for (const scheme of CALL_NUMBER_SCHEMES) {
      const r = callNumberKey(scheme, bad);
      assert.match(r.key, /^[0-9A-Z]+$/, `${scheme} ${JSON.stringify(bad)}`);
      assert.equal(r.key.length, CALL_NUMBER_KEY_WIDTH);
      assert.equal(r.scheme, scheme);
    }
  }
  assert.equal(callNumberKey('ddc', '???').parsed, false, 'and says so');
  assert.equal(callNumberKey('ddc', '005.133').parsed, true);
});

test('the prefix files ahead of the number', () => {
  assert.ok(
    compareCallNumbers(
      'ddc',
      { prefix: 'J', callNumber: '999' },
      { prefix: 'REF', callNumber: '001' },
    ) < 0,
    'J before REF regardless of the number',
  );
});

test('shelf-order verification finds the swapped pair and only that pair', () => {
  const shelf = ['005.1 A', '005.2 A', '005.4 A', '005.3 A', '005.5 A'];
  const issues = findShelfOrderIssues('ddc', shelf, (x) => x);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.previous, '005.4 A');
  assert.equal(issues[0]?.item, '005.3 A');
  assert.equal(issues[0]?.index, 3);
  const inOrder = [...shelf].sort((a, b) => compareCallNumbers('ddc', a, b));
  assert.equal(findShelfOrderIssues('ddc', inOrder, (x) => x).length, 0);
});

test('comparison is a total order over each corpus', () => {
  for (const name of CORPORA) {
    const { scheme, shelfOrder } = load(name);
    const sample = shelfOrder.slice(0, 60);
    for (const a of sample) {
      for (const b of sample) {
        // Summed rather than negated-and-compared: Math.sign(0) is 0 and
        // -Math.sign(0) is -0, which assert.equal distinguishes.
        assert.equal(
          Math.sign(compareCallNumbers(scheme, a, b)) + Math.sign(compareCallNumbers(scheme, b, a)),
          0,
          `${a} vs ${b}`,
        );
      }
    }
  }
});
