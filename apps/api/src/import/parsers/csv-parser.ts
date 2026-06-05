/**
 * RFC 4180 delimited-text parser (CSV / TSV / semicolon / pipe), with the
 * real-world tolerances legacy ILS exports demand:
 *
 *   - Quoted fields with embedded delimiters, CRLF/LF/CR newlines, and the
 *     `""` escape for a literal quote inside a quoted field.
 *   - Auto delimiter detection (`,` `;` `\t` `|`) from the header line,
 *     overridable by the caller.
 *   - Mixed/short rows: missing trailing cells are padded with ''; extra
 *     cells beyond the header are preserved under synthesized names so no
 *     data is silently dropped.
 *   - Duplicate header labels are disambiguated (`isbn`, `isbn_2`, …).
 *   - Fully-blank lines are skipped (common trailing-newline noise).
 *
 * Input is an already-decoded string (see `encoding.ts`). The parser is
 * pure and synchronous.
 */
import { decodeBuffer } from './encoding.js';
import { buildTableFromMatrix, isBlankRow } from './tabular.js';
import { ParseError, type ParsedTable, type ParseOptions } from './types.js';

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Split decoded text into a matrix of raw string cells. A single pass over
 * the characters; handles quotes + embedded newlines correctly.
 */
function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      sawAnyChar = true;
      continue;
    }
    if (ch === '\r') {
      // Treat CRLF and lone CR as one row break.
      if (text[i + 1] === '\n') i++;
      pushRow();
      sawAnyChar = false;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }
  // Flush the final field/row unless the file ended exactly on a newline.
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

/** Count delimiter occurrences in `line`, ignoring those inside quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      n++;
    }
  }
  return n;
}

/** Pick the delimiter that appears most often on the first non-empty line. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/).find((l) => l.trim().length > 0) ?? '';
  let best = ',';
  let bestCount = -1;
  for (const d of CANDIDATE_DELIMITERS) {
    const c = countOutsideQuotes(firstLine, d);
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

export function parseDelimited(data: Buffer, opts: ParseOptions = {}): ParsedTable {
  const { text, encoding } = decodeBuffer(data, opts.encoding);
  if (text.trim().length === 0) {
    throw new ParseError('The file is empty.');
  }
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const matrix = tokenize(text, delimiter);
  if (matrix.every(isBlankRow)) {
    throw new ParseError('No rows found in the file.');
  }
  return buildTableFromMatrix(
    matrix,
    {
      format: delimiter === '\t' ? 'tsv' : 'csv',
      encoding,
      delimiter,
    },
    opts,
  );
}
