/**
 * Shared "matrix → ParsedTable" assembly used by every delimited/spreadsheet
 * parser. Centralizes the fiddly bits — header de-duplication, blank-row
 * skipping, short/overflow-row handling, continuous row numbering, and the
 * `maxRows` cap — so CSV, XLSX and MARC all behave identically downstream.
 */
import type { ParsedColumn, ParsedTable, ParseOptions, RawRow } from './types.js';

/** Make header labels unique + non-empty so cells can be keyed by name. */
export function normalizeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((label, idx) => {
    let base = (label ?? '').trim();
    if (!base) base = `column_${idx + 1}`;
    const prior = seen.get(base);
    if (prior === undefined) {
      seen.set(base, 1);
      return base;
    }
    const next = prior + 1;
    seen.set(base, next);
    return `${base}_${next}`;
  });
}

export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((c) => (c ?? '').trim().length === 0);
}

/**
 * Assemble a ParsedTable from a raw string matrix. `matrix[0]` is the header
 * unless `opts.noHeader` is set, in which case columns are synthesized.
 */
export function buildTableFromMatrix(
  matrix: string[][],
  meta: ParsedTable['meta'],
  opts: ParseOptions = {},
): ParsedTable {
  const work = matrix.slice();
  // Drop leading blank lines (BOM-only / preamble) before the header.
  while (work.length && isBlankRow(work[0]!)) work.shift();
  if (work.length === 0) {
    return { columns: [], rows: [], truncated: false, meta };
  }

  const headerCells = opts.noHeader
    ? work[0]!.map((_, i) => `column_${i + 1}`)
    : normalizeHeaders(work[0]!);
  const dataStart = opts.noHeader ? 0 : 1;

  // Rows can carry more cells than the header; synthesize names for the
  // overflow so values survive into the mapping step.
  let widest = headerCells.length;
  for (let r = dataStart; r < work.length; r++) {
    if (work[r]!.length > widest) widest = work[r]!.length;
  }
  const columns: ParsedColumn[] = Array.from({ length: widest }, (_, i) => ({
    index: i,
    name: headerCells[i] ?? `column_${i + 1}`,
  }));

  const rows: RawRow[] = [];
  let truncated = false;
  let rowNumber = 0;
  for (let r = dataStart; r < work.length; r++) {
    const cellsArr = work[r]!;
    if (isBlankRow(cellsArr)) continue;
    rowNumber++;
    if (opts.maxRows && rows.length >= opts.maxRows) {
      truncated = true;
      break;
    }
    const cells: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      cells[columns[c]!.name] = cellsArr[c] ?? '';
    }
    rows.push({ rowNumber, cells });
  }

  return { columns, rows, truncated, meta };
}
