import {
  FIELD_TERMINATOR,
  RECORD_TERMINATOR,
  SUBFIELD_DELIMITER,
  concatBytes,
  decodeLatin1,
  decodeUtf8,
  encodeLatin1,
  encodeUtf8,
  padUint,
  readUint,
} from './bytes.js';
import { decodeMarc8, encodeMarc8, newMarc8State, type Marc8State } from './marc8.js';
import {
  ANOMALY,
  DEFAULT_ENTRY_MAP,
  LEADER,
  LEADER_FIXED,
  MarcError,
  entryWidth,
  isControlTag,
  leaderAt,
  readEntryMap,
  subfieldCode,
  subfieldValue,
  type AnomalyCode,
  type DataField,
  type EntryMap,
  type MarcAnomaly,
  type MarcField,
  type MarcRecord,
  type ParsedRecord,
  type Subfield,
} from './types.js';

/**
 * ISO 2709 — the binary MARC container, read and written.
 *
 * ## The rule is asymmetric, and that is the whole design
 *
 * **On read**, honour whatever the record declares: the entry map at
 * Leader/20-23 decides how wide a directory entry is, Leader/10 decides how many
 * indicator bytes a field carries, and a record that lies about its own length
 * is read by its bytes rather than by the claim. Every deviation becomes an
 * anomaly and the record is still returned. A reader that refused them would
 * refuse exactly the catalogues this product exists to import.
 *
 * **On write**, always emit `/10='2'`, `/11='2'`, `/20-23='4500'` and recompute
 * `/00-04` and `/12-16`. Three of the eight 2.0 domain specs said to preserve
 * whatever the source declared. Records written that way are rejected by Koha,
 * Alma, Voyager and `yaz-marcdump`, so the original leader bytes survive in
 * `marc_record_contents.source_blob` and nowhere else.
 *
 * ## What it deliberately does not do
 *
 * It does not normalize. `read` returns the characters that were in the file, so
 * `write(read(b)) === b` can be true for a record catalogued in NFD — which most
 * records with diacritics are, because MARC-8 decodes to decomposed forms by
 * construction. NFC is a policy the write path applies (phase 10:
 * `applyOps` then NFC then the 005 stamp), not something a codec may do behind
 * the caller's back.
 *
 * ## What this is to `apps/api/src/import/parsers/marc-parser.ts`
 *
 * Not a replacement, and not yet a caller's concern. Phase 7 is purely
 * ADDITIVE: nothing in `apps/api/src/import` changes, and the 1.0 import path
 * survives the phase-20 cutover — the plan's phase 20 deletes
 * `{catalog,loans,reservations,fines,members}` and does not touch `import/`,
 * and phase 35 layers the migration adapters onto those same parsers. What this
 * module is, is the reader those parsers should have been, so that when phase 35
 * arrives the codec is already there and already proved.
 *
 * The 1.0 reader has three defects the 2.0 plan names, all of them addressed
 * here — and three more it does not:
 *
 *   1. **Structure discarded.** It flattened every record to `tag$code` columns
 *      and joined repeats with `' | '`, so two 700 fields cannot be told from
 *      one author whose name contains a pipe, and field order is gone.
 *   2. **Indicators dropped.** `if (fieldBuf.length >= 2 && fieldBuf[0] !== SF)
 *      i = 2;` skips the indicator bytes without reading them. The non-filing
 *      character count in `245` indicator 2 is how a title sorts; discarding it
 *      files every article-initial title under the article.
 *   3. **Subfield code read past the buffer end.** `fieldBuf[i + 1] ?? 0` on a
 *      field whose last byte is the delimiter yields the code U+0000 and a start
 *      offset beyond the end of the buffer. (In the flat table that particular
 *      variant is swallowed, because the empty value is then discarded; the
 *      OBSERVABLE variant is a non-ASCII code byte, which `String.fromCharCode`
 *      turns into a latin1 character and leaves the value starting mid-sequence.)
 *
 * And three the plan does not name, each of which this module fixes as a
 * consequence of its design rather than as a special case:
 *
 *   4. **The encoding option is ignored.** The 1.0 binary path hard-codes
 *      `toString('utf-8')` and reports `encoding: 'utf-8'` whatever was asked,
 *      while the import wizard offers "Windows-1253 (Greek)" as a choice. Here
 *      the encoding is a parameter and Leader/09 is read.
 *   5. **`trim()` destroys fixed fields.** A 40-character 008 ending in two
 *      blanks came back 38 characters, shifting every position after it. Nothing
 *      here trims anything.
 *   6. **`parseInt` accepts a sign.** A directory entry of `-0012` produced a
 *      negative offset, and `subarray` counts those from the END of the record —
 *      so one field's bytes were served under another field's tag. `readUint`
 *      accepts digits and nothing else.
 */

