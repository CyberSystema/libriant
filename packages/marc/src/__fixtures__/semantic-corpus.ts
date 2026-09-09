import { mulberry32 } from './corpus.js';
import type { MarcField, MarcRecord } from '../types.js';

/**
 * Records that are structurally legal MARC and semantically hostile.
 *
 * ## Why `corpus.ts` cannot do this job
 *
 * The phase-7 corpus exists to test a CODEC, so its five exporter profiles are
 * hostile at the byte layer — a non-standard entry map, a missing record
 * terminator, an unmapped MARC-8 byte. Every record it emits is semantically
 * pristine, and that is not an accident of the seed. Measured over
 * `generateCorpus(2000)`: zero records without a 245, zero with two 245s, zero
 * with a 245 carrying no `$a`, zero with an empty `$a`, zero without an 008,
 * zero with a short 008; indicator 2 on 245 is only ever `'3'` or `'4'`, and
 * both are correct for their titles; every one of the 120 distinct years is a
 * well-formed four digits.
 *
 * A projector fuzzed against that corpus is fuzzed against nothing. The whole
 * class of failure it is supposed to survive — "this record is legal MARC and
 * says something impossible" — is absent by construction.
 *
 * ## The residue is DECLARED, as in corpus.ts
 *
 * Each record carries what was done to it. A fuzz test that only asserts "did
 * not throw" passes on a projector that returns an empty projection for
 * everything; declaring the residue lets the test also assert that the RIGHT
 * anomaly came back, which is the half that has teeth.
 */

/** What was deliberately wrong with a record. */
export type SemanticResidue =
  /** No 245 at all. The projector must produce a sentinel title. */
  | 'no-245'
  /** Two 245s. MARC 21 allows one; the first must win. */
  | 'two-245'
  /** A 245 with $b and no $a. */
  | 'no-245a'
  /** A 245 whose $a is the empty string. */
  | 'empty-245a'
  /** A 245 $a of 30 KB — a whole abstract pasted into the title. */
  | 'huge-245a'
  /** 245 indicator 2 is a letter. */
  | 'ind2-letter'
  /** 245 indicator 2 points past the end of the title. */
  | 'ind2-too-long'
  /** 245 indicator 2 disagrees with the article the title actually starts with. */
  | 'ind2-disagrees'
  /** No 008. Language, country and dates are all unknowable. */
  | 'no-008'
  /** An 008 of 12 characters. */
  | 'short-008'
  /** 008/35-37 holds two characters — accepted by char(3), matching nothing. */
  | 'lang-2-chars'
  /** 008/35-37 holds four characters — an assignment that would abort. */
  | 'lang-4-chars'
  /** 008/07-10 is not a year. */
  | 'date-not-a-year'
  /** Both 100 and 110 present. */
  | 'two-main-entries'
  /** An ISBN whose check digit is wrong. */
  | 'bad-isbn'
  /** 264 and 260 naming different publishers. */
  | 'rda-conflict'
  /** A lone combining mark as the title. */
  | 'combining-only'
  /** An unpaired surrogate in a subfield value. */
  | 'lone-surrogate'
  /** A record with no data fields at all. */
  | 'control-only'
  /** Nothing wrong. Present so the corpus is not uniformly hostile. */
  | 'clean';

export type SemanticRecord = {
  readonly record: MarcRecord;
  readonly residue: SemanticResidue;
};

const LEADER = '00000nam a2200000 a 4500';
const OK_008 = '260908s2020    gr |||||||||||000 0 gre d';

const df = (t: string, i: string, s: Record<string, string>[]): MarcField => ({ t, i, s });
const cf = (t: string, v: string): MarcField => ({ t, v });

const TITLES = [
  'Βίος και πολιτεία του Αλέξη Ζορμπά',
  'The Hobbit',
  'Ο Μεγάλος Περίπατος του Πέτρου',
  'Les Misérables',
  'ΠΟΛΙΣ',
];

