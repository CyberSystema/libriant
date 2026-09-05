/**
 * Call-number sort keys.
 *
 * A call number is a shelf address written for humans. `005.133` files before
 * `005.2`, `PA37` files before `PA4037`, and `.A21` files after `.A2` because
 * cutters are decimal fractions. None of that falls out of string comparison,
 * so every call number gets a KEY: a rewriting of the number into a form where
 * plain `<` is shelf order.
 *
 * ================================================================
 * THE KEY ALPHABET IS `[0-9A-Z]` ONLY. NO SEPARATORS. FIXED WIDTH.
 * ================================================================
 *
 * This is the constraint everything else here bends around, and it is not an
 * aesthetic choice. Tenant databases are created `el_GR.UTF-8`. Under that
 * collation — and under `el-GR-x-icu` — punctuation is *variable-weighted*: it
 * is ignored at the primary comparison level, so a separator does not separate.
 *
 *   MEASURED on Postgres 16.15, datcollate = el_GR.UTF-8:
 *
 *     ORDER BY v COLLATE "el-GR-x-icu"     ORDER BY v COLLATE "C"
 *       AB C                                 AB C
 *       AB.C                                 AB.C
 *       AB|C     <-- before ABC              ABC
 *       ABC                                  ABZ
 *       ABZ                                  AB|C   <-- after ABZ
 *
 * A `|`-separated key therefore sorts one way in Postgres and another way in
 * JavaScript, and a shelf list computed in the browser would disagree with the
 * same list computed by an `ORDER BY`. That is the perf-13 trap in a new
 * costume: an expression that looks locale-independent and is not.
 *
 * Restricted to `[0-9A-Z]`, the three orders are identical.
 *
 *   MEASURED: 4,000 random 12-character keys over `[0-9A-Z]`, ordered by
 *   `el-GR-x-icu`, by the `el_GR.UTF-8` database default and by `C`:
 *   ZERO position mismatches between any pair.
 *
 * So: segments are fixed width and simply concatenated. Padding is `'0'`,
 * which sorts below every letter in all three orders, so a shorter value files
 * before a longer one that extends it (`KE` before `KER`). Greek and any other
 * non-ASCII text is folded to ASCII by `asciiFoldGreek` before it reaches a
 * key — the third runtime that has to agree, once the desktop client's Rust
 * core computes shelf order offline in the stacks, is not a database at all.
 */

import { asciiFoldGreek } from '../greek.js';

export type CallNumberScheme = 'ddc' | 'lcc' | 'udc' | 'nlm' | 'alphanum' | 'local';

export const CALL_NUMBER_SCHEMES: readonly CallNumberScheme[] = [
  'ddc',
  'lcc',
  'udc',
  'nlm',
  'alphanum',
  'local',
];

export interface CallNumberParts {
  /** Shelving prefix held separately on the item, e.g. `REF`, `J`, `ΠΑΙΔ`. */
  readonly prefix?: string | null;
  /** The classification number itself. */
  readonly callNumber: string;
  /** Anything filed after the number: cutter, edition statement. */
  readonly suffix?: string | null;
}

export interface CallNumberKey {
  /** The sort key. Always matches `/^[0-9A-Z]+$/`. */
  readonly key: string;
  /**
   * False when the number did not parse as its declared scheme and fell back
   * to the generic alphanumeric sorter. The item still sorts, deterministically
   * and near where it belongs; it is flagged so a shelf-order report can show
   * the cataloguer what to fix rather than silently mis-filing it.
   */
  readonly parsed: boolean;
  readonly scheme: CallNumberScheme;
}

/** Everything outside `[0-9A-Z]` is removed after ASCII folding. */
function alnum(input: string): string {
  return asciiFoldGreek(input)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/** Left-pad digits with `0` to `width`. Longer input keeps its leading digits. */
function padNum(value: string, width: number): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length >= width) return digits.slice(0, width);
  return digits.padStart(width, '0');
}

/** Right-pad with `0` to `width` — for decimal fractions and for text. */
function padRight(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value.padEnd(width, '0');
}

// ---------------------------------------------------------------------------
// Trailing designations
// ---------------------------------------------------------------------------

/**
 * `v.3`, `τ.3`, `c.2`, `αντ.2`, and a four-digit year — pulled out before the
 * number is parsed, because they file last regardless of scheme and would
 * otherwise be mistaken for part of a cutter.
 *
 * The Greek forms are here because a Greek catalogue writes `τ.3` and `αντ.2`,
 * and an importer that only knew `v.` and `c.` would fold them into the cutter
 * and scatter a multi-volume set across the shelf list.
 */