export type Iso2709Encoding = 'utf-8' | 'marc-8';

export type ReadOptions = {
  /**
   * Which encoding the field data is in. `'auto'` (the default) reads
   * Leader/09: `'a'` is Unicode, anything else is MARC-8, which is what MARC 21
   * says. An explicit value overrides a leader that is simply wrong, which is
   * common in exports from systems that never set it.
   */
  readonly encoding?: Iso2709Encoding | 'auto';
};

export type WriteOptions = {
  /**
   * The export encoding. Also decides Leader/09 — `'a'` for UTF-8, a space for
   * MARC-8 — because that position describes the bytes being written, not the
   * bytes that were read.
   */
  readonly encoding?: Iso2709Encoding;
  /**
   * Unicode normalization to apply to field data on the way out. Omitted means
   * "emit exactly what the record holds", which is what makes byte-exact
   * re-export of an unedited import possible at all.
   */
  readonly normalization?: 'nfc' | 'nfd';
};

/** MARC 21 caps a field at 9,999 bytes: the directory's length field is 4 digits. */
export const MAX_FIELD_BYTES = 9999;
/** And a record at 99,999: the leader's length field is 5 digits. */
export const MAX_RECORD_BYTES = 99999;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Split a stream of concatenated records.
 *
 * Uses the LENGTH the leader declares, and falls back to scanning for the record
 * terminator only when that length does not land on one. The 1.0 reader scanned
 * unconditionally, which splits a record in half the moment its data
 * legitimately contains a 0x1D byte — rare, but silent, and it produces two
 * half-records that both look parseable.
 */
export function splitIso2709(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    // Skip separators between records: some exporters write a newline after
    // each one, and DOS-era files end with 0x1A.
    const b = bytes[at] as number;
    if (b === 0x0a || b === 0x0d || b === 0x1a || b === 0x00) {
      at += 1;
      continue;
    }
    const declared = readUint(bytes, at, 5).value;
    let end = -1;
    if (Number.isFinite(declared) && declared >= 24 && at + declared <= bytes.length) {
      // Trust the declared length when it lands on a terminator AND the
      // record's own directory agrees with it.
      //
      // The terminator test alone is not enough: a leader that overstates its
      // length by roughly one record lands on the NEXT record's terminator, and
      // the two are silently swallowed into one. The directory test alone is not
      // enough either, because a record's data may legitimately contain a 0x1D
      // and the directory is then the only thing that knows where the record
      // ends. Together they decide it — and when they disagree the terminator
      // scan below is the fallback, which is what a reader with no better
      // information can do.
      const implied = impliedLength(bytes, at);
      const landsOnTerminator = bytes[at + declared - 1] === RECORD_TERMINATOR;
      if (landsOnTerminator && (implied < 0 || implied === declared)) end = at + declared;
    }
    if (end < 0) {
      for (let i = at; i < bytes.length; i++) {
        if (bytes[i] === RECORD_TERMINATOR) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) {
      // No terminator at all: some exporters omit the last one. Anything
      // shorter than a leader is trailing rubbish, not a record.
      if (bytes.length - at > 24) out.push(bytes.subarray(at));
      break;
    }
    out.push(bytes.subarray(at, end));
    at = end;
  }
  return out;
}

