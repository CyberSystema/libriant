import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSemanticCorpus,
  SEMANTIC_RESIDUES,
  type SemanticResidue,
} from './__fixtures__/semantic-corpus.js';
import { generateCorpus } from './__fixtures__/corpus.js';
import { readIso2709Record } from './iso2709.js';
import {
  PROJECTION_ANOMALY,
  UNTITLED,
  projectBib,
  type ProjectionAnomalyCode,
} from './bib-projection.js';
import type { MarcField, MarcRecord } from './types.js';

const df = (t: string, i: string, s: Record<string, string>[]): MarcField => ({ t, i, s });
const cf = (t: string, v: string): MarcField => ({ t, v });
const rec = (fields: MarcField[]): MarcRecord => ({ leader: '00000nam a2200000 a 4500', fields });
const OK_008 = '260908s2020    gr |||||||||||000 0 gre d';

const codes = (r: ReturnType<typeof projectBib>) => r.anomalies.map((a) => a.code);

// ---------------------------------------------------------------------------
// The property the phase line names: pure, total, never throws.
// ---------------------------------------------------------------------------

/** A surrogate code unit with no partner — see `sanitize` in the projector. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The anomaly each residue MUST produce.
 *
 * The fixture's docblock says the residue is declared so a test can assert "that
 * the RIGHT anomaly came back, which is the half that has teeth", and for a
 * while nothing did — the loop below only checked types, so it would have passed
 * against a projector that returned an empty projection for everything.
 *
 * Absent from this map means "no anomaly is required", not "no anomaly is
 * allowed": several residues are hostile in ways the projector is entitled to
 * absorb silently (a lone surrogate is repaired, an unpaired 264 is legal MARC).
 */
const RESIDUE_REQUIRES: Partial<Record<SemanticResidue, ProjectionAnomalyCode>> = {
  'no-245': PROJECTION_ANOMALY.titleMissing,
  'two-245': PROJECTION_ANOMALY.fieldRepeated,
  'no-245a': PROJECTION_ANOMALY.titleNoSubfieldA,
  'empty-245a': PROJECTION_ANOMALY.titleMissing,
  'huge-245a': PROJECTION_ANOMALY.valueTruncated,
  'ind2-letter': PROJECTION_ANOMALY.nonfilingInvalid,
  'ind2-too-long': PROJECTION_ANOMALY.nonfilingTooLong,
  'ind2-disagrees': PROJECTION_ANOMALY.nonfilingDisagrees,
  'no-008': PROJECTION_ANOMALY.fixedFieldUnusable,
  'short-008': PROJECTION_ANOMALY.fixedFieldUnusable,
  'lang-2-chars': PROJECTION_ANOMALY.codeWrongWidth,
  'date-not-a-year': PROJECTION_ANOMALY.dateUnparsable,
  'two-main-entries': PROJECTION_ANOMALY.multipleMainEntries,
  'bad-isbn': PROJECTION_ANOMALY.identifierInvalid,
  'rda-conflict': PROJECTION_ANOMALY.rdaAacr2Conflict,
  'combining-only': PROJECTION_ANOMALY.sortKeyUnderivable,
  'control-only': PROJECTION_ANOMALY.titleMissing,
};

