/**
 * Common shape every import parser emits.
 *
 * A migration file — whatever its on-disk format (CSV, Excel, MARC) — is
 * reduced to the same tabular view: a list of named columns plus a list of
 * rows whose cells are addressed by column name. The mapping layer
 * (`import/mapping`) then translates those source columns into Libriant
 * entity fields, so nothing downstream of the parser cares about the
 * original format.
 */

export type SourceFormat = 'csv' | 'tsv' | 'xlsx' | 'marc' | 'marcxml';

export type ParsedColumn = {
  /** 0-based position in the source. */
  index: number;
  /** Header label (CSV/XLSX header cell, or a `tag$code` for MARC). */
  name: string;
};

export type RawRow = {
  /** 1-based source row number, header excluded. Used in error reports. */
  rowNumber: number;
  /** Cell values keyed by column name. Always strings (already decoded). */
  cells: Record<string, string>;
};

export type ParsedTable = {
  columns: ParsedColumn[];
  rows: RawRow[];
  /** True when parsing stopped early because `maxRows` was reached. */
  truncated: boolean;
  meta: {
    format: SourceFormat;
    /** Detected/declared character encoding (CSV/MARC binary). */
    encoding?: string;
    /** Field delimiter actually used (CSV/TSV). */
    delimiter?: string;
    /** Worksheet read (XLSX). */
    sheetName?: string;
    /** Worksheet names available (XLSX) — surfaced so the UI can offer a pick. */
    availableSheets?: string[];
  };
};

export type ParseOptions = {
  /** Stop after this many DATA rows (header excluded). 0/undefined = no cap. */
  maxRows?: number;
  /** Force a delimiter for CSV/TSV instead of auto-detecting. */
  delimiter?: string;
  /** Force a character encoding instead of auto-detecting. */
  encoding?: string;
  /** Treat the first row as data, not a header (synthesizes column_1…). */
  noHeader?: boolean;
  /** XLSX: read this worksheet by name (defaults to the first). */
  sheetName?: string;
};

/** A parser turns raw bytes into the common table shape. */
export type Parser = (data: Buffer, opts?: ParseOptions) => Promise<ParsedTable> | ParsedTable;

/** Thrown when a file can't be parsed at all (corrupt, wrong format, empty). */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
