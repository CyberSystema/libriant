/**
 * The create form's record builder (2.0 phase 20l).
 *
 * What it must get right is narrow: fill the SERVED template rather than invent
 * a record, never write an empty field, keep the 008 forty bytes long, and
 * compute the two values a typist cannot — the non-filing indicator and the
 * ISBN check digit — through the same shared functions the projector uses.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_BOOK,
  recordFromBook,
  type BuiltField,
  type BuiltRecord,
  type CatalogTemplate,
} from '@/lib/marc-from-template';

/** The shipped `book` template, as `GET /catalog/templates` serves it. */
const BOOK_TEMPLATE: CatalogTemplate = {
  id: 'book',
  label: 'Book',
  profile: 'marc21/bibliographic',
  leader: '00000nam a2200000 a 4500',
  fields: [
    { tag: '008', v: '      |                              ||' },
    { tag: '020', i: '  ', codes: ['a'] },
    { tag: '100', i: '1 ', codes: ['a', 'd'] },
    { tag: '245', i: '10', codes: ['a', 'b', 'c'] },
    { tag: '250', i: '  ', codes: ['a'] },
    { tag: '264', i: ' 1', codes: ['a', 'b', 'c'] },
    { tag: '300', i: '  ', codes: ['a', 'b', 'c'] },
    { tag: '500', i: '  ', codes: ['a'] },
    { tag: '650', i: ' 0', codes: ['a'] },
    { tag: '700', i: '1 ', codes: ['a', 'e'] },
  ],
};

const NOW = new Date('2026-09-16T10:00:00Z');
const field = (r: BuiltRecord, tag: string): BuiltField | undefined =>
  r.fields.find((f) => f.t === tag);

test('copies the template leader rather than composing one', () => {
  // The whole point of serving the template. `marc-from-book.ts` shipped a
  // hand-written leader for six phases with 'M' at Leader/18, where it is not a
  // defined value, because a 24-character literal is counted by eye.
  const { record } = recordFromBook(BOOK_TEMPLATE, { ...EMPTY_BOOK, title: 'Τίτλος' }, NOW);
  assert.equal(record.leader, BOOK_TEMPLATE.leader);
  assert.equal(record.leader.length, 24);
});

test('a field the cataloguer left empty is not written', () => {
  const { record } = recordFromBook(BOOK_TEMPLATE, { ...EMPTY_BOOK, title: 'Μόνο τίτλος' }, NOW);
  const tags = record.fields.map((f) => f.t);
  assert.deepEqual(tags, ['008', '245'], 'only the fixed field and the title');
  // A present-but-blank subfield is a different record from one without it.
  assert.deepEqual(field(record, '245')!.s, [{ a: 'Μόνο τίτλος' }]);
});

test('the 008 stays forty bytes and carries year and language', () => {
  const { record } = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', publicationYear: '1946', language: 'gre' },
    NOW,
  );
  const v = field(record, '008')!.v!;
  assert.equal(v.length, 40, 'an 008 is positional; a length change shifts every later meaning');
  assert.equal(v.slice(0, 6), '260916', '00-05 date entered');
  assert.equal(v[6], 's', '06 single known date');
  assert.equal(v.slice(7, 11), '1946', '07-10 date 1');
  assert.equal(v.slice(35, 38), 'gre', '35-37 language');
});

test('no year is date type n and blank 07-10, not a guess', () => {
  const { record } = recordFromBook(BOOK_TEMPLATE, { ...EMPTY_BOOK, title: 'Τ' }, NOW);
  const v = field(record, '008')!.v!;
  assert.equal(v[6], 'n');
  assert.equal(v.slice(7, 11), '    ');
  // Blank is MARC's "no information", which is the truth. A guessed code would
  // be a claim about the book.
  assert.equal(v.slice(35, 38), '   ');
});

