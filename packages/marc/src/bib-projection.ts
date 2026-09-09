import { foldGreek, stripNonfilingArticle } from '@libriant/shared/greek';
import { checkIdentifier, type IdentifierScheme } from '@libriant/shared/identifiers';
import { callNumberSortKey, type CallNumberScheme } from '@libriant/shared/callnumber';
import { isDataField, subfieldCode, subfieldValue, type MarcRecord } from './types.js';

/**
 * The relational projection of a MARC record.
 *
 * ## Pure, total, and never throws
 *
 * That is the phase-11 line's own wording, and it is not a style preference. A
 * projector runs inside the write transaction on every save and inside a
 * 10,000-record import; a librarian's typo that could throw would abort a save,
 * or abort an import halfway through and leave a library with a partially
 * catalogued shelf. The contract this copies already ships here —
 * `callNumberKey` in `@libriant/shared/callnumber`, whose docblock says "a
 * librarian's typo must not be able to 500 a shelf list or abort an inventory
 * upload halfway through a 50,000-item session".
 *
 * So every failure is a VALUE, not an exception: `{ projection, anomalies }`.
 *
 * ## Totality has a second half that is easy to miss
 *
 * A function that never throws but returns a value the INSERT rejects has moved
 * the abort, not removed it. Measured against the real §3 DDL:
 *
 *     char(3)    <- 'gree'  (assignment)      ERROR 22001 value too long   ABORTS
 *     char(3)    <- 'gree'::char(3)           'gre'   -- SILENTLY TRUNCATED
 *     char(3)    <- 'gr'                      accepted; never equals 'gre'
 *     smallint   <- 32768                     ERROR 22003 out of range     ABORTS
 *
 * Note the asymmetry: a "defensive" cast turns an abort into silent corruption,
 * and `'gr'` is the worst of the three because it throws nothing, matches no
 * facet query, and is wrong forever. So every value is validated and CLAMPED
 * here, in the pure function, where the anomaly can be recorded — never by a
 * cast at the database boundary.
 *
 * ## What this does NOT produce
 *
 * Six of `bib_records`' columns have no MARC source and must never be written
 * from here: `item_count` and `available_count` are counts over `items`;
 * `suppressed_from_opac` is staff state; `custom_fields` is tenant-defined;
 * `legacy_json` is phase 19's copy-forward provenance, written once and
 * unreconstructible afterwards; `cover_asset_ref` comes from an upload. They are
 * absent from {@link BibProjection} so that an `ON CONFLICT DO UPDATE` written
 * from this type cannot destroy them — see `BibProjectionService` for why that
 * matters more than it sounds.
 *
 * `work_cluster_id` is phase 40's and stays NULL. `material_type_id` is a
 * foreign key into a tenant's own `material_types` rows, which a pure function
 * cannot know; the projector emits `carrierTypeCode` and the service maps it.
 */

/** Everything a projection can complain about. */
export const PROJECTION_ANOMALY = {
  /** No 245, or a 245 with nothing usable in it. The title is a sentinel. */
  titleMissing: 'title-missing',
  /**
   * A 245 with a $b and no $a — malformed, since $a is required when 245 is
   * present. The subtitle is used, because it IS title information and a
   * sentinel would hide a record that is perfectly findable.
   */
  titleNoSubfieldA: 'title-no-subfield-a',
  /** A field MARC 21 marks unrepeatable appeared twice; the first was taken. */
  fieldRepeated: 'field-repeated-unrepeatable',
  /** 245 indicator 2 was not a digit. Treated as 0. */
  nonfilingInvalid: 'nonfiling-indicator-invalid',
  /** 245 indicator 2 pointed past the end of the title. Treated as 0. */
  nonfilingTooLong: 'nonfiling-indicator-too-long',
  /** ind2 and the article detector disagree. ind2 wins; this is the review queue. */
  nonfilingDisagrees: 'nonfiling-indicator-disagrees',
  /** 100 and 110 and/or 111 all present. MARC 21 allows one. The first was taken. */
  multipleMainEntries: 'multiple-main-entries',
  /** 008 was absent, short, or not a control field. Fixed-field values are NULL. */
  fixedFieldUnusable: 'fixed-field-unusable',
  /** A date position held something that is not a year. */
  dateUnparsable: 'date-unparsable',
  /** A code field was not exactly three characters. Stored as NULL. */
  codeWrongWidth: 'code-wrong-width',
  /** An identifier failed its own check digit. Stored anyway, flagged. */
  identifierInvalid: 'identifier-invalid',
  /**
   * A `024 7#` whose `$2` names a scheme this version does not project — or
   * names none at all. NOT stored: guessing a scheme would flag a perfectly
   * good ISWC as an invalid DOI.
   */
  identifierUnknownScheme: 'identifier-unknown-scheme',
  /** 264 and 260 both present and disagreeing. 264 wins. */
  rdaAacr2Conflict: 'rda-aacr2-conflict',
  /** A value was longer than anything a person would type. Truncated. */
  valueTruncated: 'value-truncated',
  /**
   * The title folded to nothing, so the sort key fell back to the sentinel.
   *
   * A 245 $a that is a bare combining mark, or is entirely punctuation, folds to
   * the empty string — and an empty `sort_title` files the record ahead of the
   * whole catalogue. The fallback is silent otherwise, and a record that files
   * under "[Untitled]" while displaying a title is the kind of thing only a
   * queue will ever surface.
   */
  sortKeyUnderivable: 'sort-key-underivable',
} as const;

