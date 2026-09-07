/**
 * The MARC-8 graphic sets and the escape sequences that designate them.
 *
 * MARC-8 is an ISO 2022 profile. Two graphic sets are "designated" at any
 * moment: **G0**, invoked by bytes 0x20-0x7E, and **G1**, invoked by bytes
 * 0xA0-0xFE. A field starts with Basic Latin in G0 and Extended Latin (ANSEL) in
 * G1, and an escape sequence changes one of them.
 *
 * There are two escape techniques, and both are in real files:
 *
 *   - **Technique 1** — a single byte after ESC, and G0 only. Legacy, but LC
 *     still emits `ESC g` for Greek symbols in mathematics.
 *   - **Technique 2** — an intermediate byte that says WHICH set is being
 *     redesignated, then a final byte that says which character set. `(` and `,`
 *     both mean G0; `)` and `-` both mean G1. `$` marks a multibyte set (EACC),
 *     optionally followed by one of the four intermediates.
 *
 * A decoder that handles only one of the two intermediates per side — only `(`
 * and not `,`, say — reads half the world's records and silently mis-renders the
 * other half, because the two spellings are equally standard and different
 * systems chose differently.
 */

/** Final bytes, as characters. These identify a graphic set. */
export const MARC8_SET = {
  basicLatin: 'B',
  extendedLatin: 'E',
  basicHebrew: '2',
  basicArabic: '3',
  extendedArabic: '4',
  basicCyrillic: 'N',
  extendedCyrillic: 'Q',
  basicGreek: 'S',
  greekSymbols: 'g',
  subscripts: 'b',
  superscripts: 'p',
  /** EACC — three bytes per character, ~13,000 CJK characters. */
  eastAsian: '1',
} as const;

export type Marc8SetId = (typeof MARC8_SET)[keyof typeof MARC8_SET];

/** Human names, for the anomaly a record gets when its set is not supported. */
export const MARC8_SET_NAME: Readonly<Record<string, string>> = {
  [MARC8_SET.basicLatin]: 'Basic Latin',
  [MARC8_SET.extendedLatin]: 'Extended Latin (ANSEL)',
  [MARC8_SET.basicHebrew]: 'Basic Hebrew',
  [MARC8_SET.basicArabic]: 'Basic Arabic',
  [MARC8_SET.extendedArabic]: 'Extended Arabic',
  [MARC8_SET.basicCyrillic]: 'Basic Cyrillic',
  [MARC8_SET.extendedCyrillic]: 'Extended Cyrillic',
  [MARC8_SET.basicGreek]: 'Basic Greek',
  [MARC8_SET.greekSymbols]: 'Greek Symbols',
  [MARC8_SET.subscripts]: 'Subscripts',
  [MARC8_SET.superscripts]: 'Superscripts',
  [MARC8_SET.eastAsian]: 'East Asian (EACC)',
};

/** Which register an escape sequence redesignates. */
export type Register = 'G0' | 'G1';

/** The default designations at the start of EVERY field. */
export const DEFAULT_G0: Marc8SetId = MARC8_SET.basicLatin;
export const DEFAULT_G1: Marc8SetId = MARC8_SET.extendedLatin;

const ESC_INTERMEDIATE_G0 = new Set([0x28, 0x2c]); // '(' and ','
const ESC_INTERMEDIATE_G1 = new Set([0x29, 0x2d]); // ')' and '-'
const ESC_MULTIBYTE = 0x24; // '$'

/**
 * Technique 1: one byte after ESC, always into G0.
 *
 * `ESC s` returns G0 to Basic Latin and is how a record gets back out of
 * Greek-symbol or superscript mode.
 */
const TECHNIQUE_1: Readonly<Record<number, Marc8SetId>> = {
  0x73: MARC8_SET.basicLatin, // 's'
  0x67: MARC8_SET.greekSymbols, // 'g'
  0x62: MARC8_SET.subscripts, // 'b'
  0x70: MARC8_SET.superscripts, // 'p'
};

