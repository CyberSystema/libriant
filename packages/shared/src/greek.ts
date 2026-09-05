/**
 * Greek text normalization — the single implementation.
 *
 * WHY THIS EXISTS AT ALL. `apps/api/src/catalog/normalize.ts` folds search text
 * with `toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')`, which is
 * correct for accents and WRONG for sigma. Unicode gives Σ a conditional
 * lowercase mapping (`Final_Sigma`): at the end of a word it becomes ς U+03C2,
 * elsewhere σ U+03C3. `String.prototype.toLowerCase` implements that rule
 * faithfully. A person typing into a search box does not — every Greek keyboard
 * layout produces σ U+03C3 unless the typist reaches for the final form.
 *
 *   MEASURED, on the code as shipped:
 *     normalizeText('ΠΟΛΙΣ')  ->  π ο λ ι U+03C2
 *     normalizeText('πολισ')  ->  π ο λ ι U+03C3
 *     equal?                  ->  false
 *
 * So `Η ΠΟΛΙΣ ΕΑΛΩ` — catalogued in capitals, which is the norm in Greek
 * library exports — cannot be found by searching `πολισ`. The book is on the
 * shelf and the catalogue says "No matches."
 *
 *   MEASURED, and worse: Postgres does NOT agree with JavaScript here.
 *     psql> SELECT lower('ΠΟΛΙΣ');   ->  π ο λ ι U+03C3   (no Final_Sigma rule)
 *     node> 'ΠΟΛΙΣ'.toLowerCase();   ->  π ο λ ι U+03C2
 *   Two runtimes, one string, two answers. Any index expression built with
 *   Postgres `lower()` and probed with a JavaScript-folded term is already
 *   inconsistent, silently, for every Greek word ending in sigma.
 *
 * THE RULE THIS FILE ESTABLISHES. Folding is not `toLowerCase`. It is
 * `toLowerCase` followed by an explicit, enumerated collapse of every Greek
 * letter that has more than one written form. That collapse must be identical
 * in TypeScript, in Postgres (`libriant_fold_greek`, see
 * `packages/shared/src/greek/greek-fold.sql`), later in the OpenSearch analysis
 * chain, and later still in the Rust core of the desktop client. `pnpm
 * check:greek-folding` is what holds those runtimes together; it is the only
 * thing standing between a name that sorts in one place and cannot be found in
 * another.
 *
 * NOTHING HERE MAY BE ADJUSTED TO "LOOK BETTER" IN ONE RUNTIME. Change the
 * fixture, run the gate, change every implementation, or change nothing.
 */

/**
 * Combining Diacritical Marks, U+0300–U+036F.
 *
 * This is the same range `catalog/normalize.ts` has always used, and it is
 * correct for polytonic Greek in a way that is easy to get wrong by accident:
 * U+0345 COMBINING GREEK YPOGEGRAMMENI (the iota subscript) is 0x345, which is
 * inside 0x300–0x36F. So `ᾍ` → NFD → α + U+0314 + U+0301 + U+0345 → `α`, and
 * `ᾳ` → `α`, with no special case. `greek.test.ts` asserts this so that a
 * future "tidy-up" of the range cannot silently drop polytonic support.
 */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * The same range as an explicit pair of code points, exported for the same
 * reason as {@link GREEK_VARIANT_FROM}: the SQL function has to state it too,
 * and the gate compares them rather than trusting that two literals written
 * months apart still say the same thing.
 */
export const GREEK_COMBINING_RANGE = { first: 0x0300, last: 0x036f } as const;

/**
 * The same range, non-global, for membership tests. A `/g` regex carries
 * `lastIndex` across calls, so `COMBINING_MARKS.test(ch)` alternates true and
 * false on identical input — a bug that would have shown up as every second
 * diacritic surviving transliteration.
 */
const IS_COMBINING_MARK = /[̀-ͯ]/;