export type ProjectionAnomalyCode = (typeof PROJECTION_ANOMALY)[keyof typeof PROJECTION_ANOMALY];

export type ProjectionAnomaly = {
  readonly code: ProjectionAnomalyCode;
  /** The tag it is about, `'LDR'`, or `''` when it is about the record. */
  readonly tag: string;
  /** One sentence, addressed to a cataloguer. */
  readonly message: string;
};

export type ProjectedIdentifier = {
  readonly scheme: IdentifierScheme;
  /** As transcribed, qualifiers and all. */
  readonly value: string;
  /** Digits only. Equal to `value` when nothing needed stripping. */
  readonly valueNorm: string;
  /** Whether the check digit agrees. A false one is STORED, never refused. */
  readonly valid: boolean;
  /** 020 $z, 022 $y/$z — an identifier the record itself marks as wrong. */
  readonly cancelled: boolean;
  /** The tag it came from, so a cataloguer can find it. */
  readonly sourceTag: string;
};

export type ProjectedClassification = {
  /** `lcc` | `ddc` | `udc` | `nlm` | `local`. */
  readonly scheme: CallNumberScheme;
  readonly value: string;
  /** Pure ASCII, fixed width, from `@libriant/shared/callnumber`. */
  readonly sortKey: string;
  readonly sourceTag: string;
};

/** The projector-owned columns of `bib_records`, and the two satellites. */
export type BibProjection = {
  readonly title: string;
  readonly titleNonfilingSkip: number;
  readonly sortTitle: string;
  readonly statementOfResp: string | null;
  readonly mainEntryDisplay: string | null;
  readonly mainEntryNorm: string | null;
  readonly edition: string | null;
  readonly publisher: string | null;
  readonly publicationPlace: string | null;
  readonly publicationYear: number | null;
  readonly publicationYearEnd: number | null;
  readonly languageCode: string | null;
  readonly languageCodes: readonly string[];
  readonly countryCode: string | null;
  readonly contentTypeCode: string | null;
  readonly mediaTypeCode: string | null;
  readonly carrierTypeCode: string | null;
  readonly extent: string | null;
  readonly physicalDescription: string | null;
  readonly seriesStatement: string | null;
  readonly summary: string | null;
  readonly matchKey: string;
  readonly searchText: string;
  readonly browseAuthor: string | null;
  readonly identifiers: readonly ProjectedIdentifier[];
  readonly classifications: readonly ProjectedClassification[];
};

export type ProjectionResult = {
  readonly projection: BibProjection;
  readonly anomalies: readonly ProjectionAnomaly[];
};

/**
 * The widest a projected text column is allowed to get.
 *
 * Not a database limit — every one of them is `text` — but a sanity ceiling. A
 * 30 KB 245 $a exists in real imported data (a whole abstract pasted into the
 * title), and letting it through makes the record page unreadable, the browse
 * list unusable and the search_text a liability. Truncating with an anomaly puts
 * it in a queue instead.
 */
const MAX_TEXT = 2000;
/** `search_text` gets more room: it is the union of everything indexed. */
const MAX_SEARCH_TEXT = 8000;

/** The title a record gets when it has none. Visible, and searchable as such. */
export const UNTITLED = '[Untitled]';

class Collector {
  readonly anomalies: ProjectionAnomaly[] = [];
  add(code: ProjectionAnomalyCode, tag: string, message: string): void {
    this.anomalies.push({ code, tag, message });
  }
}

// ---------------------------------------------------------------------------
// Field access. Every one of these is total.
// ---------------------------------------------------------------------------

function dataFields(record: MarcRecord, tag: string) {
  return record.fields.filter((f) => f.t === tag && isDataField(f));
}

function controlValue(record: MarcRecord, tag: string): string | null {
  const f = record.fields.find((x) => x.t === tag && !isDataField(x));
  return f && 'v' in f ? f.v : null;
}