/**
 * The length a record's own directory implies: base address, plus the end of the
 * last field, plus the record terminator.
 *
 * Returns -1 when the leader or the directory is too damaged to say. Used only
 * to decide whether to believe Leader/00-04 when splitting a stream; the record
 * reader itself works from the bytes it is given.
 */
function impliedLength(bytes: Uint8Array, at: number): number {
  const base = readUint(bytes, at + LEADER.baseAddress[0], 5).value;
  if (!Number.isFinite(base) || base < 25 || at + base > bytes.length) return -1;
  const entries = Math.floor((base - 1 - 24) / entryWidth(DEFAULT_ENTRY_MAP));
  if (entries < 1) return -1;
  let furthest = 0;
  for (let e = 0; e < entries; e++) {
    const entry = at + 24 + e * entryWidth(DEFAULT_ENTRY_MAP);
    const len = readUint(bytes, entry + 3, 4).value;
    const start = readUint(bytes, entry + 7, 5).value;
    if (!Number.isFinite(len) || !Number.isFinite(start)) return -1;
    furthest = Math.max(furthest, start + len);
  }
  return base + furthest + 1;
}

/** Read every record in a stream. */
export function readIso2709(bytes: Uint8Array, opts: ReadOptions = {}): ParsedRecord[] {
  return splitIso2709(bytes).map((r) => readIso2709Record(r, opts));
}

/**
 * Read one record. The slice may or may not include its record terminator.
 *
 * Throws only when there is nothing to read — a buffer shorter than a leader.
 * Everything else is an anomaly on a record that is still returned, because a
 * catalogue is imported once and a refused record is a book nobody can find.
 */