/**
 * Greek letters with more than one written form, collapsed to the canonical
 * lowercase letter. Order within the pair strings is significant only in that
 * the two must line up.
 *
 *   ς U+03C2  final sigma          -> σ   the defect above
 *   ϲ U+03F2  lunate sigma         -> σ   Ϲ U+03F9 lowercases into this
 *   ϐ U+03D0  beta symbol          -> β   common in older Greek typesetting
 *   ϑ U+03D1  theta symbol         -> θ
 *   ϕ U+03D5  phi symbol           -> φ
 *   ϖ U+03D6  pi symbol            -> π
 *   ϰ U+03F0  kappa symbol         -> κ
 *   ϱ U+03F1  rho symbol           -> ρ
 *   ϵ U+03F5  lunate epsilon       -> ε
 *   µ U+00B5  MICRO SIGN           -> μ   NFD does not touch it; NFKD would,
 *                                         but NFKD also rewrites ligatures and
 *                                         superscripts and would change far
 *                                         more than we are asking for.
 *   ϒ U+03D2  upsilon hook symbol  -> υ
 *
 * Deliberately NOT here: ϗ U+03D7 (kai symbol). Expanding it to `και` changes
 * the token count, which would make the fold non-length-preserving per
 * character and put it out of step with the SQL `translate()` form. A record
 * using it is rare enough to fix by hand.
 */
/**
 * EXPORTED because it is a CONTRACT, not an implementation detail. The same
 * pair drives the `translate()` in `greek/greek-fold.sql`, and
 * `scripts/check-greek-folding.mjs` compares the two byte for byte — which is
 * only possible if the gate can read the authoritative one from here rather
 * than re-parsing this file's source.
 */
export const GREEK_VARIANT_FROM = 'ςϲϐϑϕϖϰϱϵµϒ';
export const GREEK_VARIANT_TO = 'σσβθφπκρεμυ';

const VARIANT_FROM = GREEK_VARIANT_FROM;
const VARIANT_TO = GREEK_VARIANT_TO;

const VARIANT_MAP: ReadonlyMap<string, string> = new Map(
  [...VARIANT_FROM].map((c, i) => [c, VARIANT_TO[i] as string]),
);

/**
 * Fold a string for searching, sorting and matching.
 *
 * Lowercase, decompose, drop every combining mark, collapse Greek letter
 * variants, collapse internal whitespace, trim. Latin text passes through the
 * same path and gets the same accent stripping it always did, so this is a
 * strict superset of `catalog/normalize.ts`'s old behaviour: every input that
 * folded to X before still folds to X, and inputs that used to fold to two
 * different values now fold to one.
 *
 * Whitespace collapsing is new. The old function only trimmed the ends, so
 * `'Καζαντζάκης,  Νίκος'` and `'Καζαντζάκης, Νίκος'` were different search
 * text. There is no reason for them to be.
 */
