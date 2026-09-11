import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isbnIsValid,
  marc005,
  marcFromBook,
  type V1Author,
  type V1Book,
} from './marc-from-book.js';

const BOOK: V1Book = {
  id: 'clbook000000000000000001',
  title: 'Βίος και πολιτεία του Αλέξη Ζορμπά',
  subtitle: null,
  isbn13: null,
  isbn10: null,
  publisher: null,
  publicationYear: null,
  language: 'el',
  edition: null,
  numPages: null,
  description: null,
  classification: null,
  createdAt: new Date('2019-04-17T08:30:00.000Z'),
  updatedAt: new Date('2024-11-02T14:05:09.000Z'),
  archivedAt: null,
};

const AUTHOR: V1Author = {
  id: 'clauth000000000000000001',
  fullName: 'Καζαντζάκης, Νίκος',
  isOrganization: false,
  birthYear: 1883,
  deathYear: 1957,
  order: 0,
  role: null,
};

type Field = { t: string; v?: string; i?: string; s?: Record<string, string>[] };

const field = (r: { fields: readonly Field[] }, tag: string): Field | undefined =>
  r.fields.find((f) => f.t === tag);
const sub = (f: Field | undefined, code: string): string | undefined =>
  f?.s?.find((x) => code in x)?.[code];

