/**
 * MARC reader — both flavors libraries actually export:
 *
 *   - MARC21 / ISO 2709 binary (.mrc): leader + directory + fields, with the
 *     0x1F/0x1E/0x1D delimiter trio. Field SLICING is done on BYTES (offsets
 *     in the leader are byte counts) and each field's content is then decoded
 *     as UTF-8, so multi-byte Greek/diacritics survive intact.
 *   - MARCXML (.xml): parsed with fast-xml-parser, namespace-stripped.
 *
 * Both flavors reduce to the same flat, tabular view: each record becomes a
 * row whose columns are `tag` (control fields like 001/008) and `tag$code`
 * (data subfields like `245$a`, `020$a`). Repeated subfields/fields are
 * joined with ' | '. The mapping layer's MARC-aware aliases then turn those
 * columns into book fields.
 *
 * Note: MARC-8 legacy encoding is not transcoded — modern exports are UTF-8
 * (leader position 9 = 'a'). A MARC-8 file still parses structurally; only
 * its extended characters may be off, and the librarian can re-export as
 * UTF-8 or use the CSV path.
 */
import { XMLParser } from 'fast-xml-parser';
import { IMPORT_MAX_COLUMNS } from '../import.constants.js';
import { decodeBuffer } from './encoding.js';
import {
  ParseError,
  type ParsedColumn,
  type ParsedTable,
  type ParseOptions,
  type RawRow,
} from './types.js';

const FT = 0x1e; // field terminator
const SF = 0x1f; // subfield delimiter
const RT = 0x1d; // record terminator
const JOIN = ' | ';

type FlatRecord = Record<string, string>;

function setKey(rec: FlatRecord, key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  rec[key] = rec[key] ? `${rec[key]}${JOIN}${v}` : v;
}

function isControlTag(tag: string): boolean {
  return /^00[0-9]$/.test(tag);
}

// ---------------------------------------------------------------------------
// Binary ISO 2709
// ---------------------------------------------------------------------------

function splitBinaryRecords(buf: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === RT) {
      records.push(buf.subarray(start, i)); // exclude the RT itself
      start = i + 1;
    }
  }
  // A trailing record with no terminator (some exporters omit the last RT).
  if (start < buf.length) {
    const tail = buf.subarray(start);
    if (tail.length > 24) records.push(tail);
  }
  return records;
}

function parseBinaryRecord(rec: Buffer): FlatRecord | null {
  if (rec.length < 24) return null;
  const leader = rec.toString('latin1', 0, 24);
  const baseAddress = Number.parseInt(leader.slice(12, 17), 10);
  if (!Number.isFinite(baseAddress) || baseAddress < 24 || baseAddress > rec.length) return null;

  // Directory: from byte 24 to baseAddress, minus its trailing FT.
  let dirEnd = baseAddress - 1;
  if (rec[dirEnd] !== FT) dirEnd = baseAddress; // tolerate a missing terminator
  const dir = rec.toString('latin1', 24, dirEnd);
  const out: FlatRecord = {};

  for (let p = 0; p + 12 <= dir.length; p += 12) {
    const tag = dir.slice(p, p + 3);
    const len = Number.parseInt(dir.slice(p + 3, p + 7), 10);
    const startPos = Number.parseInt(dir.slice(p + 7, p + 12), 10);
    if (!Number.isFinite(len) || !Number.isFinite(startPos)) continue;
    const fieldStart = baseAddress + startPos;
    let fieldEnd = fieldStart + len;
    if (fieldEnd > rec.length) fieldEnd = rec.length;
    // Drop a trailing field terminator if present.
    if (fieldEnd > fieldStart && rec[fieldEnd - 1] === FT) fieldEnd -= 1;
    const fieldBuf = rec.subarray(fieldStart, fieldEnd);

    if (isControlTag(tag)) {
      setKey(out, tag, fieldBuf.toString('utf-8'));
      continue;
    }
    // Data field: 2 indicator bytes, then 0x1F-prefixed subfields.
    let i = 0;
    // Skip the two indicator bytes if present.
    if (fieldBuf.length >= 2 && fieldBuf[0] !== SF) i = 2;
    let subStart = -1;
    let subCode = '';
    const flush = (end: number) => {
      if (subStart >= 0) {
        setKey(out, `${tag}$${subCode}`, fieldBuf.toString('utf-8', subStart, end));
      }
    };
    for (; i < fieldBuf.length; i++) {
      if (fieldBuf[i] === SF) {
        flush(i);
        subCode = String.fromCharCode(fieldBuf[i + 1] ?? 0);
        subStart = i + 2;
        i += 1;
      }
    }
    flush(fieldBuf.length);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// MARCXML
// ---------------------------------------------------------------------------

function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    if (t !== undefined) return typeof t === 'string' ? t : String(t);
  }
  return '';
}

