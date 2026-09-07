/**
 * MARC-8 graphic character sets, as data.
 *
 * ## Where these came from, and what is NOT here
 *
 * The Library of Congress publishes the authoritative mappings as
 * `codetables.xml` (https://www.loc.gov/marc/specifications/codetables.xml).
 * The 2.0 plan says the tables are "generated + committed" — generated so they
 * are not typed out by hand, committed so an air-gapped build fetches nothing.
 * `scripts/gen-marc8-tables.ts` is that generator, and it regenerates and diffs
 * this file against LC's own data the moment somebody puts `codetables.xml` on
 * disk.
 *
 * That file is not in this repository and the session that wrote this had no
 * network. So two of the ten graphic sets are populated here — **Basic Latin**
 * and **Extended Latin (ANSEL)** — and the other eight are declared as known-but-
 * unsupported rather than guessed.
 *
 * That split is a decision, not an omission:
 *
 *   - ANSEL is the one that matters and the one that can be checked. It is the
 *     DEFAULT G1 designation, so it is reached with no escape sequence at all,
 *     and it carries every diacritic in Latin-script cataloguing. Every LC,
 *     Koha, Aleph and Evergreen record with an accent in it exercises this table
 *     and nothing else.
 *   - A hand-typed Greek, Cyrillic, Hebrew or Arabic table would be a table
 *     nobody could check, in a product sold to Greek libraries, where one wrong
 *     row is a name that is catalogued under a letter it does not contain. The
 *     failure would be silent, permanent, and discovered by a librarian rather
 *     than by a test. An unsupported set raises
 *     {@link ANOMALY.marc8UnsupportedCharset}, substitutes U+FFFD so the damage
 *     is VISIBLE, and leaves the original bytes in `source_blob` — which is
 *     recoverable. A wrong mapping is not.
 *   - In practice the Greek path is barely affected: ABEKT is UNIMARC and
 *     exports ISO-8859-7 or UTF-8, not MARC-8 Basic Greek. Legacy 8-bit Greek
 *     codepages are phase 35's migration adapters, not this.
 *
 * `docs/architecture/libriant-2.0/README.md` records this as a phase-7
 * divergence with what has to happen to close it.
 */

import { MARC8_SET } from './marc8-sets.js';

/**
 * One graphic set: which bytes it defines, and what each one means.
 *
 * The value is a STRING, not a code point. Some MARC-8 characters map to more
 * than one Unicode code point — the whole of EACC works this way, and several
 * Extended Latin entries decompose — so a `Map<number, number>` is wrong at the
 * type level and would have to be discovered later by a record that lost half a
 * character.
 */
export type Marc8Table = {
  readonly set: string;
  readonly name: string;
  /** Byte to Unicode string. A byte absent from this map is unassigned. */
  readonly map: ReadonlyMap<number, string>;
  /** Bytes whose Unicode is a combining mark, which in MARC-8 PRECEDES its base. */
  readonly combining: ReadonlySet<number>;
};

function table(
  set: string,
  name: string,
  rows: readonly (readonly [number, string])[],
  combining: readonly number[] = [],
): Marc8Table {
  return {
    set,
    name,
    map: new Map(rows),
    combining: new Set(combining),
  };
}

// ---------------------------------------------------------------------------
// Basic Latin (final byte 'B') — ASCII, in G0 by default
// ---------------------------------------------------------------------------

const BASIC_LATIN_ROWS: [number, string][] = [];
for (let b = 0x20; b <= 0x7e; b++) BASIC_LATIN_ROWS.push([b, String.fromCharCode(b)]);

export const BASIC_LATIN = table(MARC8_SET.basicLatin, 'Basic Latin', BASIC_LATIN_ROWS);

// ---------------------------------------------------------------------------
// Extended Latin (final byte 'E') — ANSEL, in G1 by default
// ---------------------------------------------------------------------------

/**
 * ANSEL, byte by byte.
 *
 * 0xA1-0xCF are spacing characters; **0xE0-0xFE are combining marks that PRECEDE
 * the character they modify**, which is the opposite of Unicode and the single
 * most important fact about this table.
 *
 * 0xEB/0xEC and 0xFA/0xFB are the halves of a diacritic that spans TWO base
 * characters. They are listed here like any other combining mark; the decoder
 * gives them their own pass (see `marc8.ts`), because "left half" and "right
 * half" have to land on different letters and the general one-mark-one-base rule
 * cannot express that.
 */
