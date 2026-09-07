import { concatBytes, encodeUtf8 } from '../bytes.js';

/**
 * A generated ISO 2709 corpus, written by an INDEPENDENT byte emitter.
 *
 * ## Why this exists in this form
 *
 * The phase's acceptance criterion is a property test over at least 5,000
 * records from "LC plus real ABEKT, Koha, Aleph and Evergreen exports", with
 * `parse(write(parse(b))) === parse(b)` for all of them and
 * `write(parse(b)) === b` byte-for-byte for at least 98 %.
 *
 * **This repository has no real MARC records and the session that wrote this had
 * no way to obtain any.** So the corpus is generated — and the way it is
 * generated is the only thing that makes the property test mean anything.
 *
 * The emitter below shares NO code with `iso2709.ts`. It lays out the leader,
 * the directory and the field data by hand, from the standard, and it is
 * parameterised by per-exporter quirk profiles. If `writeIso2709` and this
 * emitter agree on the bytes, that is two independent implementations of ISO
 * 2709 agreeing — which is a real signal. Generating the corpus WITH the
 * production serializer would have proved only that a function equals itself.
 *
 * ## What the 98 % figure is replaced by
 *
 * A percentage over a corpus this file authored is meaningless: it could be
 * tuned to any number. What replaces it, and is strictly stronger:
 *
 *   - `parse(write(parse(b))) === parse(b)` for **every** record. This is the
 *     invariant that actually protects a catalogue, and it holds for the
 *     malformed records too.
 *   - `write(parse(b)) === b` for **every record from a conforming profile**,
 *     with no tolerance at all.
 *   - Every non-conforming record carries the REASON it cannot be reproduced
 *     byte-for-byte, and the test asserts that the reason is the one that
 *     actually occurred rather than counting failures.
 *
 * A later session with real exports should keep all three and add the corpus.
 * `docs/architecture/libriant-2.0/README.md` records this as a phase-7
 * divergence.
 */

/** Deterministic PRNG. The corpus must be identical on every run and every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Why a record cannot be re-serialized to the same bytes.
 *
 * Each of these is a real deviation a conforming writer must NOT reproduce —
 * emitting a record with no terminator, or a lying length, or a non-standard
 * entry map, would be propagating the defect rather than reading past it.
 */
export type Residue =
  | 'no-record-terminator'
  | 'wrong-declared-length'
  | 'non-standard-entry-map'
  | 'fields-out-of-directory-order'
  | 'data-before-first-subfield';

export type ExporterProfile = 'lc' | 'koha' | 'evergreen' | 'aleph' | 'abekt';

export type CorpusRecord = {
  readonly profile: ExporterProfile;
  readonly bytes: Uint8Array;
  /** Empty when the record is conforming and must re-serialize byte-for-byte. */
  readonly residue: readonly Residue[];
  readonly leader: string;
  readonly fields: readonly SourceField[];
};

export type SourceField =
  { tag: string; value: string } | { tag: string; ind: string; subs: [string, string][] };

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const GREEK_TITLES = [
  'Βίος και πολιτεία του Αλέξη Ζορμπά /',
  'Το τρίτο στεφάνι /',
  'Η κάθοδος των εννιά /',
  'Μυθιστόρημα /',
  'ΠΟΛΙΣ : μια ιστορία /',
];
const GREEK_AUTHORS = [
  'Καζαντζάκης, Νίκος,',
  'Ταχτσής, Κώστας,',
  'Βαλτινός, Θανάσης,',
  'Σεφέρης, Γιώργος,',
];
const LATIN_TITLES = [
  'The name of the rose /',
  'Zorba the Greek /',
  'Cataloguing and classification :',
  'A history of the Byzantine state /',
];
const LATIN_AUTHORS = ['Eco, Umberto,', 'Ostrogorsky, George,', 'Svenonius, Elaine,'];
/** Diacritics that exercise the ANSEL combining range and the NFD/NFC boundary. */
const DIACRITIC_NAMES = [
  'Dvořák, Antonín,',
  'Müller, Jürgen,',
  'Łódź : Wydawnictwo,',
  'Çelik, Ayşe,',
  'Þórðarson, Björn,',
];
const PUBLISHERS = ['Καστανιώτης,', 'Ekdoseis Kedros,', 'Oxford University Press,', 'Brill,'];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

