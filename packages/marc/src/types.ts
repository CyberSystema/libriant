/**
 * The MARC record as this platform holds it.
 *
 * ## The shape is the storage format, not a convenience
 *
 * `MarcField[]` is exactly what goes into `marc_record_contents.content` as
 * JSONB (`docs/architecture/libriant-2.0/MASTER-ARCHITECTURE.md`, §2). The
 * single-character keys are not terseness for its own sake: at five million
 * records the key names are roughly 15 % of the JSONB, and there is no second
 * "richer" in-memory shape because two shapes is the drift this repository
 * keeps paying for.
 *
 * Two consequences follow, and both are load-bearing:
 *
 *   - **`s` is an ordered ARRAY of single-key objects, never a map.** A map
 *     would silently destroy repeated subfields and subfield order. `245 $a $b
 *     $c` and `700 $a $a` are both ordinary; in a map the second `$a` wins and
 *     the record is quietly wrong. Working with single-key objects is less
 *     pleasant in TypeScript than a `{code, value}` pair would be, and that
 *     cost is paid here rather than in a conversion layer nobody remembers.
 *   - **The leader is NOT a field.** It is `marc_records.leader char(24)`, a
 *     column, because half of it is derived (record length, base address) and
 *     the other half is queried (type, bibliographic level, encoding level).
 *     A record is therefore `{ leader, fields }`.
 *
 * ## Everything here is data, none of it is validated
 *
 * A `MarcRecord` can hold a record that MARC 21 would reject: that is the
 * point. Validation is phase 8, driven by committed Avram definitions, and it
 * is asymmetric on purpose (`validateDelta` blocks only errors an edit
 * introduced) because a legacy AACR2 record with one illegal indicator must
 * stay editable. A codec that refused to represent a bad record would make
 * that impossible and would lose the catalogue we exist to import.
 */

/**
 * One subfield: an object with exactly one key.
 *
 * The key is the subfield code — one character, `a`-`z`, `0`-`9`, and in
 * practice occasionally something else, which is why the type is `string` and
 * not a union. The value is the subfield's data with the delimiter and code
 * removed.
 */
export type Subfield = { readonly [code: string]: string };

/** A control field (001-009): no indicators, no subfields, one value. */
export type ControlField = {
  readonly t: string;
  readonly v: string;
  /** Structural anomaly codes preserved from the source. See {@link ANOMALY}. */
  readonly x?: readonly string[];
};

/** A data field (010 and above): two indicator bytes and ordered subfields. */
export type DataField = {
  readonly t: string;
  /**
   * The two indicator bytes as a literal two-character string, spaces
   * preserved — `'10'`, `'1 '`, `'  '`.
   *
   * A string rather than a pair because that is how it is written, read,
   * indexed and searched everywhere else in the profession, and because
   * `ind1`/`ind2` fields would double the JSONB key overhead for no gain.
   * A blank indicator is a SPACE, never an empty string: `'1'` is a corrupt
   * record, not a shorthand.
   */
  readonly i: string;
  readonly s: readonly Subfield[];
  readonly x?: readonly string[];
};

export type MarcField = ControlField | DataField;

export type MarcRecord = {
  /** Exactly 24 characters. Never sliced from the field data. */
  readonly leader: string;
  readonly fields: readonly MarcField[];
};

export function isControlField(f: MarcField): f is ControlField {
  return 'v' in f;
}

export function isDataField(f: MarcField): f is DataField {
  return 's' in f;
}

/**
 * Whether a TAG denotes a control field.
 *
 * MARC 21 reserves 001-009. ISO 2709 itself does not say — the structure is
 * decided by whether the field data carries indicators and delimiters — so a
 * reader that trusted only the tag would mangle the real records where the two
 * disagree, and a reader that trusted only the bytes would turn a control field
 * whose value happens to start with 0x1F into a data field. The codec uses this
 * as the EXPECTATION and records {@link ANOMALY.controlFieldHasSubfields} or
 * {@link ANOMALY.dataFieldHasNoIndicators} when the bytes say otherwise.
 *
 * `00X` rather than a numeric comparison because tags are not always numeric:
 * local practice and some UNIMARC dialects use alphabetic tags, and
 * `Number('00A') < 10` is false while the field is still a control field.
 */