export function foldGreek(input: string): string {
  const lowered = input.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
  let out = '';
  for (const ch of lowered) out += VARIANT_MAP.get(ch) ?? ch;
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Phonetic (Greeklish) key
// ---------------------------------------------------------------------------

/**
 * The reduced alphabet both scripts collapse into:
 *
 *   a e i o u   v g d z th k l m n ks p r s t f h ps tz ts
 *
 * DELIBERATE COLLISIONS, because Greeklish cannot distinguish them and a
 * recall key that pretends otherwise fails on exactly the words people search
 * for:
 *
 *   β and μπ both -> `v`   Greeklish writes `b` for both; a reader cannot tell
 *                          Βάβης from Μπάμπης without knowing the word.
 *   δ and ντ both -> `d`   likewise `d`.
 *   γγ γκ γ  all  -> `g`
 *   η ι υ ει οι υι -> `i`  the vowel collapse every Greeklish writer makes.
 *   ο and ω both  -> `o`
 *
 * Precision is the price of the recall, and it is paid identically on both
 * sides: query and record run through the same function, so whatever this
 * collapses, it collapses for both.
 */
const GREEK_PHONETIC_CLUSTERS: ReadonlyArray<readonly [string, string]> = [
  ['γγ', 'g'],
  ['γκ', 'g'],
  ['γχ', 'nh'],
  ['γξ', 'nks'],
  ['μπ', 'v'],
  ['ντ', 'd'],
  ['τζ', 'tz'],
  ['τσ', 'ts'],
  ['ου', 'u'],
  ['αι', 'e'],
  ['ει', 'i'],
  ['οι', 'i'],
  ['υι', 'i'],
  ['αυ', 'av'],
  ['ευ', 'ev'],
  ['ηυ', 'iv'],
];

const GREEK_PHONETIC_LETTERS: Readonly<Record<string, string>> = {
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'i',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'ks',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  τ: 't',
  υ: 'i',
  φ: 'f',
  χ: 'h',
  ψ: 'ps',
  ω: 'o',
};

/** The same target alphabet, reached from how people actually type Greek in Latin letters. */
const LATIN_PHONETIC_CLUSTERS: ReadonlyArray<readonly [string, string]> = [
  ['tch', 'ts'],
  ['ch', 'h'],
  ['ph', 'f'],
  ['th', 'th'],
  ['ps', 'ps'],
  ['ks', 'ks'],
  ['gk', 'g'],
  ['gg', 'g'],
  ['mp', 'v'],
  ['nt', 'd'],
  ['tz', 'tz'],
  ['ts', 'ts'],
  ['ou', 'u'],
  ['ai', 'e'],
  ['ei', 'i'],
  ['oi', 'i'],
  ['ee', 'i'],
  ['ay', 'av'],
  ['ey', 'ev'],
];

const LATIN_PHONETIC_LETTERS: Readonly<Record<string, string>> = {
  a: 'a',
  b: 'v',
  c: 'k',
  d: 'd',
  e: 'e',
  f: 'f',
  g: 'g',
  h: 'h',
  i: 'i',
  j: 'i',
  k: 'k',
  l: 'l',
  m: 'm',
  n: 'n',
  o: 'o',
  p: 'p',
  q: 'k',
  r: 'r',
  s: 's',
  t: 't',
  u: 'i',
  v: 'v',
  w: 'o',
  x: 'ks',
  y: 'i',
  z: 'z',
  // Greeklish numerals, which appear in real user input.
  '8': 'th',
  '9': 'th',
  '3': 'ks',
  '0': 'o',
};

const IS_GREEK_LETTER = /\p{Script=Greek}/u;

/**
 * A deliberately lossy recall key that makes Greek and Greeklish spellings of
 * the same word collide.
 *
 *   greekPhoneticKey('βιβλιοθήκη') === greekPhoneticKey('vivliothiki')
 *   greekPhoneticKey('βιβλιοθήκη') === greekPhoneticKey('bibliothiki')
 *   greekPhoneticKey('Μπάμπης')    === greekPhoneticKey('babis')
 *
 * ONE PASS, script-aware: each position is reduced with the Greek tables or
 * the Latin ones according to the script of the character there, so a mixed
 * Greek/Latin title reduces correctly and no output is reduced twice. (An
 * earlier two-pass version fed the Greek output back through the Latin
 * tables, which mapped `μπ -> b -> v` by accident. The collapse was right; the
 * mechanism was not, and it would have mapped `θ -> th -> th -> ...` the day
 * someone added a rule for `t`.)
 *
 * THIS IS A RECALL AID AND NOTHING ELSE. Never the only index on a field,
 * never a uniqueness key, never shown to a user.
 */
export function greekPhoneticKey(input: string): string {
  const folded = foldGreek(input);
  let out = '';
  let i = 0;
  outer: while (i < folded.length) {
    const greekHere = IS_GREEK_LETTER.test(folded[i] as string);
    const clusters = greekHere ? GREEK_PHONETIC_CLUSTERS : LATIN_PHONETIC_CLUSTERS;
    const letters = greekHere ? GREEK_PHONETIC_LETTERS : LATIN_PHONETIC_LETTERS;
    for (const [from, to] of clusters) {
      if (folded.startsWith(from, i)) {
        out += to;
        i += from.length;
        continue outer;
      }
    }
    const ch = folded[i] as string;
    out += letters[ch] ?? (/[a-z0-9]/.test(ch) ? ch : ' ');
    i += 1;
  }
  // Collapse doubled letters last: Greek writes σσ/λλ/ππ, Greeklish rarely does.
  return out
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Transliteration and transcription
// ---------------------------------------------------------------------------
//
// THREE mappings, not one, because they answer three different questions and a
// library needs all three:
//
//   ISO 843 Type 1  — TRANSLITERATION. Reversible, letter-for-letter, keeps
//                     the accents. `η` is `ē`, not `i`. Used where the Greek
//                     must be recoverable from the Latin: identifiers,
//                     round-tripped exchange, deterministic keys.
//   ISO 843 Type 2  — TRANSCRIPTION. This IS ELOT 743, the standard on Greek
//                     passports and road signs. NOT reversible: `η`, `ι`, `υ`
//                     and `ει` all become `i`. This is what a Greek person
//                     expects their name to look like in Latin letters, and it
//                     is offered under ONE label — `ISO 843 Type 2 (ELOT 743)`
//                     — because offering "ISO 843" and "ELOT 743" as two
//                     choices for the same table is how a cataloguer ends up
//                     with both in one catalogue.
//   ALA-LC          — the Library of Congress romanization, and genuinely a
//                     third mapping: β→v like ELOT but φ→ph unlike it, η→ē and
//                     ω→ō like Type 1 but with `au`/`eu` diphthongs unlike
//                     either. It exists here for exactly one reason: LC, VIAF
//                     and every North American authority file are keyed on it,
//                     so matching an authority record requires producing it.

/** Type 1 base letters. Values may carry a combining macron (ē, ō). */
const ISO843_T1: Readonly<Record<string, string>> = {
  α: 'a',
  β: 'b',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'ē',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  ς: 's',
  τ: 't',
  υ: 'y',
  φ: 'f',
  χ: 'ch',
  ψ: 'ps',
  ω: 'ō',
};

/** Reverse of {@link ISO843_T1}, longest key first so `th`/`ch`/`ps`/`ē`/`ō` win. */
const ISO843_T1_REVERSE: ReadonlyArray<readonly [string, string]> = Object.entries(ISO843_T1)
  .filter(([g]) => g !== 'ς') // ς and σ both transliterate to `s`; σ is the canonical way back.
  .map(([g, l]) => [l, g] as const)
  .sort((a, b) => b[0].length - a[0].length);

/** ELOT 743 single letters. Every value is pure ASCII — relied on by {@link asciiFoldGreek}. */
const ELOT743: Readonly<Record<string, string>> = {
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'i',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  τ: 't',
  υ: 'y',
  φ: 'f',
  χ: 'ch',
  ψ: 'ps',
  ω: 'o',
};

const ALA_LC: Readonly<Record<string, string>> = {
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'ē',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  τ: 't',
  υ: 'y',
  φ: 'ph',
  χ: 'ch',
  ψ: 'ps',
  ω: 'ō',
};

/** Consonants after which αυ/ευ/ηυ voice to av/ev/iv. Vowels do too. */
const VOICED_AFTER = new Set([...'βγδζλμνρ', ...'αεηιουω']);

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/**
 * Apply the source character's case to a multi-character Latin mapping.
 * `Θεός` → `Theós` (title case) but `ΘΕΟΣ` → `THEOS` (run of capitals), which
 * is what every published romanization table does and what a cataloguer
 * copying a title page expects to see.
 */
function applyCase(latin: string, upper: boolean, runOfCapitals: boolean): string {
  if (!upper) return latin;
  if (runOfCapitals) return latin.toUpperCase();
  return latin.charAt(0).toUpperCase() + latin.slice(1);
}

interface RomanizeOptions {
  readonly table: Readonly<Record<string, string>>;
  /** Clusters applied before single letters, longest first, on lowercase input. */
  readonly clusters?: ReadonlyArray<readonly [string, string]>;
  /** Apply the ELOT αυ/ευ/ηυ voicing rule. */
  readonly voicing?: boolean;
  /** Carry combining marks from the Greek letter onto the Latin one (Type 1 only). */
  readonly keepMarks?: boolean;
}

function romanize(input: string, opts: RomanizeOptions): string {
  const nfd = input.normalize('NFD');
  const chars = [...nfd];
  const isMark = chars.map((c) => IS_COMBINING_MARK.test(c));
  // Precompute which positions are Greek capitals, so a run can be detected.
  const upperAt = chars.map((c) => isUpper(c) && IS_GREEK_LETTER.test(c));

  // The mark-free lowercase text, plus a map from each character position into
  // it, both built ONCE.
  //
  // Cluster lookahead has to ignore diacritics — `ού` must still match `ου` —
  // and the obvious way to write that is to re-filter and re-join the tail at
  // every position. That is quadratic, and it is not a theoretical concern:
  // MEASURED at 46 us for a 35-character title and 175 ms for a 3,500-character
  // one, which is a MARC 520 summary. Multiplied by a five-million-record
  // UNIMARC conversion it is the difference between an afternoon and a week.
  let stripped = '';
  const strippedIndex: number[] = new Array(chars.length);
  for (let k = 0; k < chars.length; k += 1) {
    strippedIndex[k] = stripped.length;
    if (!isMark[k]) stripped += (chars[k] as string).toLowerCase();
  }

  let out = '';
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i] as string;
    const lower = ch.toLowerCase();
    const upper = upperAt[i] === true;
    const runOfCapitals = upper && (upperAt[i - 1] === true || upperAt[i + 1] === true);

    // Combining marks are consumed by the letter that precedes them.
    if (isMark[i] === true) {
      if (opts.keepMarks) out += ch;
      i += 1;
      continue;
    }

    if (opts.clusters) {
      const at = strippedIndex[i] as number;
      let matched = false;
      for (const [from, to] of opts.clusters) {
        if (!stripped.startsWith(from, at)) continue;
        let mapped = to;
        if (opts.voicing && (from === 'αυ' || from === 'ευ' || from === 'ηυ')) {
          const next = stripped.charAt(at + from.length);
          mapped = VOICED_AFTER.has(next) ? to : to.slice(0, -1) + 'f';
        }
        out += applyCase(mapped, upper, runOfCapitals);
        // Advance past the cluster's letters, skipping the marks between them.
        let consumed = 0;
        while (i < chars.length && consumed < from.length) {
          if (isMark[i] !== true) consumed += 1;
          i += 1;
        }
        matched = true;
        break;
      }
      if (matched) continue;
    }

    const mapped = opts.table[VARIANT_MAP.get(lower) ?? lower];
    if (mapped === undefined) {
      out += ch;
      i += 1;
      continue;
    }
    out += applyCase(mapped, upper, runOfCapitals);
    i += 1;
  }

  return out.normalize('NFC');
}

