/**
 * Excel (.xlsx) reader built on exceljs. Reads one worksheet (the first, or
 * a named one) into the common `ParsedTable` shape, coercing every cell —
 * numbers, dates, booleans, formulas, rich text, hyperlinks — to a string so
 * the mapping + transform layer sees a uniform tabular view.
 */
import ExcelJS from 'exceljs';
import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS } from '../import.constants.js';
import { buildTableFromMatrix } from './tabular.js';
import { ParseError, type ParsedTable, type ParseOptions } from './types.js';

/** Coerce any exceljs cell value to a plain string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    // Date-only cells arrive at UTC midnight → emit YYYY-MM-DD; otherwise ISO.
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return cellToString(v.result); // formula → computed value
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: unknown }>).map((r) => cellToString(r?.text)).join('');
    }
    if ('text' in v) return cellToString(v.text); // hyperlink display text
    if ('hyperlink' in v) return cellToString(v.hyperlink);
    if ('error' in v) return String(v.error);
  }
  return String(value);
}

export async function parseXlsx(data: Buffer, opts: ParseOptions = {}): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  try {
    // Pass an ArrayBuffer slice rather than the Node Buffer: exceljs's bundled
    // typings predate the Node 24 `Buffer<ArrayBufferLike>` generic, and JSZip
    // (exceljs's unzip) accepts ArrayBuffer just as happily.
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await wb.xlsx.load(ab);
  } catch (err) {
    throw new ParseError(`Couldn't read the Excel file: ${(err as Error).message}`);
  }
  const sheets = wb.worksheets;
  if (!sheets.length) throw new ParseError('The workbook has no worksheets.');
  const ws = opts.sheetName ? wb.getWorksheet(opts.sheetName) : sheets[0];
  if (!ws) throw new ParseError(`Worksheet "${opts.sheetName}" was not found in the workbook.`);

  const colCount = ws.actualColumnCount || ws.columnCount || 0;
  if (colCount === 0) throw new ParseError('The worksheet is empty.');

  // Reject pathological dimensions BEFORE materializing the matrix. xlsx is a
  // zip, so a small upload can expand to a sheet with millions of rows/columns
  // — building the full string matrix would OOM the worker. exceljs has already
  // parsed the model by here, but bailing now still avoids the (much larger)
  // string-matrix + parsed-row allocations stacked on top. The worker enforces
  // IMPORT_MAX_ROWS again on the assembled table as defence-in-depth.
  if (colCount > IMPORT_MAX_COLUMNS) {
    throw new ParseError(
      `The worksheet has ${colCount} columns, more than the ${IMPORT_MAX_COLUMNS}-column import limit.`,
    );
  }
  const rowCount = ws.actualRowCount || ws.rowCount || 0;
  if (rowCount > IMPORT_MAX_ROWS + 1) {
    throw new ParseError(
      `The worksheet has ${rowCount.toLocaleString()} rows, more than the ` +
        `${IMPORT_MAX_ROWS.toLocaleString()}-row import limit. Split it into smaller files.`,
    );
  }

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      cells.push(cellToString(row.getCell(c).value));
    }
    matrix.push(cells);
  });
  if (matrix.length === 0) throw new ParseError('The worksheet has no rows.');

  return buildTableFromMatrix(
    matrix,
    { format: 'xlsx', sheetName: ws.name, availableSheets: sheets.map((s) => s.name) },
    opts,
  );
}