export function readIso2709Record(input: Uint8Array, opts: ReadOptions = {}): ParsedRecord {
  const anomalies: MarcAnomaly[] = [];
  const add = (a: MarcAnomaly) => anomalies.push(a);

  let bytes = input;
  if (bytes.length && bytes[bytes.length - 1] === RECORD_TERMINATOR) {
    bytes = bytes.subarray(0, bytes.length - 1);
  } else {
    add({ code: ANOMALY.missingRecordTerminator });
  }
  if (bytes.length < 24) {
    throw new MarcError(
      'record-too-short',
      `A MARC record must be at least 24 bytes; got ${bytes.length}.`,
    );
  }

  const leader = decodeLatin1(bytes, 0, 24);
  const declaredLength = readUint(bytes, LEADER.recordLength[0], 5).value;
  if (Number.isFinite(declaredLength) && declaredLength !== input.length) {
    add({ code: ANOMALY.leaderLengthWrong, at: 0, saw: leader.slice(0, 5) });
  }

  const { map, standard } = readEntryMap(leader);
  if (!standard) {
    add({ code: ANOMALY.nonStandardEntryMap, at: 20, saw: leaderAt(leader, 'entryMap') });
  }

  // Leader/10 and /11 are honoured on read for the same reason as the entry map.
  // /11 counts the DELIMITER plus the code, so a code is (/11 - 1) characters.
  const indicatorCount = digitAt(leader, LEADER.indicatorCount[0], 2);
  const subfieldCodeCount = digitAt(leader, LEADER.subfieldCodeCount[0], 2);
  if (indicatorCount !== 2 || subfieldCodeCount !== 2) {
    add({ code: ANOMALY.nonStandardCounts, at: 10, saw: leader.slice(10, 12) });
  }
  const codeWidth = Math.max(1, subfieldCodeCount - 1);

  // The base address says where the data starts; the directory is everything
  // between the leader and it, minus the terminator. When the leader is wrong,
  // the first field terminator after byte 24 is the better authority.
  const declaredBase = readUint(bytes, LEADER.baseAddress[0], 5).value;
  let firstTerminator = -1;
  for (let i = 24; i < bytes.length; i++) {
    if (bytes[i] === FIELD_TERMINATOR) {
      firstTerminator = i;
      break;
    }
  }
  let baseAddress: number;
  if (Number.isFinite(declaredBase) && declaredBase >= 24 && declaredBase <= bytes.length) {
    baseAddress = declaredBase;
    if (firstTerminator >= 0 && firstTerminator + 1 !== declaredBase) {
      add({ code: ANOMALY.baseAddressWrong, at: 12, saw: leader.slice(12, 17) });
    }
  } else {
    add({ code: ANOMALY.baseAddressWrong, at: 12, saw: leader.slice(12, 17) });
    baseAddress = firstTerminator >= 0 ? firstTerminator + 1 : bytes.length;
  }

  let directoryEnd = Math.max(baseAddress - 1, 24);
  if (bytes[directoryEnd] !== FIELD_TERMINATOR) {
    add({ code: ANOMALY.missingDirectoryTerminator, at: directoryEnd });
    if (firstTerminator >= 0 && firstTerminator < baseAddress) directoryEnd = firstTerminator;
  }

  const width = entryWidth(map);
  const dirBytes = Math.max(directoryEnd - 24, 0);
  const count = Math.floor(dirBytes / width);
  if (dirBytes % width !== 0) {
    add({ code: ANOMALY.directoryLengthRagged, at: 24, saw: String(dirBytes) });
  }

  const fields: MarcField[] = [];
  const seen = new Map<string, number>();
  let previousStart = -1;

  for (let e = 0; e < count; e++) {
    const entry = 24 + e * width;
    const tag = decodeLatin1(bytes, entry, entry + map.tagWidth);
    const occurrence = (seen.get(tag) ?? 0) + 1;
    seen.set(tag, occurrence);
    const here = { tag, occurrence };

    if (!/^[!-~]{3}$/.test(tag)) {
      add({ code: ANOMALY.tagMalformed, ...here, at: entry, saw: tag });
    }

    const lenRead = readUint(bytes, entry + map.tagWidth, map.fieldLengthWidth);
    const startRead = readUint(
      bytes,
      entry + map.tagWidth + map.fieldLengthWidth,
      map.startPositionWidth,
    );
    if (!Number.isFinite(lenRead.value) || !Number.isFinite(startRead.value)) {
      add({ code: ANOMALY.directoryEntryNotNumeric, ...here, at: entry });
      continue;
    }
    if (startRead.value < previousStart) add({ code: ANOMALY.fieldsOutOfOrder, ...here });
    previousStart = startRead.value;

    let from = baseAddress + startRead.value;
    let to = from + lenRead.value;
    if (from > bytes.length || to > bytes.length) {
      add({ code: ANOMALY.directoryEntryOutOfRange, ...here, at: from });
      from = Math.min(from, bytes.length);
      to = Math.min(to, bytes.length);
    }
    if (to > from && bytes[to - 1] === FIELD_TERMINATOR) {
      to -= 1;
    } else {
      add({ code: ANOMALY.missingFieldTerminator, ...here, at: to });
    }

    // One MARC-8 state per FIELD: escape designations are field-scoped, so the
    // state is shared across this field's subfields and discarded here.
    fields.push(readField(bytes, from, to, tag, codeWidth, leader, opts, add, here));
  }

  return { record: { leader, fields }, anomalies };
}

function digitAt(leader: string, index: number, fallback: number): number {
  const c = leader.charCodeAt(index) - 48;
  return c >= 0 && c <= 9 ? c : fallback;
}

type Where = { tag: string; occurrence: number };