export function isControlTag(tag: string): boolean {
  return tag.length === 3 && tag.startsWith('00') && tag !== '00 ';
}

/** The code of a single-key subfield object. */
export function subfieldCode(sf: Subfield): string {
  for (const k in sf) return k;
  return '';
}

/** The value of a single-key subfield object. */
export function subfieldValue(sf: Subfield): string {
  for (const k in sf) return sf[k] as string;
  return '';
}

/** Build a subfield. Exists so call sites never write `{ [code]: value }` by hand. */
export function subfield(code: string, value: string): Subfield {
  return { [code]: value };
}

/**
 * Every anomaly the codec can record, as a stable slug.
 *
 * Slugs, not sentences, because they are stored: `marc_record_contents.anomalies`
 * keeps them for the life of the record, they are counted in import reports, and
 * a librarian filters on them. Rewording a message must not invalidate a stored
 * value, so the message lives in {@link ANOMALY_MESSAGE} and the slug never
 * changes.
 */
export const ANOMALY = {
  /** Leader/20-23 was not `4500`; the declared widths were honoured on read. */
  nonStandardEntryMap: 'non-standard-entry-map',
  /** Leader/10 or /11 was not `2`; MARC 21 fixes both. */
  nonStandardCounts: 'non-standard-counts',
  /** Leader/00-04 disagreed with the actual byte length. */
  leaderLengthWrong: 'leader-length-wrong',
  /** Leader/12-16 disagreed with the end of the directory. */
  baseAddressWrong: 'base-address-wrong',
  /** The record did not end with a record terminator (0x1D). */
  missingRecordTerminator: 'missing-record-terminator',
  /** A field did not end with a field terminator (0x1E). */
  missingFieldTerminator: 'missing-field-terminator',
  /** The directory did not end with a field terminator. */
  missingDirectoryTerminator: 'missing-directory-terminator',
  /** A directory entry's length or start position was not a number. */
  directoryEntryNotNumeric: 'directory-entry-not-numeric',
  /** A directory entry pointed past the end of the record; it was clamped. */
  directoryEntryOutOfRange: 'directory-entry-out-of-range',
  /** The directory's byte length was not a whole number of entries. */
  directoryLengthRagged: 'directory-length-ragged',
  /** A tag in the directory was blank or contained a delimiter byte. */
  tagMalformed: 'tag-malformed',
  /** A 00X field carried subfield delimiters; kept as a control field. */
  controlFieldHasSubfields: 'control-field-has-subfields',
  /** A data field began with a delimiter, so it had no indicators; blanks used. */
  dataFieldHasNoIndicators: 'data-field-has-no-indicators',
  /** A subfield delimiter was the last byte, so no code followed it. */
  subfieldCodeTruncated: 'subfield-code-truncated',
  /** Bytes appeared between the indicators and the first delimiter. */
  dataBeforeFirstSubfield: 'data-before-first-subfield',
  /** A data field had no subfields at all. */
  dataFieldHasNoSubfields: 'data-field-has-no-subfields',
  /** A field terminator appeared inside field data; treated as data. */
  embeddedFieldTerminator: 'embedded-field-terminator',
  /** Fields did not appear in the order the directory listed them. */
  fieldsOutOfOrder: 'fields-out-of-order',
  /** The record's byte length exceeded the 99,999 the leader can express. */
  recordTooLong: 'record-too-long',
  /** Leader/09 said MARC-8 but the bytes did not decode as MARC-8. */
  marc8DecodeFailed: 'marc8-decode-failed',
  /** The source declared an escape sequence this codec does not implement. */
  marc8UnsupportedCharset: 'marc8-unsupported-charset',
  /** A byte had no mapping in the designated MARC-8 graphic set. */
  marc8UnmappedByte: 'marc8-unmapped-byte',
  /** The source was not valid UTF-8; replacement characters were substituted. */
  invalidUtf8: 'invalid-utf8',
} as const;

export type AnomalyCode = (typeof ANOMALY)[keyof typeof ANOMALY];