/**
 * ISO 843:1997 Type 1 — reversible transliteration.
 *
 * `fromIso843Type1(toIso843Type1(s))` returns `s` for any Greek text, with the
 * single documented exception that final sigma comes back as σ: ς and σ both
 * transliterate to `s`, and no reversible mapping can recover which was
 * written. That is the same information `foldGreek` deliberately discards, so
 * the two agree with each other.
 */
export function toIso843Type1(input: string): string {
  return romanize(input, { table: ISO843_T1, keepMarks: true });
}

/** Inverse of {@link toIso843Type1}. See there for the final-sigma caveat. */
export function fromIso843Type1(input: string): string {
  const chars = [...input.normalize('NFD')];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    const upper = isUpper(chars[i] as string);
    const rest = chars.slice(i).join('').toLowerCase();
    let hit: readonly [string, string] | undefined;
    for (const entry of ISO843_T1_REVERSE) {
      if (rest.startsWith(entry[0])) {
        hit = entry;
        break;
      }
    }
    if (!hit) {
      out += chars[i] as string;
      i += 1;
      continue;
    }
    const [latin, greek] = hit;
    out += upper ? greek.toUpperCase() : greek;
    i += latin.length;
    // Re-attach any input diacritics that followed the letter.
    while (i < chars.length && IS_COMBINING_MARK.test(chars[i] as string)) {
      out += chars[i] as string;
      i += 1;
    }
  }
  return out.normalize('NFC');
}