test('never throws, over every hostile residue', () => {
  const corpus = generateSemanticCorpus(400);

  // COVERAGE IS COUNTED FROM WHAT THE PROJECTOR SAW, not from the labels.
  //
  // The first version of this line was `new Set(corpus.map((c) => c.residue))`,
  // which is a tautology: `generateSemanticCorpus` stamps the label by index, so
  // the assertion would have passed with `build()` returning the same clean
  // record for all twenty. Counting the projections instead means a fixture that
  // has stopped being hostile shows up here.
  const distinct = new Set(corpus.map(({ record }) => JSON.stringify(projectBib(record))));

  for (const { record, residue } of corpus) {
    const result = projectBib(record);
    const p = result.projection;
    // The two NOT NULL columns must always have a value, or the INSERT that
    // consumes this aborts — which would move the failure rather than remove it.
    assert.ok(p.title.length > 0, `${residue}: empty title`);
    // sort_title is NOT NULL too, and an EMPTY one is worse than a null: it
    // files the record ahead of the entire catalogue. `combining-only` reached
    // that state, because foldGreek strips combining marks and the whole title
    // is one.
    assert.ok(p.sortTitle.length > 0, `${residue}: empty sortTitle`);
    assert.ok(p.matchKey.length > 0, `${residue}: empty matchKey`);
    assert.equal(typeof p.searchText, 'string', residue);
    // Postgres text is UTF-8 and rewrites an unpaired surrogate to U+FFFD in
    // transit — measured — so a projection carrying one can never agree with a
    // fresh computation and `catalog-verify` reports it for ever.
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'string') {
        assert.equal(LONE_SURROGATE.test(v), false, `${residue}: lone surrogate in ${k}`);
      }
    }
    const required = RESIDUE_REQUIRES[residue];
    if (required) {
      assert.ok(
        result.anomalies.some((a) => a.code === required),
        `${residue}: expected ${required}, got ${codes(result).join(', ') || 'nothing'}`,
      );
    }
  }

  // Twenty residues, and a `clean` one that repeats with a different random
  // title each cycle — so the distinct-projection count is a floor, not an
  // equality. Below the number of residues means fixtures have collapsed.
  assert.ok(
    distinct.size >= SEMANTIC_RESIDUES.length,
    `only ${distinct.size} distinct projections from ${SEMANTIC_RESIDUES.length} residues`,
  );
});

test('the projector raises no STRUCTURAL complaint about ordinary MARC', () => {
  // Narrower than "no complaints at all", and deliberately so — the first
  // version of this test asserted zero and was wrong about the corpus, not
  // about the projector. Measured over 200 corpus records, two of the three
  // things it flags are real faults in the FIXTURE:
  //
  //   • ind2 — corpus.ts hardcodes `1${greek ? '3' : '4'}` per SCRIPT, without
  //     looking at the title, so "Ο Μεγάλος Περίπατος" (a two-character
  //     article) is emitted with ind2=3. The projector is right to notice, and
  //     that queue is exactly what a real imported catalogue needs.
  //   • ISBNs — the corpus emits shaped-but-arithmetically-invalid numbers like
  //     9781000000000. A check-digit validator SHOULD flag those.
  //
  // What must stay at zero is the structural vocabulary: a record the codec
  // parsed successfully has a title, an 008 and one 245, and a projector that
  // complained about those would be complaining about ordinary MARC.
  const STRUCTURAL = [
    PROJECTION_ANOMALY.titleMissing,
    PROJECTION_ANOMALY.fieldRepeated,
    PROJECTION_ANOMALY.fixedFieldUnusable,
    PROJECTION_ANOMALY.codeWrongWidth,
    PROJECTION_ANOMALY.dateUnparsable,
    PROJECTION_ANOMALY.nonfilingInvalid,
    PROJECTION_ANOMALY.nonfilingTooLong,
    PROJECTION_ANOMALY.valueTruncated,
  ] as const;
  const offenders = new Map<string, string>();
  for (const entry of generateCorpus(500)) {
    const record = readIso2709Record(entry.bytes).record;
    for (const a of projectBib(record).anomalies) {
      if ((STRUCTURAL as readonly string[]).includes(a.code)) offenders.set(a.code, a.message);
    }
  }
  assert.deepEqual([...offenders.entries()], [], 'structural complaints about ordinary MARC');
});

// ---------------------------------------------------------------------------
// Every value that reaches a constrained column is clamped HERE.
// ---------------------------------------------------------------------------