/**
 * A SINGLE-LETTER designator must carry its dot: `v.3`, `τ.3`, `c.2`. A
 * multi-letter one may use a space: `vol 3`, `antitypo 2`.
 *
 * The dot is not optional for the short forms, and this was measured, not
 * guessed. `T` is the Greek τόμος folded to ASCII — and it is also an LC class
 * letter. A rule that accepted a bare `T` followed by digits swallowed the
 * class number of every LC record in class T: `T665 .A405 1979` parsed as
 * "volume 665", leaving `.A405` to be read as the class, and filed a
 * technology book under A. That was 1,939 inversions in the 2,000-number LC
 * corpus, and exactly zero in the NLM one — because NLM has no class T, which
 * is precisely how a bug like this survives a smaller test.
 */
const VOLUME_RE = /(?:^|\s)(?:(?:V|T|BD)\.\s*|(?:VOL|TOM|TOMOS)\.?\s*)(\d{1,4})(?=\s|$)/;
const COPY_RE = /(?:^|\s)(?:C\.\s*|(?:COP|COPY|ANT|ANTITYPO)\.?\s*)(\d{1,3})(?=\s|$)/;

/**
 * A year is a WHOLE, SPACE-DELIMITED TOKEN. The boundary is load-bearing in
 * both directions, and getting it wrong was measured against the reference
 * corpora rather than reasoned about:
 *
 *   `005.1999 KER`  the decimal `.1999` is not a year. A looser rule that
 *                   allowed any non-digit before it stripped the decimal and
 *                   filed the book under plain 005 — 27 inversions in the
 *                   2,000-number Dewey corpus.
 *   `PA1999 .A2`    the class number 1999 is not a year either. The same rule
 *                   destroyed the class number of almost every LC record whose
 *                   number happened to look like a date — 1,948 inversions out
 *                   of 2,000.
 */
const YEAR_RE = /(?:^|\s)(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})(?=\s|$)/;

interface Trailing {
  readonly rest: string;
  readonly volume: string;
  readonly copy: string;
  readonly year: string;
}

/** Works on the ASCII-folded, uppercased form; every parser below wants that anyway. */
function extractTrailing(raw: string): Trailing {
  let rest = asciiFoldGreek(raw).toUpperCase();
  const vol = VOLUME_RE.exec(rest);
  if (vol) rest = rest.replace(vol[0], ' ');
  const cop = COPY_RE.exec(rest);
  if (cop) rest = rest.replace(cop[0], ' ');
  const yr = YEAR_RE.exec(rest);
  if (yr) rest = rest.replace(yr[0], ' ');
  return {
    rest: rest.replace(/\s+/g, ' ').trim(),
    volume: padNum(vol?.[1] ?? '', 4),
    copy: padNum(cop?.[1] ?? '', 3),
    year: padNum(yr?.[1] ?? '', 4),
  };
}

// ---------------------------------------------------------------------------
// Dewey Decimal Classification
// ---------------------------------------------------------------------------

const DDC_RE = /^(\d{1,3})(?:\.(\d+))?/;

/** 3 class + 8 decimal + 8 mark + 4 year + 4 volume + 3 copy = 30. */
function ddcKey(parts: CallNumberParts): { key: string; parsed: boolean } {
  const t = extractTrailing(parts.callNumber);
  const m = DDC_RE.exec(t.rest);
  if (!m) return { key: '', parsed: false };
  const cls = padNum(m[1] as string, 3);
  const dec = padRight((m[2] ?? '').replace(/\D/g, ''), 8);
  const mark = padRight(alnum(t.rest.slice((m[0] as string).length) + (parts.suffix ?? '')), 8);
  return { key: cls + dec + mark + t.year + t.volume + t.copy, parsed: true };
}

// ---------------------------------------------------------------------------
// Library of Congress Classification (and NLM, which files the same way)
// ---------------------------------------------------------------------------

const LCC_RE = /^([A-Z]{1,3})\s*(\d{1,4})(?:\.(\d+))?/;
const CUTTER_RE = /\.\s*([A-Z])(\d{1,5})|(?:^|\s)([A-Z])(\d{1,5})\b/g;

/**
 * 3 alpha + 4 int + 4 dec + 3x(1 letter + 5 digits) + 4 year + 4 vol + 3 copy = 33.
 *
 * Cutter digits are right-padded because a cutter is a decimal fraction:
 * `.A2` is 0.2 and `.A21` is 0.21, so `20000` before `21000` is shelf order.
 * Getting this wrong (left-padding, or comparing as integers) files `.A21`
 * before `.A2`, which is the single most common bug in home-grown LC sorting.
 */