/** One plausible bibliographic record, as fields. */
function makeFields(rng: () => number, profile: ExporterProfile, n: number): SourceField[] {
  const greek = profile === 'abekt' || rng() < 0.35;
  const fields: SourceField[] = [];
  fields.push({ tag: '001', value: `lbr${String(n).padStart(8, '0')}` });
  fields.push({ tag: '003', value: profile === 'abekt' ? 'GR-AtEKT' : 'US-CSt' });
  fields.push({ tag: '005', value: `2026090714${String(n % 60).padStart(2, '0')}00.0` });
  fields.push({
    tag: '008',
    value: `26090${n % 10}s${1900 + (n % 120)}    gr |||||||||||000 0 ${greek ? 'gre' : 'eng'} d`,
  });
  if (rng() < 0.8) {
    fields.push({
      tag: '020',
      ind: '  ',
      subs: [['a', `978${String(1000000000 + n).slice(0, 10)}`]],
    });
  }
  const author = greek
    ? pick(rng, GREEK_AUTHORS)
    : rng() < 0.4
      ? pick(rng, DIACRITIC_NAMES)
      : pick(rng, LATIN_AUTHORS);
  fields.push({
    tag: '100',
    ind: '1 ',
    subs: [
      ['a', author],
      ['d', `${1850 + (n % 100)}-`],
    ],
  });

  const title = greek ? pick(rng, GREEK_TITLES) : pick(rng, LATIN_TITLES);
  const titleSubs: [string, string][] = [['a', title]];
  if (rng() < 0.5) titleSubs.push(['b', greek ? 'μια εισαγωγή /' : 'an introduction /']);
  titleSubs.push(['c', author]);
  // Non-filing indicator: the thing the 1.0 reader threw away.
  fields.push({ tag: '245', ind: `1${greek ? '3' : '4'}`, subs: titleSubs });

  fields.push({
    tag: '260',
    ind: '  ',
    subs: [
      ['a', greek ? 'Αθήνα :' : 'Oxford :'],
      ['b', pick(rng, PUBLISHERS)],
      ['c', `${1950 + (n % 70)}.`],
    ],
  });
  if (rng() < 0.6)
    fields.push({
      tag: '300',
      ind: '  ',
      subs: [
        ['a', `${100 + (n % 400)} p. ;`],
        ['c', '21 cm.'],
      ],
    });

  // Repeated fields and repeated subfields — the two things the 1.0 reader's
  // ' | ' join made unrecoverable.
  const subjects = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < subjects; i++) {
    fields.push({
      tag: '650',
      ind: ' 0',
      subs: [
        ['a', greek ? 'Ελληνική λογοτεχνία' : 'Greek literature'],
        ['x', i % 2 ? 'History and criticism.' : 'Bibliography.'],
        ...(i === 0 ? ([['x', '20th century.']] as [string, string][]) : []),
      ],
    });
  }
  if (rng() < 0.3) {
    fields.push({
      tag: '700',
      ind: '1 ',
      subs: [
        ['a', pick(rng, LATIN_AUTHORS)],
        ['e', 'translator.'],
      ],
    });
    fields.push({
      tag: '700',
      ind: '1 ',
      subs: [
        ['a', pick(rng, LATIN_AUTHORS)],
        ['e', 'editor.'],
      ],
    });
  }
  // A bilingual pair with $6 linkage — sparse occurrence numbers on purpose,
  // which is how real ABEKT and Aleph records arrive.
  if (greek && rng() < 0.4) {
    const occ = String(1 + Math.floor(rng() * 40)).padStart(2, '0');
    fields.push({
      tag: '246',
      ind: '3 ',
      subs: [
        ['6', `880-${occ}`],
        ['a', 'Vios kai politeia'],
      ],
    });
    fields.push({
      tag: '880',
      ind: '3 ',
      subs: [
        ['6', `246-${occ}/(S`],
        ['a', pick(rng, GREEK_TITLES)],
      ],
    });
  }
  if (rng() < 0.4) fields.push({ tag: '500', ind: '  ', subs: [['a', 'Includes index.']] });
  return fields;
}

// ---------------------------------------------------------------------------
// The independent emitter
// ---------------------------------------------------------------------------

const FT = 0x1e;
const RT = 0x1d;
const SF = 0x1f;

type Quirks = {
  /**
   * A non-standard entry map. The directory is emitted to MATCH it — a real
   * exporter that declares `4510` writes 13-byte entries with a one-character
   * implementation-defined part. A record that declared one width and wrote
   * another would be testing nothing but corruption handling.
   */
  entryMap?: string;
  omitRecordTerminator?: boolean;
  lieAboutLength?: boolean;
  outOfOrder?: boolean;
  dataBeforeFirstSubfield?: boolean;
};

/**
 * Lay out an ISO 2709 record by hand.
 *
 * Deliberately NOT written in terms of anything in `iso2709.ts`. The leader
 * layout, the 12-byte directory entries, the base-address arithmetic and the
 * terminator placement are all restated here from the standard, so that an
 * agreement between the two is evidence rather than tautology.
 */