test('a code that is not exactly three letters becomes NULL, not a silent truncation', () => {
  // Measured on the real DDL: char(3) <- 'gree' ABORTS with 22001, while
  // 'gree'::char(3) silently stores 'gre'. And 'gr' is accepted by char(3),
  // never equals 'gre', and is therefore wrong forever while looking fine.
  const twoChars = projectBib(rec([cf('008', `${OK_008.slice(0, 35)}gr ${OK_008.slice(38)}`)]));
  assert.equal(twoChars.projection.languageCode, null);
  assert.ok(codes(twoChars).includes(PROJECTION_ANOMALY.codeWrongWidth));

  // A four-character value cannot occupy a three-character slot in an 008 — the
  // slot IS three characters, so the overflow is simply not read. The
  // too-long case only arises from a variable-length subfield, which is where
  // it is tested.
  const spill = projectBib(rec([cf('008', OK_008), df('041', '0 ', [{ a: 'gree' }])]));
  assert.equal(spill.projection.languageCodes.includes('gree'), false);
  assert.ok(codes(spill).includes(PROJECTION_ANOMALY.codeWrongWidth));

  const good = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: 'Ζορμπάς' }])]));
  assert.equal(good.projection.languageCode, 'gre');
  // A TWO-letter country code padded to the slot is correct MARC — `gr` is
  // Greece — and must survive. Postgres ignores trailing spaces when comparing
  // `char(3)`, so storing the trimmed form is the same value to every query.
  assert.equal(good.projection.countryCode, 'gr');
  assert.equal(codes(good).length, 0, JSON.stringify(good.anomalies));
});

test('a date that is not a year becomes NULL and says so', () => {
  const r = projectBib(rec([cf('008', `${OK_008.slice(0, 7)}20x0${OK_008.slice(11)}`)]));
  assert.equal(r.projection.publicationYear, null);
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.dateUnparsable));
  // MARC's own "unknown" spellings are NOT anomalies — they are the record
  // correctly saying it does not know.
  for (const unknown of ['uuuu', '||||', '    ']) {
    const u = projectBib(rec([cf('008', `${OK_008.slice(0, 7)}${unknown}${OK_008.slice(11)}`)]));
    assert.equal(u.projection.publicationYear, null, unknown);
    assert.equal(
      codes(u).includes(PROJECTION_ANOMALY.dateUnparsable),
      false,
      `${unknown} should not be an anomaly`,
    );
  }
});

test('a single-date record gets no end year', () => {
  // 008/06 = 's' is a single date. Copying 008/11-14 unconditionally makes every
  // monograph look like a multi-year set, because a great many records carry
  // 9999 or a repeat of the first date there.
  //
  // THE FIXTURE MUST HAVE A SECOND DATE. `OK_008` carries four spaces at
  // 008/11-14, so `year()` returns null before the date-type guard is ever
  // consulted and this test passed with the guard deleted — measured. `9999` is
  // the specific value real records carry, so it is the one to use.
  const nines = `260908s20209999gr |||||||||||000 0 gre d`;
  const single = projectBib(rec([cf('008', nines)]));
  assert.equal(single.projection.publicationYear, 2020);
  assert.equal(single.projection.publicationYearEnd, null);

  const range = `260908m20202024gr |||||||||||000 0 gre d`;
  const multi = projectBib(rec([cf('008', range)]));
  assert.equal(multi.projection.publicationYear, 2020);
  assert.equal(multi.projection.publicationYearEnd, 2024);
});

// ---------------------------------------------------------------------------
// Title and sort key.
// ---------------------------------------------------------------------------

test('a record with no usable title gets the sentinel and an anomaly', () => {
  for (const fields of [[cf('008', OK_008)], [cf('008', OK_008), df('245', '10', [{ a: '' }])]]) {
    const r = projectBib(rec(fields));
    assert.equal(r.projection.title, UNTITLED);
    assert.ok(codes(r).includes(PROJECTION_ANOMALY.titleMissing));
    // NOT NULL is satisfied and the sort key is not the empty string, which
    // would file the record ahead of the entire catalogue.
    assert.ok(r.projection.sortTitle.length > 0);
  }
});

test('a 245 with only a $b uses the subtitle rather than hiding the record', () => {
  // $a is required when 245 is present, so this record IS malformed — but the
  // subtitle is real title information and a patron can find the record by it.
  // "[Untitled]" would hide a findable record, which is the worse failure.
  const r = projectBib(rec([cf('008', OK_008), df('245', '10', [{ b: 'subtitle only' }])]));
  assert.equal(r.projection.title, 'subtitle only');
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.titleNoSubfieldA));
  assert.equal(codes(r).includes(PROJECTION_ANOMALY.titleMissing), false);
});