/** Every value of one subfield code in one field, in document order. */
function subfields(field: ReturnType<typeof dataFields>[number], code: string): string[] {
  if (!isDataField(field)) return [];
  return field.s.filter((sf) => subfieldCode(sf) === code).map((sf) => subfieldValue(sf));
}

/** The first occurrence of a tag, complaining if MARC 21 says there is one. */
function firstOf(
  record: MarcRecord,
  tag: string,
  c: Collector,
  unrepeatable: boolean,
): ReturnType<typeof dataFields>[number] | null {
  const all = dataFields(record, tag);
  if (all.length === 0) return null;
  if (unrepeatable && all.length > 1) {
    c.add(
      PROJECTION_ANOMALY.fieldRepeated,
      tag,
      `${tag} appears ${all.length} times and MARC 21 allows one. The first was used.`,
    );
  }
  return all[0] ?? null;
}

/**
 * A surrogate code unit with no partner.
 *
 * Real imported data contains them — a MARC-8 conversion that emitted half a
 * pair, a broken UTF-16 export — and `slice()` on a code-unit offset MANUFACTURES
 * them by cutting an astral character in half.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replace lone surrogates with U+FFFD, which is what the database does anyway.
 *
 * MEASURED, against a real tenant database: sending `'A\uD800B'` through
 * node-postgres and reading it straight back returns `'A\uFFFDB'`. Postgres
 * `text` is UTF-8 and an unpaired surrogate has no UTF-8 encoding, so the value
 * is rewritten in transit — silently, with no error anywhere.
 *
 * The consequence is worse than a mangled character. `catalog-verify` compares a
 * freshly computed projection against the stored one, so a record with a lone
 * surrogate would be reported as drifted on EVERY nightly run, for ever, and
 * `--repair` could not fix it: the repair writes the surrogate again and the
 * database turns it into U+FFFD again. Doing the substitution here makes the
 * projector produce the value the database will actually hold.
 */
function sanitize(raw: string): string {
  return raw.replace(LONE_SURROGATE, '\uFFFD');
}

/**
 * Truncate WITHOUT splitting a surrogate pair.
 *
 * `'…'.slice(0, 2000)` cuts on code units, so an astral character straddling the
 * boundary — a musical symbol, an emoji, Linear B, Gothic — leaves a lone high
 * surrogate at the end. See {@link sanitize} for why that is not merely ugly.
 * Dropping the orphan is one character shorter and is what every caller wants.
 */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Trim, collapse runs of whitespace, drop trailing ISBD punctuation. */
function tidy(raw: string): string {
  return sanitize(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[/:;,=]$/, '')
    .trim();
}

function clampText(value: string | null, tag: string, c: Collector, max = MAX_TEXT): string | null {
  if (value === null) return null;
  const t = tidy(value);
  if (t.length === 0) return null;
  if (t.length <= max) return t;
  c.add(
    PROJECTION_ANOMALY.valueTruncated,
    tag,
    `${tag} held ${t.length} characters and was truncated to ${max}.`,
  );
  return cut(t, max);
}

/**
 * A MARC code field, or NULL.
 *
 * MARC codes are TWO OR THREE letters, right-padded with spaces to fill the
 * slot: `gre` is the language Greek and `gr ` is the country Greece, and both
 * are correct. A rule demanding exactly three letters rejects every
 * two-letter country code in every record — measured, 200 of 200 corpus
 * records — which is how a "strict" validator becomes a validator nobody can
 * leave switched on.
 *
 * The trailing space is dropped rather than stored, and that is safe because
 * the column is `char(3)`: Postgres pads on write and IGNORES trailing spaces
 * in comparison, so `'gr'` and `'gr '` are the same value to every query.
 *
 * Anything that is not two or three letters IS an anomaly and becomes NULL. In
 * particular a value that spilled its slot — `gree` where the language should
 * be — must not be truncated to `gre`, because a silently truncated code is
 * indistinguishable from a correct one forever after.
 */
function code3(
  raw: string | null,
  tag: string,
  c: Collector,
  /**
   * The narrowest legal code for THIS field, and the two differ.
   *
   * MARC 21 language codes (008/35-37, 041) are always three letters — `gre`,
   * `eng`. Country codes (008/15-17) are two OR three, right-padded: `gr` is
   * Greece and `enk` is England. Flattening the two into one rule either
   * rejects every two-letter country (measured: 200 of 200 corpus records) or
   * silently accepts a truncated language.
   */
  minLength: 2 | 3,
): string | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  // `|||`, `   ` and an empty slot are MARC's own spellings of "not coded".
  if (v.length === 0 || /^\|+$/.test(v)) return null;
  if (v.length < minLength || !/^[a-z]{2,3}$/.test(v)) {
    c.add(
      PROJECTION_ANOMALY.codeWrongWidth,
      tag,
      `${tag} held ${JSON.stringify(raw)}, which is not a ` +
        `${minLength === 3 ? 'three' : 'two- or three'}-letter code. Stored as empty.`,
    );
    return null;
  }
  return v;
}