/**
 * ISO 843:1997 Type 2 — transcription. This is ELOT 743.
 *
 *   Καζαντζάκης   -> Kazantzakis
 *   Παπαδόπουλος  -> Papadopoulos
 *   Ευθύμιος      -> Efthymios     (ευ before voiceless θ)
 *   Ευαγγελία     -> Evangelia     (ευ before a vowel)
 */
export function toIso843Type2(input: string): string {
  return romanize(input, {
    table: ELOT743,
    voicing: true,
    clusters: [
      ['γγ', 'ng'],
      ['γξ', 'nx'],
      ['γχ', 'nch'],
      ['ου', 'ou'],
      ['αυ', 'av'],
      ['ευ', 'ev'],
      ['ηυ', 'iv'],
    ],
  });
}

/**
 * ALA-LC romanization for Modern Greek.
 *
 *   Καζαντζάκης -> Kazantzakēs    (η → ē; this is how LC and VIAF spell him)
 */
export function toAlaLc(input: string): string {
  return romanize(input, {
    table: ALA_LC,
    clusters: [
      ['γγ', 'ng'],
      ['γκ', 'nk'],
      ['γξ', 'nx'],
      ['γχ', 'nch'],
      ['αυ', 'au'],
      ['ευ', 'eu'],
      ['ου', 'ou'],
    ],
  });
}

