import { ESCAPE } from './bytes.js';
import {
  DEFAULT_G0,
  DEFAULT_G1,
  MARC8_SET,
  MARC8_SET_NAME,
  readEscape,
  writeEscape,
  type Register,
} from './marc8-sets.js';
import {
  BASIC_LATIN,
  DOUBLE_DIACRITIC_PAIRS,
  EXTENDED_LATIN,
  TABLE_BY_SET,
  type Marc8Table,
} from './marc8-tables.js';
import { ANOMALY, MarcError, type AnomalyCode } from './types.js';

/**
 * MARC-8, decoded and encoded.
 *
 * ## Three rules that are easy to state and easy to get wrong
 *
 * **1. The designations reset at every field boundary.** MARC-8 escape state
 * does not survive a field terminator. A record whose 245 is in Greek and whose
 * 260 is in Latin decodes correctly only if the 260 starts from the defaults;
 * a decoder that carried state across fields renders the entire tail of such a
 * record in the wrong script, and it looks like a font problem rather than a
 * parser bug. So the state is explicit ({@link Marc8State}), the caller makes
 * one PER FIELD, and it is thrown away at the field terminator. It is threaded
 * across the subfields WITHIN a field, because that is the same rule read the
 * other way: an `ESC ( S` in `$a` is still in force in `$b`.
 *
 * **2. A combining mark PRECEDES its base character.** Unicode does the
 * opposite. So `E2 61` — acute accent, then the letter `a` — decodes to `a`
 * followed by U+0301, and an encoder has to put the mark back in front. Getting
 * this backwards produces a string that renders as a floating accent followed by
 * a bare letter, sorts wrongly, and folds wrongly.
 *
 * **3. Two diacritics span two base characters.** U+FE20/U+FE21 (ligature
 * halves) and U+FE22/U+FE23 (double tilde halves) are one mark drawn across a
 * pair of letters. The ordinary rule handles them when the encoder interleaved
 * them (`EB a EC b`), but not when it emitted both halves first (`EB EC a b`) —
 * which real files do. They therefore get their own pass, BEFORE the general
 * mark handling: the left half lands on this base and the right half is carried
 * to the next one.
 *
 * ## What is supported
 *
 * Basic Latin and Extended Latin (ANSEL) — the default G0 and G1, which is every
 * Latin-script record with a diacritic in it, reached with no escape sequence at
 * all. Every other graphic set is recognised, named, and refused with an
 * anomaly. See the header of `marc8-tables.ts` for why a hand-typed Greek or
 * Arabic table would be worse than none.
 */

export type Marc8DecodeResult = {
  readonly text: string;
  readonly anomalies: readonly AnomalyCode[];
};

/**
 * The designations in force. Mutable, and deliberately so.
 *
 * A designation's scope is the FIELD, not the subfield — an `ESC ( S` in `$a`
 * is still in force in `$b` — but the ISO 2709 layer must hand this module one
 * subfield VALUE at a time, because the subfield code byte sits inside G0's
 * invocation range (`a` is 0x61) and would otherwise be translated as data. In
 * a field where G0 is Basic Greek, a decoder that ran over the raw field buffer
 * would turn every subfield code into a Greek letter.
 *
 * So structure is excised by the caller and STATE is threaded by the caller:
 * one `Marc8State` per field, reused across that field's subfields, discarded at
 * the field terminator. Both halves of that sentence are load-bearing, and
 * getting either wrong is silent.
 */
export type Marc8State = {
  g0: string;
  g1: string;
};

/** The state every field starts from. Never carried across a field terminator. */
export function newMarc8State(): Marc8State {
  return { g0: DEFAULT_G0, g1: DEFAULT_G1 };
}

/** The character a byte becomes when it cannot be decoded — visibly wrong. */
const REPLACEMENT = '�';

/**
 * Decode one run of MARC-8 data — a subfield value, or a whole control field.
 *
 * Never throws. A byte that cannot be decoded becomes U+FFFD and raises an
 * anomaly: a catalogue is imported once, and a record refused for one bad byte
 * is a book nobody can find. `marc_record_contents.source_blob` keeps the
 * original bytes, so the damage is always recoverable.
 *
 * Pass a shared {@link Marc8State} to decode the several subfields of ONE field;
 * omit it and the run is decoded from the defaults, which is what a control
 * field wants.
 */