/** A four-digit year within smallint range, or NULL. */
function year(raw: string, tag: string, c: Collector): number | null {
  const v = raw.trim();
  // `uuuu`, `9999`, `    ` and `||||` are all legitimate MARC for "unknown".
  if (v.length === 0 || /^[u|\s9]+$/i.test(v)) return null;
  if (!/^\d{4}$/.test(v)) {
    c.add(
      PROJECTION_ANOMALY.dateUnparsable,
      tag,
      `${tag} held ${JSON.stringify(raw)}, which is not a year.`,
    );
    return null;
  }
  const n = Number(v);
  // smallint is -32768..32767; a four-digit year cannot exceed it, but the
  // check is written down so a future five-digit source cannot abort a save.
  if (n > 32767) {
    c.add(PROJECTION_ANOMALY.dateUnparsable, tag, `${tag} year ${n} is out of range.`);
    return null;
  }
  return n;
}

// ---------------------------------------------------------------------------

/**
 * Project one record.
 *
 * Never throws. Every branch that cannot produce a value produces `null` (or the
 * sentinel, for the two NOT NULL columns) and an anomaly.
 */
export function projectBib(record: MarcRecord): ProjectionResult {
  const c = new Collector();

  // -- title, and the sort key that files it ---------------------------------
  const f245 = firstOf(record, '245', c, true);
  const a245 = f245 ? subfields(f245, 'a').join(' ') : '';
  const b245 = f245 ? subfields(f245, 'b').join(' ') : '';
  const rawTitle = tidy([a245, b245].filter(Boolean).join(' '));
  const title = rawTitle.length > 0 ? (clampText(rawTitle, '245', c) ?? UNTITLED) : UNTITLED;
  if (title === UNTITLED) {
    c.add(
      PROJECTION_ANOMALY.titleMissing,
      '245',
      f245
        ? 'The 245 has no $a or $b, so this record has no title.'
        : 'This record has no 245, so it has no title.',
    );
  } else if (f245 && tidy(a245).length === 0) {
    // $a is required when 245 is present, so this record is malformed — but the
    // subtitle is real title information and a patron can find the record by it.
    // Using the sentinel here would hide a findable record behind "[Untitled]".
    c.add(
      PROJECTION_ANOMALY.titleNoSubfieldA,
      '245',
      'The 245 has a $b and no $a. The subtitle was used as the title.',
    );
  }

  // THE SKIP INDEXES THE RAW `$a`, NOT THE DISPLAY TITLE.
  //
  // MARC 21 defines 245 indicator 2 as the number of characters at the start of
  // the field to be disregarded — counted in the field as transcribed, spaces
  // and diacritics included. `title` above has been through `tidy`, which
  // collapses runs of whitespace, so a `$a` of `"Ο  κόσμος"` (a double space,
  // which real catalogues are full of) correctly carries ind2 = 3 and would
  // have had three characters sliced off the nine-character tidied form:
  // measured, `sortTitle` came out `οσμοσ` instead of `κοσμοσ`, so the book
  // filed under Σ and a spurious `nonfiling-indicator-disagrees` was raised on
  // top. The comment that used to sit here named exactly that trap while the
  // code walked into it.
  //
  // So: slice the untidied string, and tidy afterwards. `$b` is joined back on
  // untidied for the same reason — the offset must land in the same string the
  // cataloguer counted in.
  const skip = nonfilingSkip(f245, a245, c);
  const rawJoined = [a245, b245].filter(Boolean).join(' ');
  // THREE fallbacks, and the last one is the point. `foldGreek` strips combining
  // marks, so a 245 $a that is nothing but a combining acute — which exists in
  // the semantic corpus and in real broken imports — folds to the empty string
  // and BOTH of the first two candidates are `''`. `sort_title` is NOT NULL and
  // an empty one files the record ahead of the entire catalogue, which is the
  // one behaviour the column's docblock names as unacceptable. So the sentinel
  // is the floor: a record that files under "[Untitled]" is findable and
  // obviously wrong, which is what a cataloguer needs.
  const sortTitle = foldGreek(tidy(rawJoined.slice(skip))) || foldGreek(title) || UNTITLED;
  if (sortTitle === UNTITLED && title !== UNTITLED) {
    c.add(
      PROJECTION_ANOMALY.sortKeyUnderivable,
      '245',
      `The title ${JSON.stringify(title)} folds to nothing, so this record files under ` +
        `${JSON.stringify(UNTITLED)} rather than ahead of the whole catalogue.`,
    );
  }

  // -- main entry ------------------------------------------------------------
  const mainEntry = projectMainEntry(record, c);

  // -- the fixed field, which everything below leans on -----------------------
  const f008 = controlValue(record, '008');
  if (f008 === null || f008.length < 40) {
    c.add(
      PROJECTION_ANOMALY.fixedFieldUnusable,
      '008',
      f008 === null
        ? 'This record has no 008, so language, country and dates are unknown.'
        : `The 008 is ${f008.length} characters and must be 40. Its values were not read.`,
    );
  }
  const fixed = f008 !== null && f008.length >= 40 ? f008 : null;
  const dateType = fixed ? fixed.slice(6, 7) : '';
  const y1 = fixed ? year(fixed.slice(7, 11), '008/07-10', c) : null;
  const y2 = fixed ? year(fixed.slice(11, 15), '008/11-14', c) : null;

  // -- publication -----------------------------------------------------------
  const pub = projectPublication(record, c);

  // -- physical description, series, summary ---------------------------------
  const f300 = firstOf(record, '300', c, false);
  const extent = f300 ? clampText(subfields(f300, 'a').join(' '), '300', c) : null;
  const physical = f300
    ? clampText(['a', 'b', 'c'].flatMap((code) => subfields(f300, code)).join(' '), '300', c)
    : null;

  const f490 = firstOf(record, '490', c, false) ?? firstOf(record, '440', c, false);
  const series = f490 ? clampText(subfields(f490, 'a').join(' '), f490.t, c) : null;

  const f520 = firstOf(record, '520', c, false);
  const summary = f520 ? clampText(subfields(f520, 'a').join(' '), '520', c) : null;

  // -- RDA 336/337/338 -------------------------------------------------------
  const rdaCode = (tag: string) => {
    const f = firstOf(record, tag, c, false);
    return f ? (clampText(subfields(f, 'b').join(''), tag, c) ?? null) : null;
  };

  // -- satellites ------------------------------------------------------------
  const identifiers = projectIdentifiers(record, c);
  const classifications = projectClassifications(record);

  // -- language, which comes from two places ---------------------------------
  const primaryLanguage = fixed ? code3(fixed.slice(35, 38), '008/35-37', c, 3) : null;
  const extraLanguages = dataFields(record, '041')
    .flatMap((f) => subfields(f, 'a'))
    .map((v) => code3(v, '041', c, 3))
    .filter((v): v is string => v !== null);
  const languageCodes = [
    ...new Set([primaryLanguage, ...extraLanguages].filter(Boolean)),
  ] as string[];

  const projection: BibProjection = {
    title,
    titleNonfilingSkip: skip,
    sortTitle,
    statementOfResp: f245 ? clampText(subfields(f245, 'c').join(' '), '245', c) : null,
    mainEntryDisplay: mainEntry.display,
    mainEntryNorm: mainEntry.norm,
    edition: (() => {
      const f = firstOf(record, '250', c, true);
      return f ? clampText(subfields(f, 'a').join(' '), '250', c) : null;
    })(),
    publisher: pub.publisher,
    publicationPlace: pub.place,
    publicationYear: y1,
    // A single date has one year; only 008/06 values that MEAN a range carry a
    // second. Copying 008/11-14 unconditionally makes every monograph look like
    // a multi-year set, because a great many records carry `9999` or a repeat
    // of the first date there.
    publicationYearEnd: 'mdciqku'.includes(dateType) ? y2 : null,
    languageCode: primaryLanguage,
    languageCodes,
    countryCode: fixed ? code3(fixed.slice(15, 18), '008/15-17', c, 2) : null,
    contentTypeCode: rdaCode('336'),
    mediaTypeCode: rdaCode('337'),
    carrierTypeCode: rdaCode('338'),
    extent,
    physicalDescription: physical,
    seriesStatement: series,
    summary,
    matchKey: matchKey(sortTitle, mainEntry.norm, y1),
    searchText: searchText(record, c),
    browseAuthor: mainEntry.browse,
    identifiers,
    classifications,
  };

  return { projection, anomalies: c.anomalies };
}