/**
 * Fold Greek to pure ASCII, for sort keys.
 *
 * Uses the ELOT 743 single-letter table with no digraph or voicing rules —
 * deterministic per character, and every value is ASCII. It is NOT a
 * romanization anyone should read: `η` and `ι` both become `i`, so Greek
 * alphabetical order is not preserved.
 *
 * WHY A SORT KEY MAY NOT CONTAIN NON-ASCII AT ALL. Tenant databases are
 * created `el_GR.UTF-8`. Under that collation, and under `el-GR-x-icu`,
 * ordering of non-ASCII text is a linguistic algorithm that JavaScript's `<`
 * does not reproduce — so a shelf order computed in the browser, in the API and
 * in Postgres would silently be three different orders. Restricting the key to
 * `[0-9A-Z]` makes ICU, the database default and byte order agree exactly:
 * MEASURED at zero mismatches over 4,000 random 12-character keys, on Postgres
 * 16.15 with `datcollate = el_GR.UTF-8`. See `callnumber/normalize.ts`.
 */
export function asciiFoldGreek(input: string): string {
  const folded = foldGreek(input);
  let out = '';
  for (const ch of folded) out += ELOT743[ch] ?? ch;
  return out;
}

// ---------------------------------------------------------------------------
// Non-filing articles
// ---------------------------------------------------------------------------

/**
 * Initial articles that a title sorts past, by language.
 *
 * This is what MARC 21 245 second indicator counts: the number of characters
 * — article plus the space after it — to skip when filing. `The Hobbit` files
 * under H with ind2 = 4; `Η ΠΟΛΙΣ ΕΑΛΩ` files under Π with ind2 = 2.
 *
 * Matching is on the FOLDED form and requires a following space, so a title
 * that simply begins with those letters (`Ηλεκτρονικοί υπολογιστές`) is
 * untouched. It cannot be perfect — a Greek title that genuinely begins with
 * the word `Το` as a subject rather than an article will be mis-filed — and
 * that is why the value is a suggestion the cataloguer can override in the
 * 245 indicator, never a computed column.
 */
const NONFILING_ARTICLES: Readonly<Record<string, readonly string[]>> = {
  // Greek: the definite article in every case and number, plus the indefinite.
  el: [
    'ο',
    'η',
    'το',
    'οι',
    'τα',
    'του',
    'της',
    'των',
    'τον',
    'την',
    'τη',
    'ένα',
    'ένας',
    'έναν',
    'μια',
    'μία',
    'μιας',
  ],
  en: ['a', 'an', 'the'],
  fr: ['le', 'la', 'les', 'un', 'une', 'des', "l'", "d'"],
  de: ['der', 'die', 'das', 'ein', 'eine', 'einen', 'einem', 'einer', 'des', 'dem', 'den'],
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', "un'", "l'"],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
  pt: ['o', 'a', 'os', 'as', 'um', 'uma'],
  nl: ['de', 'het', 'een'],
};

/**
 * The same lists, folded, because matching happens against folded text. Built
 * from the readable forms above for the reason {@link GREEK_STOPWORDS} spells
 * out: a hand-folded list is one keystroke away from an entry that can never
 * match, silently.
 */
const FOLDED_ARTICLES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(NONFILING_ARTICLES).map(([lang, list]) => [lang, list.map(foldGreek)]),
);

/**
 * Language codes are accepted as BCP 47 (`el`, `en-GB`) or MARC/ISO 639-2/B
 * (`gre`, `eng`). Greek is `gre` in MARC and `el` in BCP 47; `ell` is the
 * ISO 639-2/T terminology variant and is WRONG in a MARC 008/35-37 — getting
 * this backwards mislabels every Greek record in the catalogue.
 */
const LANG_ALIASES: Readonly<Record<string, string>> = {
  gre: 'el',
  ell: 'el',
  el: 'el',
  eng: 'en',
  en: 'en',
  fre: 'fr',
  fra: 'fr',
  fr: 'fr',
  ger: 'de',
  deu: 'de',
  de: 'de',
  ita: 'it',
  it: 'it',
  spa: 'es',
  es: 'es',
  por: 'pt',
  pt: 'pt',
  dut: 'nl',
  nld: 'nl',
  nl: 'nl',
};