function parseXmlRecords(text: string): FlatRecord[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(`Couldn't parse the MARCXML: ${(err as Error).message}`);
  }
  const collection = (doc.collection ?? doc) as Record<string, unknown>;
  const recordsRaw = toArray(collection.record ?? (doc.record as unknown));
  const records: FlatRecord[] = [];
  for (const r of recordsRaw) {
    const rec = r as Record<string, unknown>;
    const out: FlatRecord = {};
    for (const cf of toArray(rec.controlfield)) {
      const node = cf as Record<string, unknown>;
      const tag = String(node['@_tag'] ?? '').trim();
      if (tag) setKey(out, tag, textOf(node));
    }
    for (const df of toArray(rec.datafield)) {
      const node = df as Record<string, unknown>;
      const tag = String(node['@_tag'] ?? '').trim();
      if (!tag) continue;
      for (const sf of toArray(node.subfield)) {
        const sub = sf as Record<string, unknown>;
        const code = String(sub['@_code'] ?? '').trim();
        if (code) setKey(out, `${tag}$${code}`, textOf(sub));
      }
    }
    if (Object.keys(out).length) records.push(out);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function recordsToTable(
  records: FlatRecord[],
  format: 'marc' | 'marcxml',
  encoding: string | undefined,
  opts: ParseOptions,
): ParsedTable {
  if (records.length === 0) throw new ParseError('No MARC records were found in the file.');
  // Union of keys, in first-appearance order.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  // A8-02: cap the synthesized column union — a crafted MARC file with millions
  // of distinct tag$code keys would otherwise amplify into multi-GB of objects.
  if (order.length > IMPORT_MAX_COLUMNS) {
    throw new ParseError(
      `The MARC file produces ${order.length} columns, more than the ` +
        `${IMPORT_MAX_COLUMNS}-column import limit.`,
    );
  }
  const columns: ParsedColumn[] = order.map((name, index) => ({ index, name }));

  const rows: RawRow[] = [];
  let truncated = false;
  for (let i = 0; i < records.length; i++) {
    if (opts.maxRows && rows.length >= opts.maxRows) {
      truncated = true;
      break;
    }
    const rec = records[i]!;
    const cells: Record<string, string> = {};
    for (const key of order) cells[key] = rec[key] ?? '';
    rows.push({ rowNumber: i + 1, cells });
  }

  return { columns, rows, truncated, meta: { format, encoding } };
}

/** Auto-detecting MARC reader (binary vs XML). */
export function parseMarc(data: Buffer, opts: ParseOptions = {}): ParsedTable {
  // Find the first non-whitespace byte to decide XML vs binary.
  let i = 0;
  while (
    i < data.length &&
    (data[i] === 0x20 ||
      data[i] === 0x09 ||
      data[i] === 0x0a ||
      data[i] === 0x0d ||
      data[i] === 0xef ||
      data[i] === 0xbb ||
      data[i] === 0xbf)
  ) {
    i++;
  }
  const isXml = data[i] === 0x3c; // '<'
  if (isXml) {
    const { text, encoding } = decodeBuffer(data, opts.encoding);
    return recordsToTable(parseXmlRecords(text), 'marcxml', encoding, opts);
  }
  const records: FlatRecord[] = [];
  for (const rec of splitBinaryRecords(data)) {
    const parsed = parseBinaryRecord(rec);
    if (parsed) records.push(parsed);
  }
  return recordsToTable(records, 'marc', 'utf-8', opts);
}