/**
 * 245 indicator 2: how many leading characters do not file.
 *
 * A cataloguer's assertion beats a heuristic, so ind2 wins — but when the
 * article detector disagrees that is recorded, because a catalogue imported from
 * a system that never set ind2 has thousands of titles filing under "The", and
 * that queue is what makes it fixable.
 *
 * `raw245a` is the UNTIDIED `$a`. MARC 21 counts the indicator against the field
 * as transcribed, so both the length guard and the detector have to look at the
 * same string the cataloguer counted in — see the call site for what happens
 * when they do not.
 */
function nonfilingSkip(
  f245: ReturnType<typeof dataFields>[number] | null,
  raw245a: string,
  c: Collector,
): number {
  if (!f245 || !isDataField(f245)) return 0;
  const ind2 = f245.i.length > 1 ? f245.i[1]! : ' ';
  if (!/^[0-9]$/.test(ind2)) {
    // A blank ind2 is overwhelmingly common in legacy ABEKT and Aleph data and
    // is not worth an anomaly on its own; anything else is.
    if (ind2 !== ' ') {
      c.add(
        PROJECTION_ANOMALY.nonfilingInvalid,
        '245',
        `245 indicator 2 is ${JSON.stringify(ind2)}, which is not a digit. Treated as 0.`,
      );
    }
    return 0;
  }
  const n = Number(ind2);
  // `n > 0` first: a 245 with a $b and no $a has an empty `raw245a`, and ind2 = 0
  // on it is the ordinary case, not a title that would sort to nothing.
  if (n > 0 && n >= raw245a.length) {
    c.add(
      PROJECTION_ANOMALY.nonfilingTooLong,
      '245',
      `245 indicator 2 is ${n} and 245 $a is ${raw245a.length} characters, so the sort key ` +
        'would be empty. Treated as 0.',
    );
    return 0;
  }
  const detected = stripNonfilingArticle(raw245a).skip;
  if (detected !== n) {
    c.add(
      PROJECTION_ANOMALY.nonfilingDisagrees,
      '245',
      `245 indicator 2 says skip ${n}; the article detector says ${detected}. The indicator ` +
        'was used.',
    );
  }
  return n;
}