/**
 * One sentence per anomaly, addressed to a librarian looking at an import
 * report — not to the engineer who wrote the parser.
 */
export const ANOMALY_MESSAGE: Readonly<Record<AnomalyCode, string>> = {
  [ANOMALY.nonStandardEntryMap]:
    'The record declared a non-standard directory layout. It was read as declared.',
  [ANOMALY.nonStandardCounts]:
    'The record declared an unusual number of indicators or subfield-code characters.',
  [ANOMALY.leaderLengthWrong]: 'The length recorded in the leader did not match the record.',
  [ANOMALY.baseAddressWrong]: 'The data start position in the leader did not match the directory.',
  [ANOMALY.missingRecordTerminator]: 'The record did not end with a record terminator.',
  [ANOMALY.missingFieldTerminator]: 'A field did not end with a field terminator.',
  [ANOMALY.missingDirectoryTerminator]: 'The directory did not end with a field terminator.',
  [ANOMALY.directoryEntryNotNumeric]: 'A directory entry did not contain valid numbers.',
  [ANOMALY.directoryEntryOutOfRange]: 'A directory entry pointed beyond the end of the record.',
  [ANOMALY.directoryLengthRagged]: 'The directory was not a whole number of entries long.',
  [ANOMALY.tagMalformed]: 'A field tag was blank or contained an unexpected character.',
  [ANOMALY.controlFieldHasSubfields]: 'A control field contained subfield markers.',
  [ANOMALY.dataFieldHasNoIndicators]: 'A field began with a subfield marker and had no indicators.',
  [ANOMALY.subfieldCodeTruncated]: 'A subfield marker was the last character, with no code.',
  [ANOMALY.dataBeforeFirstSubfield]: 'A field contained text before its first subfield.',
  [ANOMALY.dataFieldHasNoSubfields]: 'A field had indicators but no subfields.',
  [ANOMALY.embeddedFieldTerminator]: 'A field terminator appeared inside a field and was kept.',
  [ANOMALY.fieldsOutOfOrder]: 'The fields were not stored in the order the directory listed them.',
  [ANOMALY.recordTooLong]:
    'The record is longer than the binary MARC format can address. Use MARCXML.',
  [ANOMALY.marc8DecodeFailed]: 'The record declared MARC-8 but could not be decoded as MARC-8.',
  [ANOMALY.marc8UnsupportedCharset]: 'The record uses a character set this system cannot read.',
  [ANOMALY.marc8UnmappedByte]: 'A character had no equivalent in the declared character set.',
  [ANOMALY.invalidUtf8]: 'The file was not valid UTF-8; some characters were replaced.',
};

/** An anomaly as it is stored, located precisely enough to act on. */
export type MarcAnomaly = {
  readonly code: AnomalyCode;
  /** The tag it happened in, when it happened in a field. */
  readonly tag?: string;
  /** 1-based occurrence of that tag within the record. */
  readonly occurrence?: number;
  /** Byte offset into the source record, when known. */
  readonly at?: number;
  /** What was seen, when a value is what makes it actionable. */
  readonly saw?: string;
};

export function describeAnomaly(a: MarcAnomaly): string {
  const where = a.tag
    ? ` (${a.tag}${a.occurrence && a.occurrence > 1 ? `#${a.occurrence}` : ''})`
    : '';
  const saw = a.saw ? ` Saw: ${JSON.stringify(a.saw)}.` : '';
  return `${ANOMALY_MESSAGE[a.code]}${where}${saw}`;
}

/** What a reader returns: the record, plus everything it had to forgive. */
export type ParsedRecord = {
  readonly record: MarcRecord;
  readonly anomalies: readonly MarcAnomaly[];
};

/** Thrown when a source cannot be read as MARC at all. Anomalies are the soft case. */
export class MarcError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MarcError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The leader
// ---------------------------------------------------------------------------

/** A leader for a new record: the fixed positions set, the rest blank. */
export const EMPTY_LEADER = '00000nam a2200000   4500';

