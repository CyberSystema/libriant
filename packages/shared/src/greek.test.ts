/**
 * Golden tests for the Greek fold and the three romanizations.
 *
 * Run from `packages/shared`: `node --import tsx --test "src/**\/*.test.ts"`.
 *
 * The fixture carries two kinds of vector and they prove different things —
 * see the `$comment` in `greek/__fixtures__/greek-normalization.json`. The
 * `named*` sets assert that the fold is CORRECT; the `sweep` set asserts only
 * that every runtime computes the SAME thing, and is what
 * `scripts/check-greek-folding.mjs` puts through Postgres.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  asciiFoldGreek,
  foldGreek,
  fromIso843Type1,
  greekPhoneticKey,
  GREEK_STOPWORDS,
  stripNonfilingArticle,
  toAlaLc,
  toIso843Type1,
  toIso843Type2,
} from './greek.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./greek/__fixtures__/greek-normalization.json', import.meta.url)),
    'utf8',
  ),
) as {
  namedFold: { in: string; out: string; why: string }[];
  namedPhonetic: { in: string; out: string; why: string }[];
  namedIso843Type1: { in: string; out: string; why: string }[];
  namedIso843Type2: { in: string; out: string; why: string }[];
  namedAlaLc: { in: string; out: string; why: string }[];
  namedNonfiling: { title: string; lang: string | null; skip: number; why: string }[];
  sweep: { in: string; out: string }[];
};

const cp = (s: string) =>
  [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');

// --------------------------------------------------------------------------
// The defect this whole phase exists for
// --------------------------------------------------------------------------

test('ΠΟΛΙΣ, πολισ and πόλις all fold to one string', () => {
  // `'ΠΟΛΙΣ'.toLowerCase()` ends U+03C2 because Unicode's Final_Sigma rule
  // applies at a word boundary. A person typing into a search box produces
  // U+03C3. Before foldGreek, those were two different search keys and
  // `Η ΠΟΛΙΣ ΕΑΛΩ` could not be found by searching `πολισ`.
  assert.equal('ΠΟΛΙΣ'.toLowerCase().at(-1), 'ς', 'premise: toLowerCase gives final sigma');
  assert.equal(foldGreek('ΠΟΛΙΣ'), foldGreek('πολισ'));
  assert.equal(foldGreek('ΠΟΛΙΣ'), foldGreek('πόλις'));
  assert.equal(foldGreek('ΠΟΛΙΣ'), foldGreek('ΠΌΛΙΣ'));
  assert.equal(foldGreek('ΠΟΛΙΣ').at(-1), 'σ', 'and the survivor is the plain sigma');
});

test('a title catalogued in capitals is findable by an ordinary query', () => {
  assert.ok(foldGreek('Η ΠΟΛΙΣ ΕΑΛΩ').includes(foldGreek('πολισ')));
});

test('Ύ and Ώ fold to upsilon and omega', () => {
  // The database default collation folds these one code point off — see the
  // measurement in greek/greek-fold.sql. JavaScript is correct; the SQL
  // function pins an ICU collation so that both agree.
  assert.equal(foldGreek('ΎΔΩΡ'), 'υδωρ', cp(foldGreek('ΎΔΩΡ')));
  assert.equal(foldGreek('Ώρα'), 'ωρα', cp(foldGreek('Ώρα')));
});

test('polytonic Greek folds without a special case', () => {
  // U+0345 COMBINING GREEK YPOGEGRAMMENI is 0x345, inside the 0x300-0x36F
  // combining range, so the iota subscript is stripped by the same rule as a
  // tonos. Asserted so that "tidying up" the range cannot silently drop it.
  for (const [input, expected] of [
    ['ᾍ', 'α'],
    ['ᾳ', 'α'],
    ['ᾷ', 'α'],
    ['ᾮ', 'ω'],
    ['ᾅ', 'α'],
  ]) {
    assert.equal(
      foldGreek(input as string),
      expected,
      `${input} -> ${cp(foldGreek(input as string))}`,
    );
  }
});

// --------------------------------------------------------------------------
// Fixture-driven
// --------------------------------------------------------------------------

test('every named fold vector', () => {
  for (const v of fixture.namedFold) {
    assert.equal(foldGreek(v.in), v.out, `${JSON.stringify(v.in)} — ${v.why}`);
  }
});

test('the sweep vectors are stable', () => {
  // These are what the other runtimes are held to. If this fails, the
  // TypeScript implementation changed and every other implementation — the
  // Postgres function today, the OpenSearch analyzer and the Rust core later —
  // is now out of step. Regenerate the fixture ONLY together with them.
  for (const v of fixture.sweep) {
    assert.equal(foldGreek(v.in), v.out, `sweep ${cp(v.in)}`);
  }
  assert.ok(fixture.sweep.length >= 800, 'the sweep must cover the Greek and Latin blocks');
});

test('every named phonetic vector', () => {
  for (const v of fixture.namedPhonetic) {
    assert.equal(greekPhoneticKey(v.in), v.out, `${JSON.stringify(v.in)} — ${v.why}`);
  }
});

test('Greek and Greeklish spellings collide', () => {
  assert.equal(greekPhoneticKey('βιβλιοθήκη'), greekPhoneticKey('vivliothiki'));
  assert.equal(greekPhoneticKey('βιβλιοθήκη'), greekPhoneticKey('bibliothiki'));
  assert.equal(greekPhoneticKey('Μπάμπης'), greekPhoneticKey('babis'));
  assert.equal(greekPhoneticKey('Μπάμπης'), greekPhoneticKey('bampis'));
  // ...and genuinely different words still do not.
  assert.notEqual(greekPhoneticKey('βιβλίο'), greekPhoneticKey('βιβλιοθήκη'));
});

test('every named ISO 843 Type 1 vector', () => {
  for (const v of fixture.namedIso843Type1) {
    assert.equal(toIso843Type1(v.in), v.out, `${JSON.stringify(v.in)} — ${v.why}`);
  }
});

test('ISO 843 Type 1 round-trips, final sigma excepted', () => {
  // ς and σ both transliterate to `s`, so the way back can only produce σ.
  // That is the same information foldGreek deliberately discards, and the
  // contract is stated in toIso843Type1's docblock.
  const words = [
    'καζαντζακης',
    'πολις',
    'αθηνα',
    'θεος',
    'ψυχη',
    'ξενος',
    'ουρανος',
    'ελευθερια',
    'θαλασσα',
    'ανθρωπος',
    'βιβλιοθηκη',
    'φιλοσοφια',
  ];
  for (const w of words) {
    const expected = w.replace(/ς/g, 'σ');
    assert.equal(fromIso843Type1(toIso843Type1(w)), expected, `${w} -> ${toIso843Type1(w)}`);
  }
});

test('ISO 843 Type 1 round-trips accented text', () => {
  for (const w of ['πόλις', 'Αθήνα', 'Καζαντζάκης', 'ελευθερία']) {
    const back = fromIso843Type1(toIso843Type1(w));
    assert.equal(foldGreek(back), foldGreek(w), `${w} -> ${toIso843Type1(w)} -> ${back}`);
  }
});

test('every named ISO 843 Type 2 (ELOT 743) vector', () => {
  for (const v of fixture.namedIso843Type2) {
    assert.equal(toIso843Type2(v.in), v.out, `${JSON.stringify(v.in)} — ${v.why}`);
  }
});

test('ELOT 743 voicing depends on what follows', () => {
  assert.equal(toIso843Type2('Ευαγγελία'), 'Evangelia', 'ευ before a vowel voices');
  assert.equal(toIso843Type2('Ευθύμιος'), 'Efthymios', 'ευ before θ devoices');
  assert.equal(toIso843Type2('αυγό'), 'avgo', 'αυ before γ voices');
  assert.equal(toIso843Type2('αυτός'), 'aftos', 'αυ before τ devoices');
});

test('every named ALA-LC vector', () => {
  for (const v of fixture.namedAlaLc) {
    assert.equal(toAlaLc(v.in), v.out, `${JSON.stringify(v.in)} — ${v.why}`);
  }
});

test('the three romanizations are genuinely three', () => {
  // If any two of these ever coincide, one of them is not implementing its
  // published table and an authority match will silently fail.
  const name = 'Καζαντζάκης';
  assert.notEqual(toIso843Type1(name), toIso843Type2(name));
  assert.notEqual(toIso843Type2(name), toAlaLc(name));
  assert.equal(toIso843Type2('Φίλιππος'), 'Filippos', 'ELOT 743: phi is f');
  assert.equal(toAlaLc('Φίλιππος'), 'Philippos', 'ALA-LC: phi is ph');
});

// --------------------------------------------------------------------------
// Non-filing articles and stopwords
// --------------------------------------------------------------------------

test('every named non-filing vector', () => {
  for (const v of fixture.namedNonfiling) {
    const r = stripNonfilingArticle(v.title, v.lang);
    assert.equal(r.skip, v.skip, `${JSON.stringify(v.title)} — ${v.why}`);
    assert.equal(r.rest, v.title.slice(v.skip));
  }
});

test('the offset lands on the original string, not the folded one', () => {
  // Folding collapses whitespace, so a title imported with a double space —
  // which real MARC exports contain — would otherwise leave `rest` starting
  // with a space, and a sort key beginning with a space files that title ahead
  // of the entire catalogue.
  for (const [title, lang] of [
    ['The  Hobbit', 'eng'],
    ['Το  σπίτι', 'gre'],
    ['   The Hobbit', 'eng'],
  ] as [string, string][]) {
    const r = stripNonfilingArticle(title, lang);
    assert.equal(r.rest, title.slice(r.skip));
    assert.ok(!/^\s/.test(r.rest), `${JSON.stringify(title)} -> ${JSON.stringify(r.rest)}`);
  }
  assert.equal(stripNonfilingArticle('The  Hobbit', 'eng').rest, 'Hobbit');
  assert.equal(stripNonfilingArticle("L'étranger", 'fre').rest, 'étranger');
});

test('a title that merely starts with the article letters is untouched', () => {
  assert.equal(stripNonfilingArticle('Ηλεκτρονικοί υπολογιστές', 'gre').skip, 0);
  assert.equal(stripNonfilingArticle('Theatre', 'eng').skip, 0);
  assert.equal(stripNonfilingArticle('Ανθρωπος', 'gre').skip, 0);
});

test('MARC and BCP 47 language codes both resolve', () => {
  // Greek is `gre` in MARC and `el` in BCP 47. `ell` is the ISO 639-2/T
  // terminology variant and is wrong in a MARC 008/35-37, but a record
  // carrying it should still file correctly.
  for (const code of ['el', 'gre', 'ell', 'EL', 'el-GR']) {
    assert.equal(stripNonfilingArticle('Το σπίτι', code).skip, 3, code);
  }
});

test('stopwords are folded, so a query can be matched against them', () => {
  for (const w of GREEK_STOPWORDS) {
    assert.equal(foldGreek(w), w, `stopword ${JSON.stringify(w)} is not in folded form`);
  }
});

// --------------------------------------------------------------------------
// The ASCII fold, which the call-number keys depend on
// --------------------------------------------------------------------------

test('asciiFoldGreek emits printable ASCII for Greek input', () => {
  for (const w of ['Καζαντζάκης', 'ΠΑΙΔΙΚΟ', 'βιβλιοθήκη', 'Ώρα', 'ΎΔΩΡ', 'ᾍδης']) {
    const out = asciiFoldGreek(w);
    assert.match(out, /^[\x20-\x7E]*$/, `${w} -> ${out}`);
  }
});