test('a second 245 loses, loudly', () => {
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'The first one /' }]),
      df('245', '10', [{ a: 'The second one /' }]),
    ]),
  );
  assert.match(r.projection.title, /first/);
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.fieldRepeated));
});

test('the indicator wins over the detector, and the disagreement is queued', () => {
  // A catalogue imported from a system that never set ind2 has thousands of
  // titles filing under "The". The cataloguer's assertion is honoured — it is an
  // assertion — and the disagreement is what makes the import fixable.
  const r = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: 'The Hobbit' }])]));
  assert.equal(r.projection.titleNonfilingSkip, 0);
  assert.equal(r.projection.sortTitle, 'the hobbit');
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.nonfilingDisagrees));

  const correct = projectBib(rec([cf('008', OK_008), df('245', '14', [{ a: 'The Hobbit' }])]));
  assert.equal(correct.projection.titleNonfilingSkip, 4);
  assert.equal(correct.projection.sortTitle, 'hobbit');
  assert.equal(codes(correct).includes(PROJECTION_ANOMALY.nonfilingDisagrees), false);
});

test('an indicator past the end of the title cannot empty the sort key', () => {
  const r = projectBib(rec([cf('008', OK_008), df('245', '19', [{ a: 'Ω' }])]));
  assert.equal(r.projection.titleNonfilingSkip, 0);
  assert.ok(r.projection.sortTitle.length > 0);
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.nonfilingTooLong));
});

test('the Greek fold is applied to the sort key — the phase-1 defect', () => {
  // 'ΠΟΛΙΣ'.toLowerCase() ends in U+03C2 (final sigma) and a typist types
  // U+03C3. An uppercase-catalogued Greek record is the NORM in Greek library
  // exports, so without the fold those records cannot be found at all.
  const upper = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: 'ΠΟΛΙΣ' }])]));
  const lower = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: 'πολις' }])]));
  assert.equal(upper.projection.sortTitle, lower.projection.sortTitle);
  assert.ok(upper.projection.searchText.includes(lower.projection.sortTitle));
});

// ---------------------------------------------------------------------------
// Identifiers: flagged, never refused.
// ---------------------------------------------------------------------------

test('a bad ISBN is STORED and flagged, never dropped', () => {
  // §5 pairs "check-digit validated" with "None is a uniqueness constraint",
  // and §3 says the 1.0 constraint "would refuse the exact catalogues this
  // product exists to import". Dropping the value would lose the only copy of a
  // number a librarian can compare against the book in her hand.
  const r = projectBib(rec([cf('008', OK_008), df('020', '  ', [{ a: '9780306406158' }])]));
  assert.equal(r.projection.identifiers.length, 1);
  assert.equal(r.projection.identifiers[0]!.valid, false);
  assert.equal(r.projection.identifiers[0]!.valueNorm, '9780306406158');
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.identifierInvalid));
});

test('a cancelled identifier is stored, marked, and not complained about', () => {
  // 020 $z is how a patron searching an old citation finds the record. It is
  // never authoritative and it is not an error.
  const r = projectBib(rec([cf('008', OK_008), df('020', '  ', [{ z: '9780306406158' }])]));
  assert.equal(r.projection.identifiers[0]!.cancelled, true);
  assert.equal(codes(r).includes(PROJECTION_ANOMALY.identifierInvalid), false);
});

test('024 is read by indicator, so an ISMN is not filed as an EAN', () => {
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('024', '2 ', [{ a: '9790260000438' }]),
      df('024', '3 ', [{ a: '4006381333931' }]),
      df('024', '7 ', [{ a: '10.1000/182' }, { '2': 'doi' }]),
    ]),
  );
  const schemes = r.projection.identifiers.map((i) => i.scheme).sort();
  assert.deepEqual(schemes, ['doi', 'ean', 'ismn']);
});

// ---------------------------------------------------------------------------
// Publication.
// ---------------------------------------------------------------------------

test('264 beats 260, and the disagreement is recorded', () => {
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('260', '  ', [{ a: 'Αθήνα :' }, { b: 'Παλιός εκδότης,' }]),
      df('264', ' 1', [{ a: 'Θεσσαλονίκη :' }, { b: 'Νέος εκδότης,' }]),
    ]),
  );
  assert.equal(r.projection.publisher, 'Νέος εκδότης');
  assert.equal(r.projection.publicationPlace, 'Θεσσαλονίκη');
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.rdaAacr2Conflict));
});