export type EscapeSequence = {
  /** Bytes consumed INCLUDING the ESC itself. */
  readonly length: number;
  readonly register: Register;
  readonly set: string;
  /** True for EACC, whose characters are three bytes wide. */
  readonly multibyte: boolean;
};

/**
 * Read an escape sequence beginning at `at` (which must be the ESC byte).
 *
 * Returns `null` when the bytes are not a sequence this profile defines — a
 * lone ESC in the middle of data, or a technique nobody implements. The caller
 * records an anomaly and keeps going rather than abandoning the record: a stray
 * ESC costs one character, and refusing costs the whole catalogue entry.
 */
export function readEscape(bytes: Uint8Array, at: number): EscapeSequence | null {
  const b1 = bytes[at + 1];
  if (b1 === undefined) return null;

  const single = TECHNIQUE_1[b1];
  if (single !== undefined) {
    return { length: 2, register: 'G0', set: single, multibyte: false };
  }

  if (ESC_INTERMEDIATE_G0.has(b1) || ESC_INTERMEDIATE_G1.has(b1)) {
    let offset = at + 2;
    // Some LC registrations carry an extra `!` (0x21) intermediate before the
    // final byte — `ESC ) ! E` for ANSEL into G1. Read WITHOUT this, the
    // sequence designates a set called "!", consumes three bytes, and leaves the
    // real final byte to be emitted as a literal `E` in the middle of the field
    // text. Accepting it on decode costs two lines; refusing it costs a
    // character and a wrong designation on every record that uses the long form.
    if (bytes[offset] === 0x21) offset += 1;
    const final = bytes[offset];
    if (final === undefined) return null;
    return {
      length: offset + 1 - at,
      register: ESC_INTERMEDIATE_G0.has(b1) ? 'G0' : 'G1',
      set: String.fromCharCode(final),
      multibyte: false,
    };
  }

  if (b1 === ESC_MULTIBYTE) {
    const b2 = bytes[at + 2];
    if (b2 === undefined) return null;
    // `ESC $ ( F`, `ESC $ , F`, `ESC $ ) F`, `ESC $ - F`
    if (ESC_INTERMEDIATE_G0.has(b2) || ESC_INTERMEDIATE_G1.has(b2)) {
      const final = bytes[at + 3];
      if (final === undefined) return null;
      return {
        length: 4,
        register: ESC_INTERMEDIATE_G0.has(b2) ? 'G0' : 'G1',
        set: String.fromCharCode(final),
        multibyte: true,
      };
    }
    // `ESC $ F` — the short form, G0.
    return { length: 3, register: 'G0', set: String.fromCharCode(b2), multibyte: true };
  }

  return null;
}

/**
 * How many bytes a sequence beginning at `at` occupies even though it is NOT a
 * designation this profile knows.
 *
 * A truncated `ESC (` at the end of a field is not an escape, but its
 * intermediate byte is still structure — and a caller that skipped only the ESC
 * left a literal `(` in the middle of the decoded text. At least one byte, so a
 * lone ESC still makes progress.
 */
export function escapeRunLength(bytes: Uint8Array, at: number): number {
  let n = 1;
  const intermediate = new Set([0x21, 0x24, 0x28, 0x29, 0x2c, 0x2d]);
  while (intermediate.has(bytes[at + n] as number)) n += 1;
  return n;
}

/** The bytes that designate `set` into `register`, in the canonical spelling. */
export function writeEscape(register: Register, set: string): Uint8Array {
  if (register === 'G0' && set === MARC8_SET.basicLatin) {
    // `ESC ( B`. `ESC s` would also work and is two bytes rather than three, but
    // the technique-2 spelling is what every current system emits and what the
    // conformance tools expect.
    return new Uint8Array([0x1b, 0x28, 0x42]);
  }
  const intermediate = register === 'G0' ? 0x28 : 0x29;
  return new Uint8Array([0x1b, intermediate, set.charCodeAt(0)]);
}