/**
 * Leader positions, named. Every slice in the codec goes through these.
 *
 * Written out because the two halves behave differently and the difference is
 * the thing the bibliographic spec got backwards. {@link LEADER_DERIVED}
 * positions are recomputed on every write; {@link LEADER_FIXED} positions are
 * constants MARC 21 requires; everything else is the cataloguer's.
 */
export const LEADER = {
  recordLength: [0, 5],
  recordStatus: [5, 6],
  typeOfRecord: [6, 7],
  bibliographicLevel: [7, 8],
  typeOfControl: [8, 9],
  characterCodingScheme: [9, 10],
  indicatorCount: [10, 11],
  subfieldCodeCount: [11, 12],
  baseAddress: [12, 17],
  encodingLevel: [17, 18],
  descriptiveCatalogingForm: [18, 19],
  multipartResourceRecordLevel: [19, 20],
  entryMap: [20, 24],
} as const satisfies Record<string, readonly [number, number]>;

export type LeaderPosition = keyof typeof LEADER;

export function leaderAt(leader: string, position: LeaderPosition): string {
  const [from, to] = LEADER[position];
  return leader.slice(from, to);
}

/**
 * The positions a writer recomputes. Never trust them on read; never keep them
 * on write.
 */
export const LEADER_DERIVED = ['recordLength', 'baseAddress'] as const;

/**
 * The positions MARC 21 fixes, and the values it fixes them to.
 *
 * A record written with anything else here is rejected by Koha, Alma, Voyager
 * and `yaz-marcdump`. Three of the eight 2.0 domain specs said to preserve
 * whatever the source declared; that is right on READ and wrong on WRITE, and
 * the asymmetry is the whole rule.
 */
export const LEADER_FIXED = {
  indicatorCount: '2',
  subfieldCodeCount: '2',
  entryMap: '4500',
} as const;

/** The MARC 21 default directory entry widths, from a `4500` entry map. */
export const DEFAULT_ENTRY_MAP = {
  fieldLengthWidth: 4,
  startPositionWidth: 5,
  implementationDefinedWidth: 0,
  /** Always 3. Not in the entry map; MARC 21 fixes it. */
  tagWidth: 3,
} as const;

export type EntryMap = {
  readonly fieldLengthWidth: number;
  readonly startPositionWidth: number;
  readonly implementationDefinedWidth: number;
  readonly tagWidth: number;
};

/** Total bytes in one directory entry under a given entry map. */
export function entryWidth(map: EntryMap): number {
  return (
    map.tagWidth + map.fieldLengthWidth + map.startPositionWidth + map.implementationDefinedWidth
  );
}

/**
 * Read Leader/20-23 as the four widths it declares.
 *
 * ISO 2709 calls these the "entry map": /20 the length-of-field width, /21 the
 * starting-character-position width, /22 the implementation-defined-part width,
 * /23 undefined (and always `0` in MARC 21). MARC 21 fixes the whole thing at
 * `4500`, but the format does not, and a reader that hard-codes 12-byte entries
 * mis-slices every directory in a record that declares anything else — silently,
 * because the result is still a plausible-looking tag.
 *
 * Non-numeric or zero widths fall back to the MARC 21 defaults: a zero-width
 * length field cannot be what the writer meant, and guessing `4500` recovers
 * far more real records than refusing does.
 */
export function readEntryMap(leader: string): { map: EntryMap; standard: boolean } {
  const declared = leaderAt(leader, 'entryMap');
  if (declared === '4500') return { map: DEFAULT_ENTRY_MAP, standard: true };
  const d = (i: number): number => {
    const c = declared.charCodeAt(i) - 48;
    return c >= 0 && c <= 9 ? c : Number.NaN;
  };
  const fieldLengthWidth = d(0);
  const startPositionWidth = d(1);
  const implementationDefinedWidth = d(2);
  if (!fieldLengthWidth || !startPositionWidth || Number.isNaN(implementationDefinedWidth)) {
    return { map: DEFAULT_ENTRY_MAP, standard: false };
  }
  return {
    map: {
      fieldLengthWidth,
      startPositionWidth,
      implementationDefinedWidth,
      tagWidth: DEFAULT_ENTRY_MAP.tagWidth,
    },
    standard: false,
  };
}