/** One record per residue, seeded so the set is reproducible. */
function build(residue: SemanticResidue, rng: () => number): MarcRecord {
  const title = TITLES[Math.floor(rng() * TITLES.length)] ?? TITLES[0]!;
  const base: MarcField[] = [
    cf('001', `rec${Math.floor(rng() * 1e6)}`),
    cf('008', OK_008),
    df('245', '10', [{ a: `${title} /` }, { c: 'Νίκος Καζαντζάκης.' }]),
    df('100', '1 ', [{ a: 'Καζαντζάκης, Νίκος,' }, { d: '1883-1957.' }]),
    df('260', '  ', [{ a: 'Αθήνα :' }, { b: 'Εκδόσεις Καζαντζάκη,' }, { c: '2020.' }]),
    df('020', '  ', [{ a: '9780306406157' }]),
    df('082', '04', [{ a: '889.332' }]),
  ];
  const without = (tag: string) => base.filter((f) => f.t !== tag);
  const replace = (tag: string, ...fields: MarcField[]) => [
    ...base.filter((f) => f.t !== tag),
    ...fields,
  ];

  switch (residue) {
    case 'no-245':
      return { leader: LEADER, fields: without('245') };
    case 'two-245':
      return {
        leader: LEADER,
        fields: [...base, df('245', '10', [{ a: 'A second title that must lose /' }])],
      };
    case 'no-245a':
      return { leader: LEADER, fields: replace('245', df('245', '10', [{ b: 'subtitle only' }])) };
    case 'empty-245a':
      return { leader: LEADER, fields: replace('245', df('245', '10', [{ a: '' }])) };
    case 'huge-245a':
      return {
        leader: LEADER,
        fields: replace('245', df('245', '10', [{ a: 'Πολύ μεγάλος τίτλος. '.repeat(1500) }])),
      };
    case 'ind2-letter':
      return { leader: LEADER, fields: replace('245', df('245', '1X', [{ a: title }])) };
    case 'ind2-too-long':
      return { leader: LEADER, fields: replace('245', df('245', '19', [{ a: 'Ω' }])) };
    case 'ind2-disagrees':
      // "The Hobbit" with ind2 = 0: the detector says 4, the cataloguer says 0.
      return { leader: LEADER, fields: replace('245', df('245', '10', [{ a: 'The Hobbit' }])) };
    case 'no-008':
      return { leader: LEADER, fields: without('008') };
    case 'short-008':
      return { leader: LEADER, fields: replace('008', cf('008', '260908s2020 ')) };
    case 'lang-2-chars':
      return {
        leader: LEADER,
        fields: replace('008', cf('008', `${OK_008.slice(0, 35)}gr ${OK_008.slice(38)}`)),
      };
    case 'lang-4-chars':
      // 40 characters still, but the language slot spills into 008/38.
      return {
        leader: LEADER,
        fields: replace('008', cf('008', `${OK_008.slice(0, 35)}gree${OK_008.slice(39)}`)),
      };
    case 'date-not-a-year':
      return {
        leader: LEADER,
        fields: replace('008', cf('008', `${OK_008.slice(0, 7)}20x0${OK_008.slice(11)}`)),
      };
    case 'two-main-entries':
      return { leader: LEADER, fields: [...base, df('110', '2 ', [{ a: 'A corporate body.' }])] };
    case 'bad-isbn':
      return { leader: LEADER, fields: replace('020', df('020', '  ', [{ a: '9780306406158' }])) };
    case 'rda-conflict':
      return {
        leader: LEADER,
        fields: [...base, df('264', ' 1', [{ a: 'Θεσσαλονίκη :' }, { b: 'Άλλος εκδότης,' }])],
      };
    case 'combining-only':
      return { leader: LEADER, fields: replace('245', df('245', '10', [{ a: '́' }])) };
    case 'lone-surrogate':
      return {
        leader: LEADER,
        fields: replace('245', df('245', '10', [{ a: `Title \uD800 tail` }])),
      };
    case 'control-only':
      return { leader: LEADER, fields: [cf('001', 'ctrl1'), cf('008', OK_008)] };
    case 'clean':
      return { leader: LEADER, fields: base };
  }
}

export const SEMANTIC_RESIDUES: readonly SemanticResidue[] = [
  'no-245',
  'two-245',
  'no-245a',
  'empty-245a',
  'huge-245a',
  'ind2-letter',
  'ind2-too-long',
  'ind2-disagrees',
  'no-008',
  'short-008',
  'lang-2-chars',
  'lang-4-chars',
  'date-not-a-year',
  'two-main-entries',
  'bad-isbn',
  'rda-conflict',
  'combining-only',
  'lone-surrogate',
  'control-only',
  'clean',
];

/**
 * `count` records, cycling every residue. Deterministic in `seed`.
 *
 * Cycling rather than sampling so that a small run still covers every hostile
 * case: a fuzz corpus whose coverage depends on the seed is one that passes on
 * Tuesday and fails in CI.
 */
export function generateSemanticCorpus(count: number, seed = 20260909): SemanticRecord[] {
  const rng = mulberry32(seed);
  const out: SemanticRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const residue = SEMANTIC_RESIDUES[i % SEMANTIC_RESIDUES.length]!;
    out.push({ record: build(residue, rng), residue });
  }
  return out;
}