test('a two-letter language is refused rather than padded into 35-37', () => {
  // 'el' is BCP 47. MARC wants ISO 639-2/B, where Greek is 'gre'. Padding 'el '
  // into the window would be a code no receiving system can read.
  const { record } = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', language: 'el' },
    NOW,
  );
  assert.equal(field(record, '008')!.v!.slice(35, 38), '   ');
});

test('245 ind2 counts the characters to skip when filing', () => {
  // The defining case for a Greek catalogue: "Ο άνθρωπος" must file under Α.
  const { record } = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Ο άνθρωπος', language: 'gre' },
    NOW,
  );
  assert.equal(field(record, '245')!.i, '02', 'no main entry, skip 2');
});

test('245 ind1 is 1 when there is a main entry and 0 when the title is one', () => {
  const withAuthor = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τίτλος', author: 'Καζαντζάκης, Νίκος' },
    NOW,
  ).record;
  assert.equal(field(withAuthor, '245')!.i![0], '1');
  assert.deepEqual(field(withAuthor, '100')!.s, [{ a: 'Καζαντζάκης, Νίκος' }]);

  const without = recordFromBook(BOOK_TEMPLATE, { ...EMPTY_BOOK, title: 'Τίτλος' }, NOW).record;
  assert.equal(field(without, '245')!.i![0], '0');
  assert.equal(field(without, '100'), undefined);
});

test('the ISBN is normalised into the record and its verdict returned, not enforced', () => {
  // §5: no identifier is a uniqueness constraint, and a bad check digit is a
  // FACT for a queue rather than a refusal — a set and its volumes, a reprint,
  // and publisher reuse in small Greek presses all share ISBNs legitimately.
  const good = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', isbn: '978-960-05-0192-6' },
    NOW,
  );
  assert.equal(good.isbn!.valid, true);
  assert.deepEqual(field(good.record, '020')!.s, [{ a: '9789600501926' }], 'hyphens removed');

  const bad = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', isbn: '9789600501927' },
    NOW,
  );
  assert.equal(bad.isbn!.valid, false);
  assert.ok(bad.isbn!.reason.length > 0, 'a phrase for the queue');
  assert.ok(field(bad.record, '020'), 'stored anyway');
});

test('264 keeps place, publisher and date in the template order', () => {
  const { record } = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', place: 'Αθήνα', publisher: 'Εστία', publicationYear: '1946' },
    NOW,
  );
  assert.deepEqual(field(record, '264')!.s, [{ a: 'Αθήνα' }, { b: 'Εστία' }, { c: '1946' }]);
  assert.equal(field(record, '264')!.i, ' 1', 'ind2 1: publication');
});

test('a partly-filled field keeps only what was filled, in order', () => {
  const { record } = recordFromBook(
    BOOK_TEMPLATE,
    { ...EMPTY_BOOK, title: 'Τ', publisher: 'Εστία' },
    NOW,
  );
  assert.deepEqual(field(record, '264')!.s, [{ b: 'Εστία' }]);
});

test('every field written comes from the template, and none is invented', () => {
  const full: Parameters<typeof recordFromBook>[1] = {
    title: 'Τ',
    subtitle: 'υπότιτλος',
    statementOfResponsibility: 'Ν. Κ.',
    author: 'Καζαντζάκης, Νίκος',
    authorDates: '1883-1957',
    isbn: '9789600501926',
    edition: '2η έκδοση',
    place: 'Αθήνα',
    publisher: 'Εστία',
    publicationYear: '1946',
    extent: '320 σελίδες',
    note: 'Σημείωση',
    subject: 'Ελληνική λογοτεχνία',
    language: 'gre',
  };
  const { record } = recordFromBook(BOOK_TEMPLATE, full, NOW);
  const offered = new Set(BOOK_TEMPLATE.fields.map((f) => f.tag));
  for (const f of record.fields) {
    assert.ok(offered.has(f.t), `${f.t} is not a tag the template offers`);
  }
  // 700 is offered and left empty — a second contributor needs a repeatable
  // widget this form does not have, and an empty one must not be written.
  assert.equal(field(record, '700'), undefined);
});