function readField(
  bytes: Uint8Array,
  from: number,
  to: number,
  tag: string,
  codeWidth: number,
  leader: string,
  opts: ReadOptions,
  add: (a: MarcAnomaly) => void,
  here: Where,
): MarcField {
  const x: string[] = [];
  const note = (code: AnomalyCode, extra?: Partial<MarcAnomaly>) => {
    if (!x.includes(code)) x.push(code);
    add({ code, ...here, ...extra });
  };
  // Designations are field-scoped, so one state serves every subfield of this
  // field and is discarded with it. Structure — the delimiter and the code byte
  // — is excised BEFORE the state machine sees it: the code byte `a` is 0x61,
  // inside G0's invocation range, so a decoder run over the raw field buffer
  // would translate every subfield code into whatever G0 currently designates.
  const state: Marc8State = newMarc8State();
  const decode = (a: number, b: number): string =>
    decodeFieldData(bytes, a, b, leader, opts, note, state);

  if (isControlTag(tag)) {
    for (let i = from; i < to; i++) {
      if (bytes[i] === SUBFIELD_DELIMITER) {
        note(ANOMALY.controlFieldHasSubfields);
        break;
      }
    }
    const v = decode(from, to);
    return x.length ? { t: tag, v, x } : { t: tag, v };
  }

  // A data field: indicator bytes, then delimiter-prefixed subfields.
  let cursor = from;
  let indicators: string;
  if (to === from) {
    note(ANOMALY.dataFieldHasNoSubfields);
    indicators = '  ';
  } else if (bytes[from] === SUBFIELD_DELIMITER) {
    // The field starts with a delimiter, so it carries no indicator bytes at
    // all — and the 1.0 reader's guard is precisely this case, which means it
    // consumed the first two bytes of the first subfield in every OTHER case.
    note(ANOMALY.dataFieldHasNoIndicators);
    indicators = '  ';
  } else {
    // Honour the declared indicator count, then normalise to the two bytes the
    // type promises and the writer always emits.
    const declared = digitAt(leader, LEADER.indicatorCount[0], 2);
    const take = Math.min(Math.max(declared, 0), to - from);
    indicators = decodeLatin1(bytes, from, from + take)
      .padEnd(2, ' ')
      .slice(0, 2);
    cursor = from + take;
  }

  const subfields: Subfield[] = [];
  let firstDelimiter = -1;
  for (let i = cursor; i < to; i++) {
    if (bytes[i] === SUBFIELD_DELIMITER) {
      firstDelimiter = i;
      break;
    }
  }
  if (firstDelimiter < 0) {
    if (to > cursor) note(ANOMALY.dataBeforeFirstSubfield, { saw: decode(cursor, to) });
    else if (to > from) note(ANOMALY.dataFieldHasNoSubfields);
    return { t: tag, i: indicators, s: subfields, ...(x.length ? { x } : {}) };
  }
  if (firstDelimiter > cursor) {
    // Bytes before the first subfield have nowhere to live: the stored shape has
    // no slot for them, and inventing a subfield code would fabricate data. They
    // survive verbatim in `marc_record_contents.source_blob`, which is what that
    // column is for, and the anomaly names the field.
    note(ANOMALY.dataBeforeFirstSubfield, { saw: decode(cursor, firstDelimiter) });
  }

  let i = firstDelimiter;
  while (i < to) {
    const codeFrom = i + 1;
    const codeTo = codeFrom + codeWidth;
    if (codeTo > to) {
      note(ANOMALY.subfieldCodeTruncated, { at: i });
      break;
    }
    const code = decodeLatin1(bytes, codeFrom, codeTo);
    let next = to;
    for (let j = codeTo; j < to; j++) {
      if (bytes[j] === SUBFIELD_DELIMITER) {
        next = j;
        break;
      }
    }
    subfields.push({ [code]: decode(codeTo, next) });
    i = next;
  }
  if (!subfields.length) note(ANOMALY.dataFieldHasNoSubfields);

  return { t: tag, i: indicators, s: subfields, ...(x.length ? { x } : {}) };
}

