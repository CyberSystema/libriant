import {
  MarcError,
  isDataField,
  subfieldCode,
  subfieldValue,
  type MarcField,
  type MarcRecord,
  type Subfield,
} from './types.js';

/**
 * MARC-in-JSON — Ross Singer's convention — read and written.
 *
 * ## Two JSON shapes, on purpose
 *
 * The shape this platform STORES is the compact one in `types.ts`: `{t, v}` and
 * `{t, i, s}`. Single-character keys, because at five million records the key
 * names are around 15 % of the JSONB.
 *
 * The shape the WORLD exchanges is Singer's:
 *
 * ```json
 * { "leader": "01234nam a2200289 a 4500",
 *   "fields": [ { "001": "12345" },
 *               { "245": { "ind1": "1", "ind2": "0",
 *                          "subfields": [ { "a": "Zorba /" } ] } } ] }
 * ```
 *
 * Every MARC tool that speaks JSON speaks that one, so `GET /catalog/bib/:id.json`
 * (phase 11) must emit it and an import must accept it. The two shapes carry the
 * same information and the conversion is total in both directions.
 *
 * ## What the conversion has to be careful about
 *
 * Singer's `fields` is an array of SINGLE-KEY objects, exactly like the compact
 * `s` array, and for the same reason: a record has repeated fields, and a map
 * from tag to field would keep only the last 650 of five. A converter that
 * builds `Object.fromEntries` anywhere has already lost the record.
 *
 * `ind1`/`ind2` are separate one-character strings there and one two-character
 * string here. A blank indicator is a SPACE in both; `""` is not a legal
 * indicator and is repaired to a space with no ceremony, because every exporter
 * that emits it means a blank.
 */

export type MarcJsonSubfield = { readonly [code: string]: string };

export type MarcJsonDataField = {
  readonly ind1: string;
  readonly ind2: string;
  readonly subfields: readonly MarcJsonSubfield[];
};

export type MarcJsonField = { readonly [tag: string]: string | MarcJsonDataField };

export type MarcJsonRecord = {
  readonly leader: string;
  readonly fields: readonly MarcJsonField[];
};

function onlyKey(o: object, what: string): string {
  const keys = Object.keys(o);
  if (keys.length !== 1) {
    throw new MarcError(
      'marc-json-shape',
      `A MARC-in-JSON ${what} is an object with exactly one key; this one has ${keys.length}. ` +
        'That shape is what preserves repeated fields, so a record with two 650s is not ' +
        'recoverable from the collapsed form.',
    );
  }
  return keys[0] as string;
}

/** Convert a stored record to the exchange shape. */
export function toMarcJson(record: MarcRecord): MarcJsonRecord {
  const fields: MarcJsonField[] = record.fields.map((f) => {
    if (!isDataField(f)) return { [f.t]: f.v };
    const indicators = f.i.padEnd(2, ' ');
    return {
      [f.t]: {
        ind1: indicators[0] as string,
        ind2: indicators[1] as string,
        subfields: f.s.map((s) => ({ [subfieldCode(s)]: subfieldValue(s) })),
      },
    };
  });
  return { leader: record.leader, fields };
}

/** Convert the exchange shape to a stored record. */
export function fromMarcJson(input: unknown): MarcRecord {
  if (!input || typeof input !== 'object') {
    throw new MarcError('marc-json-shape', 'A MARC-in-JSON record is a JSON object.');
  }
  const record = input as { leader?: unknown; fields?: unknown };
  if (typeof record.leader !== 'string') {
    throw new MarcError('marc-json-shape', 'A MARC-in-JSON record needs a "leader" string.');
  }
  // A leader is 24 characters. Repaired at the boundary the way the ISO 2709 and
  // MARCXML readers repair it, rather than left to surface later as eleven
  // phantom leader changes on the record's first save.
  const leader = record.leader.padEnd(24, ' ').slice(0, 24);
  if (!Array.isArray(record.fields)) {
    throw new MarcError('marc-json-shape', 'A MARC-in-JSON record needs a "fields" array.');
  }

  const fields: MarcField[] = record.fields.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new MarcError('marc-json-shape', 'Every entry in "fields" is an object.');
    }
    const tag = onlyKey(raw as object, 'field');
    const body = (raw as Record<string, unknown>)[tag];
    if (typeof body === 'string') return { t: tag, v: body };
    if (!body || typeof body !== 'object') {
      throw new MarcError('marc-json-shape', `Field ${tag} is neither a string nor an object.`);
    }
    const df = body as { ind1?: unknown; ind2?: unknown; subfields?: unknown };
    // An indicator longer than one character is data loss. `fromMarcJson`
    // returns a bare record rather than a ParsedRecord, so it refuses instead of
    // reporting — a caller handing this function a two-character `ind1` has a
    // bug, and silently keeping half of it would hide it.
    const ind = (v: unknown, which: string): string => {
      if (typeof v !== 'string' || !v.length) return ' ';
      if (v.length > 1) {
        throw new MarcError(
          'marc-json-shape',
          `${tag} ${which} is ${JSON.stringify(v)}; an indicator is one character.`,
        );
      }
      return v[0] as string;
    };
    if (!Array.isArray(df.subfields)) {
      throw new MarcError('marc-json-shape', `Field ${tag} needs a "subfields" array.`);
    }
    const s: Subfield[] = df.subfields.map((sf) => {
      if (!sf || typeof sf !== 'object') {
        throw new MarcError('marc-json-shape', `A subfield of ${tag} is not an object.`);
      }
      const code = onlyKey(sf as object, 'subfield');
      const value = (sf as Record<string, unknown>)[code];
      if (typeof value === 'string') return { [code]: value };
      // A number or a boolean is what a JSON encoder produces from a control
      // number like 12345 or a flag; converting those is a kindness. Anything
      // else — null, an array, an object — is a shape error, and `String()` on
      // it would import the text "[object Object]" as a title.
      if (typeof value === 'number' || typeof value === 'boolean') return { [code]: String(value) };
      throw new MarcError(
        'marc-json-shape',
        `${tag} $${code} is ${value === null ? 'null' : typeof value}; a subfield value is text.`,
      );
    });
    return { t: tag, i: `${ind(df.ind1, 'ind1')}${ind(df.ind2, 'ind2')}`, s };
  });

  return { leader, fields };
}

/** The exchange shape as text. Pretty by default: these are read by people. */
export function writeMarcJson(record: MarcRecord, opts: { pretty?: boolean } = {}): string {
  return JSON.stringify(toMarcJson(record), null, opts.pretty === false ? 0 : 2);
}

/** Parse the exchange shape from text. */
export function readMarcJson(text: string): MarcRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MarcError('marc-json-invalid', `That is not JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return fromMarcJson(parsed);
}