test('a 264 that is not publication is ignored', () => {
  // ind2: 0 production, 1 publication, 2 distribution, 3 manufacture,
  // 4 copyright. Only publication is the publisher.
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('260', '  ', [{ b: 'The real publisher,' }]),
      df('264', ' 4', [{ c: '©2020' }]),
    ]),
  );
  assert.equal(r.projection.publisher, 'The real publisher');
});

// ---------------------------------------------------------------------------
// The projector's outputs are the projector's only outputs.
// ---------------------------------------------------------------------------

test('projectBib is pure — it does not mutate the record it is given', () => {
  const record = rec([cf('008', OK_008), df('245', '10', [{ a: 'Ζορμπάς /' }])]);
  const before = JSON.stringify(record);
  projectBib(record);
  assert.equal(JSON.stringify(record), before);
});

test('two runs over the same record give the same projection', () => {
  const record = rec([
    cf('008', OK_008),
    df('245', '14', [{ a: 'The Hobbit /' }, { c: 'Tolkien.' }]),
    df('020', '  ', [{ a: '9780306406157' }]),
  ]);
  assert.deepEqual(projectBib(record), projectBib(record));
});

test('9XX local fields stay out of the searchable text', () => {
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('955', '  ', [{ a: 'internal-vendor-token-do-not-index' }]),
    ]),
  );
  assert.equal(r.projection.searchText.includes('internal'), false);
});

// ---------------------------------------------------------------------------
// Classifications and their shelf-sort keys.
// ---------------------------------------------------------------------------

test('every classification source maps to its scheme, with $b joined to $a', () => {
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('050', '00', [{ a: 'PA5610.K39' }, { b: 'B5 1946' }]),
      df('060', '00', [{ a: 'WB 100' }]),
      df('080', '  ', [{ a: '821.14' }]),
      df('082', '04', [{ a: '889.332' }]),
      df('084', '  ', [{ a: 'ΠΑΙΔ 823 ΚΑΖ' }]),
    ]),
  );
  assert.deepEqual(r.projection.classifications.map((c) => c.scheme).sort(), [
    'ddc',
    'lcc',
    'local',
    'nlm',
    'udc',
  ]);
  // $b is the cutter/item part. A shelf order that dropped it would file every
  // Dewey 823.912 under one key, which is most of a large fiction collection.
  const lcc = r.projection.classifications.find((c) => c.scheme === 'lcc')!;
  assert.equal(lcc.value, 'PA5610.K39 B5 1946');
});

test('the shelf-sort key is pure ASCII and fixed width — the perf-13 trap', () => {
  // Tenant databases are created `el_GR.UTF-8`. A sort key that is not pure
  // ASCII reorders under that collation, so shelf order in Postgres, in the
  // browser and in the offline inventory wand would silently differ. The Greek
  // local number is the one that would fail, and it is the one Greek libraries
  // actually use.
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('082', '04', [{ a: '889.332' }]),
      df('084', '  ', [{ a: 'ΠΑΙΔ 823 ΚΑΖ' }]),
    ]),
  );
  const widths = new Set<number>();
  for (const c of r.projection.classifications) {
    assert.match(c.sortKey, /^[\x20-\x7E]+$/, `${c.scheme} ${c.value} → ${c.sortKey}`);
    widths.add(c.sortKey.length);
  }
  assert.equal(widths.size, 1, 'every key must be the same width or a byte compare is meaningless');
});