function decodeFieldData(
  bytes: Uint8Array,
  from: number,
  to: number,
  leader: string,
  opts: ReadOptions,
  note: (code: AnomalyCode) => void,
  state: Marc8State,
): string {
  const scheme = opts.encoding ?? 'auto';
  const unicode =
    scheme === 'auto' ? leaderAt(leader, 'characterCodingScheme') === 'a' : scheme === 'utf-8';
  if (unicode) {
    const { text, valid } = decodeUtf8(bytes, from, to);
    if (!valid) note(ANOMALY.invalidUtf8);
    return text;
  }
  // `state` was created by the caller for THIS field and dies with it. That is
  // the rule, not an optimisation: MARC-8 escape state does not survive a field
  // terminator, so a Greek 245 followed by a Latin 260 decodes correctly only if
  // the 260 begins clean.
  const result = decodeMarc8(bytes.subarray(from, to), state);
  for (const code of result.anomalies) note(code);
  return result.text;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Serialize a record to ISO 2709.
 *
 * Throws rather than truncating when a record or a field cannot be addressed by
 * the format. A silently truncated MARC record is a catalogue entry that looks
 * fine and has lost its last fields; the caller's answer is MARCXML, and the
 * error says so.
 */
export function writeIso2709(record: MarcRecord, opts: WriteOptions = {}): Uint8Array {
  const encoding = opts.encoding ?? 'utf-8';
  const norm = opts.normalization;
  const text = (s: string): string =>
    norm === 'nfc' ? s.normalize('NFC') : norm === 'nfd' ? s.normalize('NFD') : s;
  const encode = (value: string, where: string): Uint8Array => {
    // A delimiter inside DATA is the one way this writer could produce a file
    // that reads back as a different record — and it did: a 0x1F in a subfield
    // value was emitted raw, and the reader then split one subfield into two,
    // with no anomaly on either side. The MARC-8 branch already refused these
    // bytes (`marc8-unencodable`); the UTF-8 branch was the only path that
    // corrupted. 0x1E and 0x1D survive THIS reader, because it slices by
    // directory length rather than scanning — but they split the field or the
    // record in `yaz-marcdump` and in every scanning reader, so all three are
    // refused rather than the one that is demonstrable in-house.
    for (const ch of value) {
      const code = ch.codePointAt(0) as number;
      if (code === SUBFIELD_DELIMITER || code === FIELD_TERMINATOR || code === RECORD_TERMINATOR) {
        throw new MarcError(
          'data-not-encodable',
          `${where} contains 0x${code.toString(16).toUpperCase()}, one of the three bytes that ` +
            'separate fields and subfields. Binary MARC cannot carry it inside a value; export ' +
            'this record as MARCXML.',
        );
      }
    }
    return encoding === 'utf-8' ? encodeUtf8(text(value)) : encodeMarc8(text(value));
  };

  const bodies: Uint8Array[] = [];
  const directory: string[] = [];
  let start = 0;

  for (const f of record.fields) {
    if (f.t.length !== 3) {
      throw new MarcError('tag-invalid', `A MARC tag must be three characters; got "${f.t}".`);
    }
    // The tag is structure too. Without this it escaped as a bare RangeError
    // from `encodeLatin1`, four frames down, while the indicators and the
    // subfield codes beside it produced a typed MarcError.
    assertStructural(f.t, `the tag "${f.t}"`);
    const chunks: Uint8Array[] = [];
    if ('v' in f) {
      chunks.push(encode(f.v, `control field ${f.t}`));
    } else {
      const df = f as DataField;
      const indicators = df.i.padEnd(2, ' ').slice(0, 2);
      // Indicators and subfield codes are STRUCTURE and must be single bytes.
      // A record read from a corrupt directory can carry anything here, and the
      // caller needs to be told which field rather than getting a RangeError
      // from four frames down.
      assertStructural(indicators, `the indicators of ${f.t}`);
      chunks.push(encodeLatin1(indicators));
      for (const sf of df.s) {
        const code = subfieldCode(sf);
        if (code.length !== 1) {
          throw new MarcError(
            'subfield-code-invalid',
            `A subfield code must be one character; ${f.t} has "${code}".`,
          );
        }
        assertStructural(code, `the subfield code of ${f.t}`);
        chunks.push(
          new Uint8Array([SUBFIELD_DELIMITER]),
          encodeLatin1(code),
          encode(subfieldValue(sf), `${f.t} $${code}`),
        );
      }
    }
    chunks.push(new Uint8Array([FIELD_TERMINATOR]));
    const body = concatBytes(chunks);
    if (body.length > MAX_FIELD_BYTES) {
      throw new MarcError(
        'field-too-long',
        `Field ${f.t} is ${body.length} bytes; binary MARC addresses at most ` +
          `${MAX_FIELD_BYTES}. Export this record as MARCXML.`,
      );
    }
    bodies.push(body);
    directory.push(`${f.t}${padUint(body.length, 4)}${padUint(start, 5)}`);
    start += body.length;
    if (start > MAX_RECORD_BYTES) {
      throw new MarcError(
        'record-too-long',
        'This record does not fit in binary MARC, whose 5-digit length field stops at ' +
          `${MAX_RECORD_BYTES} bytes. Export it as MARCXML.`,
      );
    }
  }

  const baseAddress = 24 + directory.length * entryWidth(DEFAULT_ENTRY_MAP) + 1;
  const total = baseAddress + start + 1;
  if (total > MAX_RECORD_BYTES) {
    throw new MarcError(
      'record-too-long',
      `This record is ${total} bytes and binary MARC addresses at most ` +
        `${MAX_RECORD_BYTES}. Export it as MARCXML.`,
    );
  }

  return concatBytes([
    encodeLatin1(writeLeader(record.leader, { total, baseAddress, encoding })),
    encodeLatin1(directory.join('')),
    new Uint8Array([FIELD_TERMINATOR]),
    ...bodies,
    new Uint8Array([RECORD_TERMINATOR]),
  ]);
}

/**
 * Structural bytes are single bytes. Anything above U+00FF in a tag, an
 * indicator or a subfield code means the record was read from a directory that
 * did not describe it, and writing it back would produce a file no reader can
 * open.
 */
function assertStructural(value: string, what: string): void {
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code > 0xff) {
      throw new MarcError(
        'structure-not-encodable',
        `${what} contains U+${code.toString(16).toUpperCase().padStart(4, '0')}, which is not a ` +
          'single byte. The record was almost certainly read from a damaged directory; its ' +
          'original bytes are in source_blob.',
      );
    }
  }
}