function projectMainEntry(
  record: MarcRecord,
  c: Collector,
): { display: string | null; norm: string | null; browse: string | null } {
  const present = ['100', '110', '111'].filter((t) => dataFields(record, t).length > 0);
  if (present.length === 0) return { display: null, norm: null, browse: null };
  if (present.length > 1) {
    c.add(
      PROJECTION_ANOMALY.multipleMainEntries,
      present.join('/'),
      `This record has ${present.join(' and ')}. MARC 21 allows one main entry; ` +
        `${present[0]} was used.`,
    );
  }
  const tag = present[0]!;
  const f = firstOf(record, tag, c, true);
  if (!f) return { display: null, norm: null, browse: null };
  const display = clampText(
    ['a', 'b', 'c', 'd'].flatMap((code) => subfields(f, code)).join(' '),
    tag,
    c,
  );
  // The browse form is the name WITHOUT dates: a browse list of
  // "Καζαντζάκης, Νίκος, 1883-1957." and "Καζαντζάκης, Νίκος." must be one entry.
  const browse = clampText(subfields(f, 'a').join(' '), tag, c);
  return {
    display,
    // NACO normalization is §5's phase-7 line and does not exist in this tree.
    // `foldGreek` is the honest stand-in — it is the same fold the search index
    // uses, so headings at least match each other — and the divergence is
    // recorded rather than left to look like a NACO implementation.
    norm: display === null ? null : foldGreek(display),
    browse,
  };
}

/**
 * Publisher and place, preferring RDA's 264 over AACR2's 260.
 *
 * A record carrying both is normal during a migration and is not itself an
 * error; a record whose 264 and 260 DISAGREE is worth a queue entry, because one
 * of them is stale.
 */
function projectPublication(
  record: MarcRecord,
  c: Collector,
): { publisher: string | null; place: string | null } {
  // 264 with indicator 2 = '1' is publication; '0' is production, '2'
  // distribution, '3' manufacture, '4' copyright. Only publication is wanted.
  const f264 =
    dataFields(record, '264').find((f) => isDataField(f) && f.i.length > 1 && f.i[1] === '1') ??
    null;
  const f260 = firstOf(record, '260', c, false);
  const from = (f: typeof f264, code: string) => (f ? tidy(subfields(f, code).join(' ')) : '');

  const pub264 = from(f264, 'b');
  const pub260 = from(f260, 'b');
  if (pub264 && pub260 && foldGreek(pub264) !== foldGreek(pub260)) {
    c.add(
      PROJECTION_ANOMALY.rdaAacr2Conflict,
      '264/260',
      `264 says the publisher is ${JSON.stringify(pub264)} and 260 says ` +
        `${JSON.stringify(pub260)}. The 264 was used.`,
    );
  }
  return {
    publisher: clampText(pub264 || pub260 || null, f264 ? '264' : '260', c),
    place: clampText(from(f264, 'a') || from(f260, 'a') || null, f264 ? '264' : '260', c),
  };
}