test('a call number the builder cannot parse still gets a well-formed key', () => {
  // Totality again: `callNumberKey` catches its own builder rather than
  // throwing, so an import does not stop because one 082 holds a dash.
  //
  // The key it returns is NOT empty — the earlier name of this test said so and
  // was wrong. `callNumberKey` pads whatever the builder produced to the fixed
  // width, so an unparsed number becomes 96 zeros, and the whole point of a
  // fixed-width ASCII key is that every row is comparable byte for byte. An
  // empty key would be a shorter string and would sort somewhere else entirely.
  const parsed = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('082', '04', [{ a: '889.332' }]),
    ]),
  ).projection.classifications[0]!;
  const junk = projectBib(
    rec([cf('008', OK_008), df('245', '10', [{ a: 'Ζορμπάς' }]), df('082', '04', [{ a: '—' }])]),
  ).projection.classifications;

  assert.equal(junk.length, 1, 'the row is kept: the number is what the record says');
  assert.equal(junk[0]!.sortKey.length, parsed.sortKey.length, 'same fixed width');
  assert.match(junk[0]!.sortKey, /^[\x20-\x7E]+$/);
  assert.equal(/[^0]/.test(junk[0]!.sortKey), false, 'nothing parsed, so every position is zero');
  assert.ok(junk[0]!.sortKey < parsed.sortKey, 'an unparsed number files before every real one');
});

test('an 082 with nothing in $a or $b produces no row at all', () => {
  const r = projectBib(
    rec([cf('008', OK_008), df('245', '10', [{ a: 'Ζορμπάς' }]), df('082', '04', [{ a: '  ' }])]),
  );
  assert.deepEqual(r.projection.classifications, []);
});

// ---------------------------------------------------------------------------
// The non-filing indicator counts RAW characters.
// ---------------------------------------------------------------------------

test('a double space in 245 $a does not shift the non-filing offset', () => {
  // MARC 21 counts indicator 2 against the field AS TRANSCRIBED — spaces and
  // diacritics included — and real catalogues are full of double spaces. An
  // earlier draft applied the skip to the tidied display title, so `"Ο  κόσμος"`
  // with a correct ind2 of 3 lost three characters from the nine-character
  // collapsed form: the sort key came out `οσμοσ`, the book filed under sigma,
  // and a spurious `nonfiling-indicator-disagrees` was raised on top of it.
  const r = projectBib(rec([cf('008', OK_008), df('245', '03', [{ a: 'Ο  κόσμος' }])]));
  assert.equal(r.projection.title, 'Ο κόσμος');
  assert.equal(r.projection.titleNonfilingSkip, 3);
  assert.equal(r.projection.sortTitle, 'κοσμοσ');
  assert.deepEqual(codes(r), []);
});

test('leading whitespace in 245 $a is counted by the indicator too', () => {
  const r = projectBib(rec([cf('008', OK_008), df('245', '06', [{ a: '  The Hobbit' }])]));
  assert.equal(r.projection.sortTitle, 'hobbit');
  assert.deepEqual(codes(r), []);
});

test('the sort key still starts at the article when the spacing is ordinary', () => {
  const r = projectBib(rec([cf('008', OK_008), df('245', '04', [{ a: 'The Hobbit' }])]));
  assert.equal(r.projection.sortTitle, 'hobbit');
});

test('an indicator longer than $a is refused, but ind2=0 on an empty $a is not', () => {
  // The guard has to say `n > 0` first: a 245 with a $b and no $a is malformed
  // but common, and an indicator of 0 on it is the ordinary case rather than a
  // title that would sort to nothing.
  const tooLong = projectBib(rec([cf('008', OK_008), df('245', '09', [{ a: 'Ω' }])]));
  assert.ok(codes(tooLong).includes(PROJECTION_ANOMALY.nonfilingTooLong));
  assert.equal(tooLong.projection.titleNonfilingSkip, 0);

  const bOnly = projectBib(rec([cf('008', OK_008), df('245', '00', [{ b: 'μόνο υπότιτλος' }])]));
  assert.equal(codes(bOnly).includes(PROJECTION_ANOMALY.nonfilingTooLong), false);
  assert.equal(bOnly.projection.sortTitle, 'μονο υποτιτλοσ');
});

// ---------------------------------------------------------------------------
// 024, whose indicator 1 does not name the scheme.
// ---------------------------------------------------------------------------