/**
 * The leader a writer emits: the cataloguer's positions kept, the derived ones
 * recomputed, the fixed ones forced.
 *
 * Exported because phase 10's write path and phase 11's export endpoints both
 * need to reason about a leader without serializing a whole record, and because
 * this rule is the single thing here most likely to be re-implemented elsewhere
 * by someone who read only the source record.
 */
export function writeLeader(
  source: string,
  {
    total,
    baseAddress,
    encoding,
  }: { total: number; baseAddress: number; encoding: Iso2709Encoding },
): string {
  const l = (source.length >= 24 ? source.slice(0, 24) : source.padEnd(24, ' ')).split('');
  // A leader position that arrived as a NUL, a control byte or nothing at all
  // becomes a space. A NUL here is one of the two things that makes a record
  // unreadable to yaz-marcdump; the other is a wrong base address.
  for (let i = 0; i < 24; i++) {
    const c = l[i];
    if (c === undefined || c < ' ' || c > '~') l[i] = ' ';
  }
  const put = (value: string, at: number) => {
    for (let i = 0; i < value.length; i++) l[at + i] = value[i] as string;
  };
  put(padUint(total, 5), LEADER.recordLength[0]);
  put(padUint(baseAddress, 5), LEADER.baseAddress[0]);
  // Set from the EXPORT, never copied from the source: a UTF-8 record emitted
  // with a blank /09 is mojibake at the far end.
  put(encoding === 'utf-8' ? 'a' : ' ', LEADER.characterCodingScheme[0]);
  put(LEADER_FIXED.indicatorCount, LEADER.indicatorCount[0]);
  put(LEADER_FIXED.subfieldCodeCount, LEADER.subfieldCodeCount[0]);
  put(LEADER_FIXED.entryMap, LEADER.entryMap[0]);
  return l.join('');
}

/** The entry map a writer always uses. Exported so a test can assert the rule. */
export const WRITER_ENTRY_MAP: EntryMap = DEFAULT_ENTRY_MAP;