export function decodeMarc8(
  bytes: Uint8Array,
  state: Marc8State = newMarc8State(),
): Marc8DecodeResult {
  const anomalies = new Set<AnomalyCode>();
  const out: string[] = [];

  let pending: string[] = [];
  let carried: string[] = [];

  /** Attach the accumulated marks to a base character and emit. */
  const flush = (base: string): void => {
    const marks = [...carried, ...pending];
    carried = [];
    pending = [];
    const own: string[] = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k] as string;
      own.push(m);
      const pair = DOUBLE_DIACRITIC_PAIRS.find((p) => p[0] === m);
      if (pair && marks[k + 1] === pair[1]) {
        // The right half belongs to the NEXT base character, not this one.
        carried.push(pair[1]);
        k += 1;
      }
    }
    out.push(base + own.join(''));
  };

  const setFor = (register: Register): string => (register === 'G0' ? state.g0 : state.g1);
  const tableFor = (register: Register): Marc8Table | null =>
    TABLE_BY_SET.get(setFor(register)) ?? null;

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;

    if (b === ESCAPE) {
      const esc = readEscape(bytes, i);
      if (!esc) {
        // A lone ESC in the data. One character lost, record kept.
        anomalies.add(ANOMALY.marc8UnmappedByte);
        i += 1;
        continue;
      }
      if (esc.register === 'G0') state.g0 = esc.set;
      else state.g1 = esc.set;
      if (!TABLE_BY_SET.has(esc.set)) anomalies.add(ANOMALY.marc8UnsupportedCharset);
      i += esc.length;
      continue;
    }

    if (b < 0x20) {
      // Not a graphic character. The ISO 2709 layer has already removed the
      // delimiters, so anything left is data somebody put there; keep it rather
      // than silently dropping a byte.
      flush(String.fromCharCode(b));
      i += 1;
      continue;
    }

    const register: Register = b >= 0xa0 ? 'G1' : 'G0';
    const table = tableFor(register);
    if (!table) {
      // A set this build has no table for. U+FFFD rather than a guess: the
      // damage is then VISIBLE in the record and recoverable from source_blob,
      // where a wrong mapping would be neither.
      anomalies.add(ANOMALY.marc8UnsupportedCharset);
      flush(REPLACEMENT);
      // EACC is three bytes per character; everything else is one. Skipping the
      // wrong width would turn one unsupported character into a run of them.
      i += setFor(register) === MARC8_SET.eastAsian ? 3 : 1;
      continue;
    }

    const mapped = table.map.get(b);
    if (mapped === undefined) {
      anomalies.add(ANOMALY.marc8UnmappedByte);
      flush(REPLACEMENT);
      i += 1;
      continue;
    }
    if (table.combining.has(b)) pending.push(mapped);
    else flush(mapped);
    i += 1;
  }

  // Marks with no base character to attach to. Real files end fields this way
  // when a value was truncated; emit them so nothing is lost.
  if (pending.length || carried.length) {
    out.push([...carried, ...pending].join(''));
    anomalies.add(ANOMALY.marc8UnmappedByte);
  }

  return { text: out.join(''), anomalies: [...anomalies] };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

type ReverseEntry = { readonly byte: number; readonly register: Register; readonly set: string };

/**
 * Unicode string to MARC-8 byte.
 *
 * Keyed by STRING because MARC-8 characters are not one-to-one with Unicode
 * code points — the table type says so and EACC makes it true — so the encoder
 * matches longest-first rather than character by character.
 */
const REVERSE = new Map<string, ReverseEntry>();
let maxKeyLength = 1;

function indexTable(table: Marc8Table, register: Register): void {
  for (const [byte, text] of table.map) {
    // First writer wins: Basic Latin is indexed first, so ASCII always encodes
    // as itself rather than as an ANSEL lookalike.
    if (!REVERSE.has(text)) REVERSE.set(text, { byte, register, set: table.set });
    if (text.length > maxKeyLength) maxKeyLength = text.length;
  }
}
indexTable(BASIC_LATIN, 'G0');
indexTable(EXTENDED_LATIN, 'G1');

const COMBINING = /^(?:\p{Mn}|\p{Me})$/u;

type Emitted = { readonly byte: number; readonly combining: boolean };

