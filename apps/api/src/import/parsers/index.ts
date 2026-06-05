/**
 * Public entry point for the parsing layer: one function that turns raw
 * bytes + a declared format into the common `ParsedTable`, plus a best-effort
 * format detector for the upload step.
 */
import { parseDelimited } from './csv-parser.js';
import { parseMarc } from './marc-parser.js';
import { parseXlsx } from './xlsx-parser.js';
import type { ParsedTable, ParseOptions, SourceFormat } from './types.js';

export * from './types.js';
export { parseDelimited } from './csv-parser.js';
export { parseXlsx } from './xlsx-parser.js';
export { parseMarc } from './marc-parser.js';
export { decodeBuffer } from './encoding.js';

export async function parseByFormat(
  format: SourceFormat,
  data: Buffer,
  opts: ParseOptions = {},
): Promise<ParsedTable> {
  switch (format) {
    case 'csv':
      // Delimiter auto-detected unless forced (a "csv" can be semicolon-
      // delimited — common in Greek Excel exports).
      return parseDelimited(data, opts);
    case 'tsv':
      return parseDelimited(data, { ...opts, delimiter: opts.delimiter ?? '\t' });
    case 'xlsx':
      return parseXlsx(data, opts);
    case 'marc':
    case 'marcxml':
      return parseMarc(data, opts);
  }
}

/** Skip leading whitespace + a UTF-8 BOM, return the first meaningful byte. */
function firstMeaningfulByte(data: Buffer): number {
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
  return data[i] ?? 0;
}

/**
 * Guess the format from the filename extension first, then content. Used to
 * pre-select the format on upload; the librarian can always override it.
 */
export function detectFormat(filename: string, data: Buffer): SourceFormat {
  const ext = (filename.toLowerCase().split('.').pop() ?? '').trim();
  // XLSX is a ZIP container — magic bytes "PK\x03\x04".
  if (ext === 'xlsx' || (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b)) return 'xlsx';
  if (ext === 'marcxml') return 'marcxml';
  if (ext === 'mrc' || ext === 'marc') return 'marc';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';

  const first = firstMeaningfulByte(data);
  if (first === 0x3c) {
    // '<' → XML. Could be MARCXML or some other XML; we only read MARCXML.
    return 'marcxml';
  }
  // ISO 2709 binary leader: first five bytes are ASCII digits (record length).
  if (
    ext === '' &&
    data.length >= 24 &&
    data[0]! >= 0x30 &&
    data[0]! <= 0x39 &&
    data[4]! >= 0x30 &&
    data[4]! <= 0x39
  ) {
    return 'marc';
  }
  if (ext === 'csv') return 'csv';
  return 'csv';
}