/** Which subfields of which tag carry which identifier, and whether cancelled. */
const IDENTIFIER_SOURCES: ReadonlyArray<{
  tag: string;
  scheme: IdentifierScheme;
  valid: readonly string[];
  cancelled: readonly string[];
  /** When set, only fields whose indicator 1 matches are read. */
  ind1?: string;
  /** When set, `$2` names the real scheme and `scheme` above is only a default. */
  subfield2?: boolean;
}> = [
  { tag: '020', scheme: 'isbn', valid: ['a'], cancelled: ['z'] },
  { tag: '022', scheme: 'issn', valid: ['a'], cancelled: ['y', 'z'] },
  { tag: '024', scheme: 'ismn', valid: ['a'], cancelled: ['z'], ind1: '2' },
  { tag: '024', scheme: 'ean', valid: ['a'], cancelled: ['z'], ind1: '3' },
  // 024 ind1 = 7 does NOT mean DOI. It means "source specified in $2", and the
  // sources registry holds `doi`, `uri`, `urn`, `istc`, `iswc`, `sici`, `hdl`
  // and more. An earlier draft read every `024 7#` as a DOI, which stored an
  // ISWC under `scheme = 'doi'` and flagged it invalid against the DOI shape
  // test — mislabelling the identifier AND filling the review queue with it.
  // `subfield2` says which subfield carries the real answer.
  { tag: '024', scheme: 'doi', valid: ['a'], cancelled: ['z'], ind1: '7', subfield2: true },
];

/**
 * `024 $2` values this projector recognises, folded to lower case.
 *
 * Deliberately short. `bib_identifiers.scheme` is plain text rather than an enum
 * precisely so phase 44 can add OCLC and LCCN without a migration, but a value
 * this module does not understand must not be guessed at: it goes unprojected
 * with an anomaly rather than being stored under a scheme whose check digit it
 * would then fail.
 */
const SUBFIELD_2_SCHEMES: Readonly<Record<string, IdentifierScheme>> = {
  doi: 'doi',
  ean: 'ean',
  ismn: 'ismn',
  isbn: 'isbn',
  issn: 'issn',
};

/**
 * Every identifier the record carries, valid or not.
 *
 * §5 pairs "check-digit validated" with "**None is a uniqueness constraint**",
 * and §3 explains why: the 1.0 ISBN constraint "would refuse the exact
 * catalogues this product exists to import". So an identifier that fails its
 * check digit is STORED and flagged. Refusing it would lose the only copy of a
 * number a librarian can compare against the book in her hand.
 *
 * Cancelled identifiers (020 $z, 022 $y/$z) are stored too. They are how a
 * patron searching an old citation finds the record, and they must never be
 * treated as authoritative.
 */
