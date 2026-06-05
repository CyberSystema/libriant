import { describe, expect, it } from 'vitest';
import { autoMap, normalizeHeader } from './auto-map.js';
import { mapRow } from './row-mapper.js';

const cols = (...names: string[]) => names.map((name) => ({ name }));
const fieldOf = (m: Record<string, { field: string | null }>, col: string) => m[col]?.field ?? null;

describe('normalizeHeader', () => {
  it('folds case, punctuation and diacritics (Latin + Greek)', () => {
    expect(normalizeHeader('ISBN-13')).toBe('isbn13');
    expect(normalizeHeader('Τίτλος')).toBe('τιτλος');
    expect(normalizeHeader('245$a')).toBe('245a');
  });
});

describe('autoMap', () => {
  it('maps common English library headers for books', () => {
    const m = autoMap('book', cols('Title', 'ISBN', 'Publisher', 'Year', 'Author'));
    expect(fieldOf(m, 'Title')).toBe('title');
    expect(fieldOf(m, 'ISBN')).toBe('isbn13');
    expect(fieldOf(m, 'Publisher')).toBe('publisher');
    expect(fieldOf(m, 'Year')).toBe('publicationYear');
    expect(fieldOf(m, 'Author')).toBe('authors');
  });

  it('maps MARC subfield column names', () => {
    const m = autoMap('book', cols('245$a', '020$a', '260$b', '100$a'));
    expect(fieldOf(m, '245$a')).toBe('title');
    expect(fieldOf(m, '020$a')).toBe('isbn13');
    expect(fieldOf(m, '260$b')).toBe('publisher');
  });

  it('maps Greek headers', () => {
    const m = autoMap('member', cols('Ονοματεπώνυμο', 'Email', 'Τηλέφωνο', 'Πόλη'));
    expect(fieldOf(m, 'Ονοματεπώνυμο')).toBe('fullName');
    expect(fieldOf(m, 'Email')).toBe('email');
    expect(fieldOf(m, 'Τηλέφωνο')).toBe('phone');
    expect(fieldOf(m, 'Πόλη')).toBe('city');
  });

  it('leaves unknown columns unmapped (field: null)', () => {
    const m = autoMap('book', cols('Title', 'Mystery Column'));
    expect(fieldOf(m, 'Mystery Column')).toBeNull();
  });

  it('assigns each field at most once (1:1)', () => {
    const m = autoMap('book', cols('ISBN', 'ISBN-13'));
    const targets = [fieldOf(m, 'ISBN'), fieldOf(m, 'ISBN-13')].filter((f) => f === 'isbn13');
    expect(targets).toHaveLength(1);
  });
});

describe('mapRow', () => {
  it('maps + transforms a full book row', () => {
    const mapping = autoMap('book', cols('Title', 'ISBN', 'Year', 'Pages', 'Author'));
    const r = mapRow('book', mapping, {
      rowNumber: 1,
      cells: {
        Title: 'Dune',
        ISBN: '0-441-17271-7',
        Year: 'c1965.',
        Pages: '412',
        Author: 'Herbert, Frank; Anderson, Kevin',
      },
    });
    expect(r.issues).toEqual([]);
    expect(r.values.title).toBe('Dune');
    expect(r.values.isbn13).toBe('9780441172719'); // ISBN-10 upgraded
    expect(r.values.publicationYear).toBe(1965);
    expect(r.values.numPages).toBe(412);
    expect(r.values.authors).toEqual(['Herbert, Frank', 'Anderson, Kevin']);
  });

  it('flags a missing required field', () => {
    const r = mapRow('book', { Title: { field: 'title' } }, { rowNumber: 3, cells: { Title: '' } });
    expect(r.issues).toContainEqual(
      expect.objectContaining({ field: 'title', code: 'required', severity: 'error' }),
    );
  });

  it('reports an invalid typed value as a row error', () => {
    const r = mapRow(
      'book',
      { Title: { field: 'title' }, Pages: { field: 'numPages' } },
      { rowNumber: 2, cells: { Title: 'X', Pages: 'lots' } },
    );
    expect(r.values.numPages).toBeUndefined();
    expect(r.issues).toContainEqual(
      expect.objectContaining({ field: 'numPages', code: 'invalid_value', severity: 'error' }),
    );
  });

  it('normalizes status enums via synonyms', () => {
    const r = mapRow(
      'book_copy',
      { Barcode: { field: 'barcode' }, Status: { field: 'status' }, ISBN: { field: 'bookIsbn13' } },
      { rowNumber: 1, cells: { Barcode: 'C-1', Status: 'Checked Out', ISBN: '9780441172719' } },
    );
    expect(r.values.status).toBe('on_loan');
    expect(r.refs.bookIsbn13).toBe('9780441172719');
    expect(r.issues).toEqual([]);
  });

  it('routes reference keys to refs and requires them', () => {
    const r = mapRow(
      'loan',
      { Due: { field: 'dueAt' } },
      { rowNumber: 1, cells: { Due: '2020-03-05' } },
    );
    // No member/copy ref provided → two reference_missing errors.
    expect(r.issues.filter((i) => i.code === 'reference_missing')).toHaveLength(2);
  });

  it('captures custom-field columns as raw strings', () => {
    const r = mapRow(
      'book',
      { Title: { field: 'title' }, Genre: { field: 'custom:genre' } },
      { rowNumber: 1, cells: { Title: 'Dune', Genre: 'sci-fi' } },
    );
    expect(r.customFields).toEqual({ genre: 'sci-fi' });
  });

  it('honors day-first date tweaks', () => {
    const r = mapRow(
      'member',
      { Name: { field: 'fullName' }, DOB: { field: 'dateOfBirth', options: { dayFirst: true } } },
      { rowNumber: 1, cells: { Name: 'A', DOB: '05/03/1990' } },
    );
    expect(r.values.dateOfBirth).toBe('1990-03-05');
  });
});