/**
 * Encode ONE character, decomposing only if it has no mapping of its own.
 *
 * The order matters and a bijectivity check is what found it. ANSEL carries
 * `Ơ` (U+01A0) as a single byte, 0xAC — but `Ơ` decomposes under NFD to `O`
 * plus U+031B COMBINING HORN, and ANSEL has no horn. An encoder that
 * decomposed everything up front therefore refused a character its own table
 * contains. So: try the character as written, and decompose only when that
 * fails, which is exactly the case `á` needs (ANSEL has `a` and an acute, and
 * no `á`).
 */
function encodeChar(ch: string, out: Emitted[]): void {
  const direct = REVERSE.get(ch);
  if (direct) {
    out.push({ byte: direct.byte, combining: COMBINING.test(ch) });
    return;
  }
  const decomposed = ch.normalize('NFD');
  if (decomposed !== ch) {
    for (const part of decomposed) encodeChar(part, out);
    return;
  }
  const code = ch.codePointAt(0) as number;
  throw new MarcError(
    'marc8-unencodable',
    `MARC-8 cannot represent U+${code.toString(16).toUpperCase().padStart(4, '0')} ` +
      `(${JSON.stringify(ch)}). Export this record as UTF-8 or MARCXML.`,
  );
}

/**
 * Encode text as MARC-8.
 *
 * Throws on a character MARC-8 cannot express. That is deliberate and it is the
 * opposite of the decoder's forgiveness: a record that cannot be represented has
 * exactly one right answer, which is to export it as UTF-8 or MARCXML, and an
 * encoder that substituted a question mark would put a corrupted record into
 * another library's catalogue with nobody the wiser.
 *
 * ### Normalization: composed where it helps, never reordered
 *
 * A cluster is looked up in its COMPOSED form first, because ANSEL carries a few
 * precomposed characters (`Ơ`, `Ư`, `Æ`) and no combining horn to build them
 * from. When that fails the cluster is encoded piece by piece **exactly as
 * written**: NFC canonically reorders marks of different combining class, so
 * normalizing here would emit different bytes from the ones that were read, for
 * a record nobody edited — and `write(read(b)) === b` is a promise this codec
 * makes.
 *
 * ### Why it emits no escape sequences
 *
 * Both supported sets live in their DEFAULT registers — Basic Latin in G0,
 * ANSEL in G1 — and their byte ranges do not overlap (0x20-0x7E against
 * 0xA1-0xFE). So a field using only these two needs no designation at all, which
 * is also why the overwhelming majority of real MARC-8 records contain no ESC
 * byte anywhere. {@link writeEscape} exists for when the remaining tables land.
 */
export function encodeMarc8(text: string): Uint8Array {
  const chars = [...text];
  const bytes: number[] = [];

  let i = 0;
  while (i < chars.length) {
    // A cluster is one character and the combining marks that follow it in
    // Unicode order. MARC-8 wants the marks in FRONT, so the cluster is gathered
    // whole and emitted reversed.
    const start = i;
    i += 1;
    while (i < chars.length && COMBINING.test(chars[i] as string)) i += 1;
    const cluster = chars.slice(start, i);
    const text = cluster.join('');

    // 1. The cluster COMPOSED, as one lookup. ANSEL carries `Ơ` (U+01A0) as a
    //    single byte and has no combining horn, so a record holding it as
    //    `O` + U+031B is encodable only if the pieces are composed first.
    const composed = text.normalize('NFC');
    const whole = REVERSE.get(composed);
    if (whole) {
      bytes.push(whole.byte);
      continue;
    }

    // 2. Otherwise piece by piece, over the cluster AS WRITTEN.
    //
    //    As written, not normalized, and that is the load-bearing part. NFC
    //    canonically REORDERS marks of different combining class — `l` with a
    //    dot below (ccc 220) and a cedilla (ccc 202) comes back with the cedilla
    //    first — so an encoder that normalized here would emit different bytes
    //    from the ones it read, for a record nobody edited. Composing was tried
    //    above, where it can only help; reordering is never wanted.
    const marks: number[] = [];
    const base: number[] = [];
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k] as string;
      const out: Emitted[] = [];
      encodeChar(ch, out);
      for (const e of out) (e.combining || k > 0 ? marks : base).push(e.byte);
    }
    bytes.push(...marks, ...base);
  }

  return new Uint8Array(bytes);
}

/** Whether every character in `text` can be written as MARC-8. */
export function canEncodeMarc8(text: string): boolean {
  try {
    encodeMarc8(text);
    return true;
  } catch {
    return false;
  }
}

export { writeEscape, MARC8_SET, MARC8_SET_NAME };