export const EXTENDED_LATIN = table(
  MARC8_SET.extendedLatin,
  'Extended Latin (ANSEL)',
  [
    [0xa1, 'Ł'], // Ł  LATIN CAPITAL LETTER L WITH STROKE
    [0xa2, 'Ø'], // Ø  LATIN CAPITAL LETTER O WITH STROKE
    [0xa3, 'Đ'], // Đ  LATIN CAPITAL LETTER D WITH STROKE
    [0xa4, 'Þ'], // Þ  LATIN CAPITAL LETTER THORN
    [0xa5, 'Æ'], // Æ  LATIN CAPITAL LETTER AE
    [0xa6, 'Œ'], // Œ  LATIN CAPITAL LIGATURE OE
    [0xa7, 'ʹ'], // ʹ  MODIFIER LETTER PRIME (soft sign)
    [0xa8, '·'], // ·  MIDDLE DOT
    [0xa9, '♭'], // ♭  MUSIC FLAT SIGN
    [0xaa, '®'], // ®  REGISTERED SIGN
    [0xab, '±'], // ±  PLUS-MINUS SIGN
    [0xac, 'Ơ'], // Ơ  LATIN CAPITAL LETTER O WITH HORN
    [0xad, 'Ư'], // Ư  LATIN CAPITAL LETTER U WITH HORN
    [0xae, 'ʾ'], // ʾ  MODIFIER LETTER RIGHT HALF RING (alif)
    [0xb0, 'ʿ'], // ʿ  MODIFIER LETTER LEFT HALF RING (ayn)
    [0xb1, 'ł'], // ł  LATIN SMALL LETTER L WITH STROKE
    [0xb2, 'ø'], // ø  LATIN SMALL LETTER O WITH STROKE
    [0xb3, 'đ'], // đ  LATIN SMALL LETTER D WITH STROKE
    [0xb4, 'þ'], // þ  LATIN SMALL LETTER THORN
    [0xb5, 'æ'], // æ  LATIN SMALL LETTER AE
    [0xb6, 'œ'], // œ  LATIN SMALL LIGATURE OE
    [0xb7, 'ʺ'], // ʺ  MODIFIER LETTER DOUBLE PRIME (hard sign)
    [0xb8, 'ı'], // ı  LATIN SMALL LETTER DOTLESS I
    [0xb9, '£'], // £  POUND SIGN
    [0xba, 'ð'], // ð  LATIN SMALL LETTER ETH
    [0xc0, '°'], // °  DEGREE SIGN
    [0xc1, 'ℓ'], // ℓ  SCRIPT SMALL L
    [0xc2, '℗'], // ℗  SOUND RECORDING COPYRIGHT
    [0xc3, '©'], // ©  COPYRIGHT SIGN
    [0xc4, '♯'], // ♯  MUSIC SHARP SIGN
    [0xc5, '¿'], // ¿  INVERTED QUESTION MARK
    [0xc6, '¡'], // ¡  INVERTED EXCLAMATION MARK
    [0xc7, 'ß'], // ß  LATIN SMALL LETTER SHARP S
    [0xc8, '€'], // €  EURO SIGN
    // 0xE0-0xFE: combining marks. In MARC-8 these come BEFORE the base letter.
    [0xe0, '̉'], // COMBINING HOOK ABOVE (pseudo question mark)
    [0xe1, '̀'], // COMBINING GRAVE ACCENT
    [0xe2, '́'], // COMBINING ACUTE ACCENT
    [0xe3, '̂'], // COMBINING CIRCUMFLEX ACCENT
    [0xe4, '̃'], // COMBINING TILDE
    [0xe5, '̄'], // COMBINING MACRON
    [0xe6, '̆'], // COMBINING BREVE
    [0xe7, '̇'], // COMBINING DOT ABOVE
    [0xe8, '̈'], // COMBINING DIAERESIS (umlaut)
    [0xe9, '̌'], // COMBINING CARON (hacek)
    [0xea, '̊'], // COMBINING RING ABOVE
    [0xeb, '︠'], // COMBINING LIGATURE LEFT HALF
    [0xec, '︡'], // COMBINING LIGATURE RIGHT HALF
    [0xed, '̕'], // COMBINING COMMA ABOVE RIGHT
    [0xee, '̋'], // COMBINING DOUBLE ACUTE ACCENT
    [0xef, '̐'], // COMBINING CANDRABINDU
    [0xf0, '̧'], // COMBINING CEDILLA
    [0xf1, '̨'], // COMBINING OGONEK (right hook)
    [0xf2, '̣'], // COMBINING DOT BELOW
    [0xf3, '̤'], // COMBINING DIAERESIS BELOW (double dot below)
    [0xf4, '̥'], // COMBINING RING BELOW
    [0xf5, '̳'], // COMBINING DOUBLE LOW LINE (double underscore)
    [0xf6, '̲'], // COMBINING LOW LINE (underscore)
    [0xf7, '̦'], // COMBINING COMMA BELOW (left hook)
    [0xf8, '̜'], // COMBINING LEFT HALF RING BELOW
    [0xf9, '̮'], // COMBINING BREVE BELOW
    [0xfa, '︢'], // COMBINING DOUBLE TILDE LEFT HALF
    [0xfb, '︣'], // COMBINING DOUBLE TILDE RIGHT HALF
    [0xfe, '̓'], // COMBINING COMMA ABOVE (high comma, centred)
  ],
  [
    0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfe,
  ],
);

/**
 * The two double-width diacritics, as ordered halves.
 *
 * Each pair is `[left, right]`. The left half belongs on one base character and
 * the right half on the NEXT one, which is why the decoder cannot treat them
 * with the ordinary "one mark, one base" rule.
 */
export const DOUBLE_DIACRITIC_PAIRS: readonly (readonly [string, string])[] = [
  ['︠', '︡'], // ligature (double breve / tie), e.g. a transliterated digraph
  ['︢', '︣'], // double tilde
];

/** Every graphic set this codec can actually decode. */
export const SUPPORTED_TABLES: readonly Marc8Table[] = [BASIC_LATIN, EXTENDED_LATIN];

export const TABLE_BY_SET: ReadonlyMap<string, Marc8Table> = new Map(
  SUPPORTED_TABLES.map((t) => [t.set, t]),
);