describe('a 1.0 book becomes a MARC record', () => {
  it('carries the cuid as 001, so every permalink and audit target still resolves', () => {
    const { record } = marcFromBook(BOOK, [AUTHOR], 'LBR-demo');
    assert.equal(field(record, '001')?.v, BOOK.id);
    assert.equal(field(record, '003')?.v, 'LBR-demo');
  });

  it('takes 008/00-05 from createdAt and NOT from the migration date', () => {
    const { record } = marcFromBook(BOOK, [AUTHOR], 'LBR-demo');
    const o = field(record, '008')?.v ?? '';
    // 2019-04-17 -> 190417. A migrated catalogue whose 008 all said today would
    // report a library that acquired its whole collection on one afternoon.
    assert.equal(o.slice(0, 6), '190417');
    assert.equal(o.length, 40);
    assert.equal(o.slice(35, 38), 'gre');
  });

  it('spells Greek `gre`, never `ell`', () => {
    const { record } = marcFromBook({ ...BOOK, language: 'ell' }, [], 'LBR-demo');
    assert.equal((field(record, '008')?.v ?? '').slice(35, 38), 'gre');
    assert.equal(sub(field(record, '041'), 'a'), 'gre');
  });

  it('takes 005 from updatedAt', () => {
    const { record } = marcFromBook(BOOK, [], 'LBR-demo');
    assert.equal(field(record, '005')?.v, '20241102140509.0');
    assert.equal(marc005(new Date('2026-01-02T03:04:05.000Z')), '20260102030405.0');
  });

  it('computes the 245 non-filing indicator with the shared Greek article table', () => {
    // "Η ΠΟΛΙΣ ΕΑΛΩ" — the leading Η is a Greek article and two characters
    // (article + space) must be skipped, or the title files under Eta.
    const { record } = marcFromBook({ ...BOOK, title: 'Η πόλις εάλω' }, [], 'LBR-demo');
    const ind = field(record, '245')?.i ?? '';
    assert.equal(ind[1], '2');
  });

  it('ind1 is 0 when the title IS the main entry and 1 when an author is', () => {
    assert.equal(field(marcFromBook(BOOK, [], 'x').record, '245')?.i?.[0], '0');
    assert.equal(field(marcFromBook(BOOK, [AUTHOR], 'x').record, '245')?.i?.[0], '1');
  });

  it('KEEPS $e ON THE MAIN ENTRY — a translator listed first is not the author', () => {
    // Every candidate design for this phase put $e on 700/710 and omitted it
    // here, which silently migrates a translator as having written the book.
    const { record } = marcFromBook(BOOK, [{ ...AUTHOR, role: 'translator' }], 'x');
    assert.equal(sub(field(record, '100'), 'e'), 'translator');
    assert.equal(sub(field(record, '100'), '0'), AUTHOR.id);
  });

  it('an organisation is 110 with ind1=2 and carries no life dates', () => {
    const { record } = marcFromBook(
      BOOK,
      [{ ...AUTHOR, fullName: 'Εθνική Βιβλιοθήκη', isOrganization: true }],
      'x',
    );
    assert.equal(field(record, '110')?.i, '2 ');
    assert.equal(sub(field(record, '110'), 'd'), undefined);
    assert.equal(field(record, '100'), undefined);
  });

  it('orders the entries by `order`, then by id, and the rest become 700', () => {
    const second: V1Author = { ...AUTHOR, id: 'clauth000000000000000002', fullName: 'Β', order: 1 };
    const { record } = marcFromBook(BOOK, [second, AUTHOR], 'x');
    assert.equal(sub(field(record, '100'), 'a'), AUTHOR.fullName);
    assert.equal(sub(field(record, '700'), 'a'), 'Β');
  });

  it('a bad ISBN goes to $z with an exception, never silently away', () => {
    const { record, issues } = marcFromBook({ ...BOOK, isbn13: '9780000000001' }, [], 'x');
    assert.equal(sub(field(record, '020'), 'z'), '9780000000001');
    assert.equal(sub(field(record, '020'), 'a'), undefined);
    assert.equal(issues.filter((i) => i.column === 'isbn13').length, 1);
  });

  it('a good ISBN goes to $a, and a 10 alongside a 13 goes to $z', () => {
    const { record, issues } = marcFromBook(
      { ...BOOK, isbn13: '9780262033848', isbn10: '0262033844' },
      [],
      'x',
    );
    assert.equal(sub(field(record, '020'), 'a'), '9780262033848');
    assert.equal(
      field(record, '020')?.s?.some((s) => s['z'] === '0262033844'),
      true,
    );
    assert.equal(issues.length, 0);
  });

  it('an unknown language is an exception and a BLANK 008/35-37, never a guess', () => {
    const { record, issues } = marcFromBook({ ...BOOK, language: 'zz' }, [], 'x');
    assert.equal((field(record, '008')?.v ?? '').slice(35, 38), '   ');
    assert.equal(field(record, '041'), undefined);
    assert.equal(issues.filter((i) => i.column === 'language')[0]?.kind, 'invalid_source');
  });

  it('a Dewey-looking classification is 082 and anything else is 084 $2 local', () => {
    assert.equal(
      sub(field(marcFromBook({ ...BOOK, classification: '889.332' }, [], 'x').record, '082'), 'a'),
      '889.332',
    );
    const other = marcFromBook({ ...BOOK, classification: 'ΛΟΓ-ΚΑΖ' }, [], 'x').record;
    assert.equal(sub(field(other, '084'), 'a'), 'ΛΟΓ-ΚΑΖ');
    assert.equal(sub(field(other, '084'), '2'), 'local');
  });

  it('a subtitle becomes $b and the $a gains the ISBD colon', () => {
    const { record } = marcFromBook(
      { ...BOOK, title: 'Ζορμπάς', subtitle: 'μυθιστόρημα' },
      [],
      'x',
    );
    assert.equal(sub(field(record, '245'), 'a'), 'Ζορμπάς :');
    assert.equal(sub(field(record, '245'), 'b'), 'μυθιστόρημα');
  });

  it('an archived book is leader/05 = d, a live one n, and the leader is 24 chars', () => {
    assert.equal(marcFromBook(BOOK, [], 'x').record.leader.length, 24);
    assert.equal(marcFromBook(BOOK, [], 'x').record.leader[5], 'n');
    assert.equal(marcFromBook({ ...BOOK, archivedAt: new Date() }, [], 'x').record.leader[5], 'd');
    // /09 = 'a', UCS/Unicode, from the EXPORT encoding. A blank here is mojibake
    // at the far end.
    assert.equal(marcFromBook(BOOK, [], 'x').record.leader[9], 'a');
  });
});

describe('the ISBN check digit', () => {
  it('accepts real ISBNs in both lengths and rejects a transposition', () => {
    assert.equal(isbnIsValid('9780262033848'), true);
    assert.equal(isbnIsValid('978-0-262-03384-8'), true);
    assert.equal(isbnIsValid('0262033844'), true);
    assert.equal(isbnIsValid('080442957X'), true);
    assert.equal(isbnIsValid('9780262033884'), false);
    assert.equal(isbnIsValid('not-an-isbn'), false);
  });
});