function projectIdentifiers(record: MarcRecord, c: Collector): ProjectedIdentifier[] {
  const out: ProjectedIdentifier[] = [];
  for (const src of IDENTIFIER_SOURCES) {
    for (const field of dataFields(record, src.tag)) {
      if (src.ind1 !== undefined) {
        const i1 = isDataField(field) && field.i.length > 0 ? field.i[0] : '';
        if (i1 !== src.ind1) continue;
      }
      // `$2` decides the scheme when the indicator only says "look in $2".
      let scheme = src.scheme;
      if (src.subfield2) {
        const declared = tidy(subfields(field, '2').join(' ')).toLowerCase();
        const known = SUBFIELD_2_SCHEMES[declared];
        if (!known) {
          c.add(
            PROJECTION_ANOMALY.identifierUnknownScheme,
            src.tag,
            declared
              ? `${src.tag} indicator 1 is 7 and $2 says ${JSON.stringify(declared)}, which this ` +
                  'version does not project. The identifier was not stored.'
              : `${src.tag} indicator 1 is 7, which means the scheme is in $2, and there is no ` +
                  '$2. The identifier was not stored.',
          );
          continue;
        }
        scheme = known;
      }
      for (const [codes, cancelled] of [
        [src.valid, false],
        [src.cancelled, true],
      ] as const) {
        for (const code of codes) {
          for (const raw of subfields(field, code)) {
            const value = tidy(raw);
            if (!value) continue;
            const verdict = checkIdentifier(scheme, value);
            if (!verdict.valid && !cancelled) {
              c.add(
                PROJECTION_ANOMALY.identifierInvalid,
                src.tag,
                `${src.tag} $${code} ${JSON.stringify(value)}: ${verdict.reason}. Stored anyway.`,
              );
            }
            out.push({
              scheme,
              value: cut(value, 200),
              valueNorm: cut(verdict.normalized, 200),
              valid: verdict.valid,
              cancelled,
              sourceTag: src.tag,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * 050 LCC, 060 NLM, 080 UDC, 082 DDC, 084 other.
 *
 * `scheme` is also the `CallNumberScheme` the sort key is built with, which is
 * why the strings are not free — `local` is the alphanumeric builder, and it is
 * the one that transliterates, so `ΠΑΙΔ 823 ΚΑΖ` files where a Greek librarian
 * expects it rather than after every Latin call number in the catalogue.
 */
const CLASSIFICATION_SOURCES: ReadonlyArray<{ tag: string; scheme: CallNumberScheme }> = [
  { tag: '050', scheme: 'lcc' },
  { tag: '060', scheme: 'nlm' },
  { tag: '080', scheme: 'udc' },
  { tag: '082', scheme: 'ddc' },
  { tag: '084', scheme: 'local' },
];

function projectClassifications(record: MarcRecord): ProjectedClassification[] {
  const out: ProjectedClassification[] = [];
  for (const src of CLASSIFICATION_SOURCES) {
    for (const field of dataFields(record, src.tag)) {
      // $a is the class number, $b the item/cutter part. Joined because a shelf
      // order that ignored the cutter would file every Dewey 823.912 together.
      const a = subfields(field, 'a').join(' ');
      const b = subfields(field, 'b').join(' ');
      const value = tidy([a, b].filter(Boolean).join(' '));
      if (!value) continue;
      out.push({
        scheme: src.scheme,
        value: cut(value, 200),
        // Computed HERE rather than by the service. An earlier draft left this
        // empty on the theory that the service owned the
        // `@libriant/shared/callnumber` dependency — which was simply false,
        // since this module already imports `foldGreek` from the same package.
        // The real argument is the other way round: a sort key produced beside
        // the value it sorts cannot be produced by a different rule than the
        // comparison, and `callNumberKey` returns an empty string rather than
        // throwing on a number it cannot parse, so this stays total.
        sortKey: callNumberSortKey(src.scheme, value),
        sourceTag: src.tag,
      });
    }
  }
  return out;
}

/**
 * A duplicate-detection key.
 *
 * INVENTED. `match_key` is `text NOT NULL` in §3 and the string appears exactly
 * once in the whole document — the DDL line declaring it. No algorithm is
 * specified anywhere, and its only consumer is phase 39's duplicate detection,
 * which is where the real one belongs.
 *
 * So this is a deliberately dull placeholder that satisfies NOT NULL and is
 * stable, cheap and obviously not a merge decision: folded title, folded main
 * entry, year. Phase 39 replaces it and must recompute every row when it does —
 * which is cheap precisely because nothing reads it yet.
 */
function matchKey(sortTitle: string, mainEntryNorm: string | null, year: number | null): string {
  return [
    cut(sortTitle, 70).replace(/\s+/g, ''),
    cut(mainEntryNorm ?? '', 30).replace(/\s+/g, ''),
    year ?? '',
  ].join('|');
}

/**
 * Everything worth matching a search against, Greek-folded.
 *
 * §3 annotates the column "Greek-folded (final sigma!)". That parenthesis is the
 * phase-1 defect: `'ΠΟΛΙΣ'.toLowerCase()` ends in U+03C2 while a typist types
 * U+03C3, so an uppercase-catalogued Greek record — the norm in Greek library
 * exports — could not be found by anyone searching for it. `foldGreek` is the
 * one function that fixes it, and it is the same fold the SQL index expression
 * uses, so a record can never be searchable in one place and not the other.
 */
function searchText(record: MarcRecord, c: Collector): string {
  const parts: string[] = [];
  for (const field of record.fields) {
    if (!isDataField(field)) continue;
    // 9XX are local/system fields and are not what a patron searches.
    if (field.t.startsWith('9')) continue;
    for (const sf of field.s) parts.push(subfieldValue(sf));
  }
  // `sanitize` here, not `tidy`: this is a bag of words for a trigram index, so
  // the ISBD punctuation `tidy` strips is not in the way — but a lone surrogate
  // from a half-converted MARC-8 import still is, because the database would
  // rewrite it to U+FFFD and the drift verifier would report this record for
  // ever. Every other field reaches this column via `tidy`, which sanitises;
  // this path reads the raw subfields, so it has to do it itself.
  const joined = foldGreek(sanitize(parts.join(' ')));
  if (joined.length <= MAX_SEARCH_TEXT) return joined;
  c.add(
    PROJECTION_ANOMALY.valueTruncated,
    '',
    `The searchable text is ${joined.length} characters and was truncated to ` +
      `${MAX_SEARCH_TEXT}. Matches near the end of this record may be missed.`,
  );
  return cut(joined, MAX_SEARCH_TEXT);
}