function lccKey(parts: CallNumberParts): { key: string; parsed: boolean } {
  const t = extractTrailing(parts.callNumber);
  const head = t.rest
    .replace(/[^0-9A-Z. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = LCC_RE.exec(head);
  if (!m) return { key: '', parsed: false };
  const alpha = padRight(m[1] as string, 3);
  const int = padNum(m[2] as string, 4);
  const dec = padRight((m[3] ?? '').replace(/\D/g, ''), 4);

  const tail =
    head.slice((m[0] as string).length) +
    ' ' +
    asciiFoldGreek(parts.suffix ?? '')
      .toUpperCase()
      .replace(/[^0-9A-Z. ]/g, ' ');

  let cutters = '';
  let found = 0;
  CUTTER_RE.lastIndex = 0;
  for (const c of tail.matchAll(CUTTER_RE)) {
    if (found >= 3) break;
    const letter = (c[1] ?? c[3]) as string;
    const digits = (c[2] ?? c[4]) as string;
    cutters += letter + padRight(digits, 5);
    found += 1;
  }
  while (found < 3) {
    cutters += '000000';
    found += 1;
  }
  return { key: alpha + int + dec + cutters + t.year + t.volume + t.copy, parsed: true };
}

/**
 * NLM classes are `W`, `WA`–`WZ` and the preclinical `QS`–`QZ`; everything else
 * in an NLM-declared number is LC. Filing is identical to LCC, so the parser is
 * shared and the scheme exists to record what the cataloguer declared.
 */
function nlmKey(parts: CallNumberParts): { key: string; parsed: boolean } {
  return lccKey(parts);
}

// ---------------------------------------------------------------------------
// Universal Decimal Classification
// ---------------------------------------------------------------------------

/**
 * UDC auxiliary signs, in the filing order the UDC Consortium publishes, with
 * the rank each contributes to the sort key. A number with no auxiliary files
 * before the same number with one, which is why each slot carries a two-digit
 * rank and absent slots pad to `00`.
 *
 * ORDER IN THIS ARRAY IS SIGNIFICANT — it is the order the tokenizer tries,
 * and the parenthesised forms must be tried most-specific first: `(=411.16)`
 * is an ethnic auxiliary, `(031)` a form one and `(495)` a place one, and all
 * three open with the same bracket.
 */
const UDC_AUXILIARIES: ReadonlyArray<{ readonly re: RegExp; readonly rank: number }> = [
  { re: /^\(=[^)]*\)/, rank: 40 }, // ethnic grouping  (=411.16)
  { re: /^\(0[^)]*\)/, rank: 20 }, // form             (031), (0.034)
  { re: /^\([^)]*\)/, rank: 30 }, // place            (410), (495)
  { re: /^=[0-9'.\-/]+/, rank: 10 }, // language         =14
  { re: /^"[^"]*"/, rank: 50 }, // time             "19"
  { re: /^\*[^\s]+/, rank: 60 }, // non-UDC notation *ABC
  { re: /^-0[0-9.]*/, rank: 70 }, // general characteristics  -05
  { re: /^\.0[0-9.]*/, rank: 80 }, // point-nought special auxiliary  .022
  { re: /^-[1-9][0-9.]*/, rank: 90 }, // hyphen special auxiliary  -1
  { re: /^'[0-9.]+/, rank: 95 }, // apostrophe synthesis  '2
];

/**
 * Split a UDC number into its main number and its auxiliaries.
 *
 * A TOKENIZER, not a set of independent regexes over the whole string. The
 * independent form was measured wrong on the published filing order: the
 * language pattern `=[0-9.]+` matched INSIDE the ethnic auxiliary `(=411.16)`,
 * and the point-nought pattern matched inside the form auxiliary `(0.034)`, so
 * both numbers were ranked twice and filed in the wrong block. Consuming each
 * token as it is recognised makes that structurally impossible.
 *
 * The main number stops at `.0`, because a dot followed by zero is the
 * point-nought special auxiliary rather than a decimal subdivision: `027.022`
 * is 027 with an auxiliary, while `621.3` is one number.
 */
function tokenizeUdc(
  source: string,
): { main: string; auxiliaries: { rank: number; content: string }[] } | null {
  const mainMatch = /^[0-9]+(?:\.[1-9][0-9]*)*/.exec(source);
  if (!mainMatch) return null;
  const main = mainMatch[0] as string;
  let rest = source.slice(main.length);
  const auxiliaries: { rank: number; content: string }[] = [];

  let guard = 0;
  while (rest.length > 0 && guard < 32) {
    guard += 1;
    if (rest.startsWith(' ') || rest.startsWith(':')) {
      // Relation signs and spacing carry no filing rank of their own here.
      rest = rest.slice(1);
      continue;
    }
    let matched = false;
    for (const { re, rank } of UDC_AUXILIARIES) {
      const hit = re.exec(rest);
      if (!hit) continue;
      auxiliaries.push({ rank, content: padRight(alnum(hit[0] as string), 8) });
      rest = rest.slice((hit[0] as string).length);
      matched = true;
      break;
    }
    if (!matched) break; // Unrecognised tail: everything after it is ignored, deliberately.
  }
  return { main, auxiliaries };
}

/** 12 main + 4x(2 rank + 8 content) + 4 year + 4 vol + 3 copy = 63. */
function udcKey(parts: CallNumberParts): { key: string; parsed: boolean } {
  const t = extractTrailing(parts.callNumber);
  const tokens = tokenizeUdc(t.rest);
  if (!tokens) return { key: '', parsed: false };
  const main = padRight(tokens.main.replace(/\./g, ''), 12);

  const auxiliaries = [...tokens.auxiliaries].sort((a, b) => a.rank - b.rank);
  let auxKey = '';
  for (let i = 0; i < 4; i += 1) {
    const a = auxiliaries[i];
    auxKey += a ? padNum(String(a.rank), 2) + a.content : '0000000000';
  }
  return { key: main + auxKey + t.year + t.volume + t.copy, parsed: true };
}

// ---------------------------------------------------------------------------
// Generic alphanumeric — the `alphanum` and `local` schemes, and the fallback
// ---------------------------------------------------------------------------

/**
 * Split into alternating letter and digit runs and pad each, so `A9` files
 * before `A10` — the one thing a plain string sort always gets wrong about a
 * local shelf code. Six runs of ten characters; anything deeper is truncated,
 * which files it adjacently rather than exactly.
 */
function alphanumKey(parts: CallNumberParts): { key: string; parsed: boolean } {
  const t = extractTrailing(parts.callNumber);
  const source = alnum(t.rest + (parts.suffix ?? ''));
  const runs = source.match(/[0-9]+|[A-Z]+/g) ?? [];
  let key = '';
  for (let i = 0; i < 6; i += 1) {
    const run = runs[i];
    if (run === undefined) key += '0000000000';
    else if (/^[0-9]+$/.test(run)) key += padNum(run, 10);
    else key += padRight(run, 10);
  }
  return { key: key + t.year + t.volume + t.copy, parsed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BUILDERS: Readonly<
  Record<CallNumberScheme, (p: CallNumberParts) => { key: string; parsed: boolean }>
> = {
  ddc: ddcKey,
  lcc: lccKey,
  nlm: nlmKey,
  udc: udcKey,
  alphanum: alphanumKey,
  local: alphanumKey,
};

/** Every scheme's key is padded to this width so one column holds them all. */
export const CALL_NUMBER_KEY_WIDTH = 96;

/** Prefix segment, filed ahead of everything: `REF`, `J`, `ΠΑΙΔ`. */
const PREFIX_WIDTH = 8;

/**
 * Build the shelf-order sort key.
 *
 * NEVER THROWS. A number that does not parse as its declared scheme falls
 * through to the generic alphanumeric sorter and comes back `parsed: false`;
 * a librarian's typo must not be able to 500 a shelf list or abort an
 * inventory upload halfway through a 50,000-item session.
 */
export function callNumberKey(
  scheme: CallNumberScheme,
  input: string | CallNumberParts,
): CallNumberKey {
  const parts: CallNumberParts = typeof input === 'string' ? { callNumber: input } : input;
  const prefix = padRight(alnum(parts.prefix ?? ''), PREFIX_WIDTH);

  let built: { key: string; parsed: boolean };
  try {
    built = BUILDERS[scheme](parts);
  } catch {
    built = { key: '', parsed: false };
  }
  let parsed = built.parsed;
  if (!built.key) {
    built = alphanumKey(parts);
    parsed = false;
  }
  return { key: padRight(prefix + built.key, CALL_NUMBER_KEY_WIDTH), parsed, scheme };
}

/** Just the key. The common call site — `items.call_number_sort`. */
export function callNumberSortKey(
  scheme: CallNumberScheme,
  input: string | CallNumberParts,
): string {
  return callNumberKey(scheme, input).key;
}