export interface NonfilingResult {
  /** Characters to skip, article plus its trailing space. The MARC 245 ind2 value. */
  readonly skip: number;
  /** The title from `skip` onwards — what the sort key is built from. */
  readonly rest: string;
}

/**
 * Detect a leading non-filing article.
 *
 * With no language given, every language's articles are tried; that is the
 * right default for a mixed catalogue, and it is why `el` is listed first — a
 * Greek record whose 008/35-37 was never filled in is the common case here.
 *
 * THE COUNT IS MEASURED ON THE ORIGINAL STRING, not on the folded one. Folding
 * collapses runs of whitespace, so a title imported with a double space —
 * `The  Hobbit`, which real MARC exports contain — folded to `the hobbit`, and
 * a skip computed from the folded offsets left the ORIGINAL string starting
 * with a space. A sort key beginning with a space files that title ahead of
 * the entire catalogue. So the article is recognised by comparing FOLDED
 * tokens, and the offset is then taken from the token's own length in the
 * original.
 */
export function stripNonfilingArticle(title: string, langCode?: string | null): NonfilingResult {
  const trimmed = title.replace(/^\s+/, '');
  const lead = title.length - trimmed.length;
  const head = /^(\S+)(\s*)/.exec(trimmed);
  if (!head) return { skip: 0, rest: title };

  const token = head[1] as string;
  const gap = head[2] as string;
  const foldedToken = foldGreek(token);

  const key = langCode ? LANG_ALIASES[langCode.toLowerCase().slice(0, 3)] : undefined;
  const langs = key && FOLDED_ARTICLES[key] ? [key] : Object.keys(FOLDED_ARTICLES);

  for (const lang of langs) {
    for (const article of FOLDED_ARTICLES[lang] as readonly string[]) {
      // Apostrophe articles (l', d', un') attach directly to the next word, so
      // they are a prefix of the token rather than the whole of it.
      const glued = article.endsWith("'");
      const skip = glued
        ? foldedToken.startsWith(article)
          ? lead + article.length
          : -1
        : foldedToken === article
          ? lead + token.length + gap.length
          : -1;
      if (skip < 0) continue;
      // The whole title IS the article: file on it rather than on nothing.
      if (skip >= title.length) continue;
      return { skip, rest: title.slice(skip) };
    }
  }
  return { skip: 0, rest: title };
}

/**
 * Greek function words that carry no discrimination in a search index.
 *
 * Kept deliberately short. An aggressive stop list is how a catalogue loses
 * the ability to find `Ο Θεός και ο άνθρωπος` by its exact title, so this
 * holds only articles, the commonest prepositions and conjunctions, and the
 * negatives — nothing that could be a title in its own right.
 *
 * EVERY ENTRY IS RUN THROUGH `foldGreek` AT CONSTRUCTION rather than written
 * in folded form by hand. The list is matched against folded tokens, and a
 * word ending in sigma written naturally — `της`, `τους`, `τις` — carries the
 * final form U+03C2 while a folded token carries U+03C3. Hand-folding the list
 * means every future addition is one keystroke away from being a stopword
 * that never matches anything, silently. Written this way it cannot happen,
 * and the accented forms (`ή`, `από`) are normalised for free.
 */
export const GREEK_STOPWORDS: ReadonlySet<string> = new Set(
  [
    'ο',
    'η',
    'το',
    'οι',
    'τα',
    'του',
    'της',
    'των',
    'τον',
    'την',
    'τη',
    'τους',
    'τις',
    'ένα',
    'ένας',
    'έναν',
    'μια',
    'μιας',
    'και',
    'κι',
    'ή',
    'αλλά',
    'όμως',
    'ότι',
    'που',
    'πως',
    'σε',
    'στο',
    'στη',
    'στην',
    'στον',
    'στα',
    'στους',
    'στις',
    'με',
    'για',
    'από',
    'προς',
    'παρά',
    'αντί',
    'υπό',
    'επί',
    'περί',
    'ως',
    'κατά',
    'διά',
    'να',
    'θα',
    'δεν',
    'μη',
    'μην',
    'ας',
    'είναι',
    'ήταν',
  ].map(foldGreek),
);
