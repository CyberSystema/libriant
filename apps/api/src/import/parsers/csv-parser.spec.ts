import { describe, expect, it } from 'vitest';
import { parseDelimited } from './csv-parser.js';
import { ParseError } from './types.js';

const buf = (s: string) => Buffer.from(s, 'utf-8');

describe('parseDelimited', () => {
  it('parses a basic comma file with a header', () => {
    const t = parseDelimited(buf('title,isbn\nDune,9780441013593\nIt,9781501142970\n'));
    expect(t.columns.map((c) => c.name)).toEqual(['title', 'isbn']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual({ rowNumber: 1, cells: { title: 'Dune', isbn: '9780441013593' } });
    expect(t.meta.delimiter).toBe(',');
    expect(t.meta.format).toBe('csv');
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    const t = parseDelimited(buf('title,note\n"Hello, World","line1\nline2"\n'));
    expect(t.rows[0]!.cells).toEqual({ title: 'Hello, World', note: 'line1\nline2' });
  });

  it('handles the "" escaped-quote sequence', () => {
    const t = parseDelimited(buf('title\n"She said ""hi"""\n'));
    expect(t.rows[0]!.cells.title).toBe('She said "hi"');
  });

  it('auto-detects a semicolon delimiter', () => {
    const t = parseDelimited(buf('a;b;c\n1;2;3\n'));
    expect(t.meta.delimiter).toBe(';');
    expect(t.rows[0]!.cells).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('auto-detects a tab delimiter and reports tsv', () => {
    const t = parseDelimited(buf('a\tb\n1\t2\n'));
    expect(t.meta.delimiter).toBe('\t');
    expect(t.meta.format).toBe('tsv');
  });

  it('respects a forced delimiter', () => {
    const t = parseDelimited(buf('a,b\n1,2\n'), { delimiter: '|' });
    // With '|' as delimiter, the whole "a,b" is one column name.
    expect(t.columns[0]!.name).toBe('a,b');
  });

  it('handles CRLF line endings', () => {
    const t = parseDelimited(buf('a,b\r\n1,2\r\n3,4\r\n'));
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]!.cells).toEqual({ a: '3', b: '4' });
  });

  it('pads short rows with empty strings', () => {
    const t = parseDelimited(buf('a,b,c\n1,2\n'));
    expect(t.rows[0]!.cells).toEqual({ a: '1', b: '2', c: '' });
  });

  it('preserves overflow cells under synthesized column names', () => {
    const t = parseDelimited(buf('a,b\n1,2,3,4\n'));
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b', 'column_3', 'column_4']);
    expect(t.rows[0]!.cells).toEqual({ a: '1', b: '2', column_3: '3', column_4: '4' });
  });

  it('disambiguates duplicate header labels', () => {
    const t = parseDelimited(buf('isbn,isbn,isbn\n1,2,3\n'));
    expect(t.columns.map((c) => c.name)).toEqual(['isbn', 'isbn_2', 'isbn_3']);
  });

  it('fills blank header cells with column_N', () => {
    const t = parseDelimited(buf('title,,year\nDune,,1965\n'));
    expect(t.columns.map((c) => c.name)).toEqual(['title', 'column_2', 'year']);
  });

  it('skips fully-blank lines and numbers rows continuously', () => {
    const t = parseDelimited(buf('a\n1\n\n2\n\n'));
    expect(t.rows.map((r) => [r.rowNumber, r.cells.a])).toEqual([
      [1, '1'],
      [2, '2'],
    ]);
  });

  it('supports noHeader mode with synthesized columns', () => {
    const t = parseDelimited(buf('1,2\n3,4\n'), { noHeader: true });
    expect(t.columns.map((c) => c.name)).toEqual(['column_1', 'column_2']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!.cells).toEqual({ column_1: '1', column_2: '2' });
  });

  it('honors maxRows and flags truncation', () => {
    const t = parseDelimited(buf('a\n1\n2\n3\n4\n'), { maxRows: 2 });
    expect(t.rows).toHaveLength(2);
    expect(t.truncated).toBe(true);
  });

  it('preserves Greek text intact', () => {
    const t = parseDelimited(buf('title\nΟι Αδελφοί Καραμάζοφ\n'));
    expect(t.rows[0]!.cells.title).toBe('Οι Αδελφοί Καραμάζοφ');
  });

  it('strips a UTF-8 BOM before the header', () => {
    const t = parseDelimited(Buffer.from('﻿title,isbn\nDune,1\n', 'utf-8'));
    expect(t.columns[0]!.name).toBe('title');
  });

  it('handles a final row with no trailing newline', () => {
    const t = parseDelimited(buf('a,b\n1,2'));
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.cells).toEqual({ a: '1', b: '2' });
  });

  it('throws ParseError on an empty file', () => {
    expect(() => parseDelimited(buf('   \n  \n'))).toThrow(ParseError);
  });
});