test('024 7# takes its scheme from $2, and refuses to guess without one', () => {
  // MARC 21: indicator 1 = 7 means "source specified in subfield $2". The
  // registry behind it holds `doi`, `uri`, `urn`, `istc`, `iswc`, `sici`, `hdl`
  // and more. An earlier draft read every `024 7#` as a DOI, so an ISWC was
  // stored under `scheme = 'doi'` AND flagged invalid against the DOI shape
  // test — mislabelling the identifier and filling the review queue with it.
  const withDoi = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('024', '7 ', [{ a: '10.1000/182' }, { '2': 'doi' }]),
    ]),
  );
  assert.equal(withDoi.projection.identifiers[0]!.scheme, 'doi');
  assert.equal(withDoi.projection.identifiers[0]!.valid, true);

  for (const two of [[{ '2': 'iswc' }], [{ '2': 'uri' }], []]) {
    const r = projectBib(
      rec([
        cf('008', OK_008),
        df('245', '10', [{ a: 'Ζορμπάς' }]),
        df('024', '7 ', [{ a: 'T-034.524.680-1' }, ...two]),
      ]),
    );
    // NOT STORED, and said so. Storing it under a guessed scheme is what makes a
    // good identifier look like a broken one.
    assert.deepEqual(r.projection.identifiers, []);
    assert.ok(codes(r).includes(PROJECTION_ANOMALY.identifierUnknownScheme));
  }
});

test('a qualifier in 020 $a survives into value and is stripped from value_norm', () => {
  // The two columns exist for exactly this: `value` is what the record says,
  // `value_norm` is what a search matches on. `bib_identifiers_lookup_idx` is on
  // (scheme, value_norm), so a qualifier left in the normalised form makes the
  // record unfindable by its own ISBN.
  const r = projectBib(
    rec([
      cf('008', OK_008),
      df('245', '10', [{ a: 'Ζορμπάς' }]),
      df('020', '  ', [{ a: '978-0-306-40615-7 (pbk.)' }]),
    ]),
  );
  const id = r.projection.identifiers[0]!;
  assert.equal(id.value, '978-0-306-40615-7 (pbk.)');
  assert.equal(id.valueNorm, '9780306406157');
  assert.equal(id.valid, true);
  assert.equal(codes(r).includes(PROJECTION_ANOMALY.identifierInvalid), false);
});

// ---------------------------------------------------------------------------
// Nothing the projector emits can be a lone surrogate.
// ---------------------------------------------------------------------------

test('an astral character at the truncation boundary is not cut in half', () => {
  // MEASURED against a real tenant database: node-postgres sends 'A\uD800B' and
  // reads back 'A�B', because Postgres text is UTF-8 and an unpaired
  // surrogate has no encoding. So a projection carrying one can never agree with
  // a fresh computation, `catalog-verify` reports the record for ever, and
  // `--repair` cannot fix it — it writes the surrogate again.
  //
  // `slice()` MANUFACTURES them: a 2,001-character title whose 2,000th and
  // 2,001st code units are a surrogate pair gets cut between them.
  const title = 'a'.repeat(1999) + '\u{10140}' + 'b'.repeat(20);
  const r = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: title }])]));
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const [k, v] of Object.entries(r.projection)) {
    if (typeof v === 'string') assert.equal(lone.test(v), false, `${k}: ${JSON.stringify(v)}`);
  }
  // One character shorter than the cap, because the orphan was dropped rather
  // than kept.
  assert.equal(r.projection.title.length, 1999);
});

test('a lone surrogate already in the record is repaired, not propagated', () => {
  const r = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: 'Title \uD800 tail' }])]));
  assert.equal(r.projection.title.includes('�'), true);
  assert.equal(/[\uD800-\uDFFF]/.test(r.projection.searchText), false);
});

test('a title that folds to nothing files under the sentinel, and says so', () => {
  // foldGreek strips combining marks, so a 245 $a that IS one folds to ''. An
  // empty sort_title is NOT NULL-legal and catastrophic: it files the record
  // ahead of the entire catalogue.
  const r = projectBib(rec([cf('008', OK_008), df('245', '10', [{ a: '́' }])]));
  assert.equal(r.projection.sortTitle, UNTITLED);
  assert.ok(codes(r).includes(PROJECTION_ANOMALY.sortKeyUnderivable));
  // The DISPLAY title is untouched — the record shows what it says.
  assert.equal(r.projection.title, '́');
});