export function emitRecord(
  leaderSeed: string,
  fields: readonly SourceField[],
  quirks: Quirks = {},
): Uint8Array {
  const bodies: Uint8Array[] = [];
  for (const f of fields) {
    const parts: Uint8Array[] = [];
    if ('value' in f) {
      parts.push(encodeUtf8(f.value));
    } else {
      parts.push(encodeUtf8(f.ind));
      if (quirks.dataBeforeFirstSubfield) parts.push(encodeUtf8('stray'));
      for (const [code, value] of f.subs) {
        parts.push(new Uint8Array([SF]), encodeUtf8(code), encodeUtf8(value));
      }
    }
    parts.push(new Uint8Array([FT]));
    bodies.push(concatBytes(parts));
  }

  const order = bodies.map((_, i) => i);
  if (quirks.outOfOrder && order.length > 3) {
    // Swap two field BODIES without swapping their directory entries' order:
    // the directory still lists them in tag order, the data is not.
    const a = order[1] as number;
    order[1] = order[2] as number;
    order[2] = a;
  }

  // Directory entries in field order; start positions follow the emitted order.
  const startOf = new Map<number, number>();
  let cursor = 0;
  for (const index of order) {
    startOf.set(index, cursor);
    cursor += (bodies[index] as Uint8Array).length;
  }

  const entryMap = quirks.entryMap ?? '4500';
  const lengthWidth = Number(entryMap[0]);
  const startWidth = Number(entryMap[1]);
  const extraWidth = Number(entryMap[2]);
  const directory = fields
    .map((f, i) => {
      const body = bodies[i] as Uint8Array;
      const start = startOf.get(i) as number;
      return (
        f.tag +
        String(body.length).padStart(lengthWidth, '0') +
        String(start).padStart(startWidth, '0') +
        '0'.repeat(extraWidth)
      );
    })
    .join('');

  const baseAddress = 24 + directory.length + 1;
  const total = baseAddress + cursor + 1;
  const declared = quirks.lieAboutLength ? total + 3 : total;

  const leader =
    String(declared).padStart(5, '0') +
    leaderSeed.slice(5, 12) +
    String(baseAddress).padStart(5, '0') +
    leaderSeed.slice(17, 20) +
    entryMap;

  const chunks: Uint8Array[] = [
    encodeUtf8(leader),
    encodeUtf8(directory),
    new Uint8Array([FT]),
    ...order.map((i) => bodies[i] as Uint8Array),
  ];
  if (!quirks.omitRecordTerminator) chunks.push(new Uint8Array([RT]));
  return concatBytes(chunks);
}

/**
 * The five exporter profiles.
 *
 * Each quirk is one this codec must READ and must NOT reproduce. They are drawn
 * from the failure modes the 2.0 plan and the audit already name; a session with
 * real exports should replace the whole file and keep the property assertions.
 */
function quirksFor(
  profile: ExporterProfile,
  rng: () => number,
): { quirks: Quirks; residue: Residue[] } {
  const quirks: Quirks = {};
  const residue: Residue[] = [];
  switch (profile) {
    case 'lc':
    case 'evergreen':
      // Conforming. These must re-serialize byte-for-byte, with no tolerance.
      break;
    case 'koha':
      if (rng() < 0.12) {
        // The directory is correct and in tag order; the field DATA is not laid
        // out in the same order. Legal, and the writer normalises it.
        quirks.outOfOrder = true;
        residue.push('fields-out-of-directory-order');
      }
      break;
    case 'aleph':
      if (rng() < 0.25) {
        quirks.omitRecordTerminator = true;
        residue.push('no-record-terminator');
      } else if (rng() < 0.1) {
        // Text between the indicators and the first delimiter. The stored shape
        // has no slot for it, so the reader drops it and says so; the original
        // survives in source_blob.
        quirks.dataBeforeFirstSubfield = true;
        residue.push('data-before-first-subfield');
      }
      break;
    case 'abekt':
      if (rng() < 0.15) {
        quirks.lieAboutLength = true;
        residue.push('wrong-declared-length');
      } else if (rng() < 0.12) {
        quirks.entryMap = '4510';
        residue.push('non-standard-entry-map');
      }
      break;
  }
  return { quirks, residue };
}

const PROFILES: ExporterProfile[] = ['lc', 'koha', 'evergreen', 'aleph', 'abekt'];

/** Generate `count` records. Deterministic in `seed`. */
export function generateCorpus(count: number, seed = 20260907): CorpusRecord[] {
  const rng = mulberry32(seed);
  const out: CorpusRecord[] = [];
  for (let n = 0; n < count; n++) {
    const profile = PROFILES[n % PROFILES.length] as ExporterProfile;
    const fields = makeFields(rng, profile, n);
    const { quirks, residue } = quirksFor(profile, rng);
    // Spelled out rather than imported, so this file shares nothing with the
    // codec. Positions: 05 'n' new, 06 'a' language material, 07 'm' monograph,
    // 09 'a' Unicode, 10-11 '22' the fixed counts, 17 ' ' full level, 20-23
    // '4500' the standard entry map.
    const leaderSeed = '00000nam a2200000 a 4500';
    const bytes = emitRecord(leaderSeed, fields, quirks);
    out.push({ profile, bytes, residue, leader: leaderSeed, fields });
  }
  return out;
}

/** The whole corpus as one concatenated stream, the way a file arrives. */
export function corpusStream(records: readonly CorpusRecord[]): Uint8Array {
  return concatBytes(records.map((r) => r.bytes));
}
