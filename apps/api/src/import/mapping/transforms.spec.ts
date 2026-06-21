import { describe, expect, it } from 'vitest';
import {
  flipName,
  isbn10to13,
  normalizeIsbn10,
  normalizeIsbn13,
  splitMulti,
  toBool,
  toDateIso,
  toDateTimeIso,
  toInt,
  toMoneyCents,
  toYear,
} from './transforms.js';

describe('toInt', () => {
  it('parses plain and thousands-separated integers', () => {
    expect(toInt('42')).toEqual({ ok: true, value: 42 });
    expect(toInt('1,234')).toEqual({ ok: true, value: 1234 });
    expect(toInt('  -7 ')).toEqual({ ok: true, value: -7 });
  });
  it('rejects non-numbers', () => {
    expect(toInt('abc').ok).toBe(false);
    expect(toInt('').ok).toBe(false);
  });
});

describe('toYear', () => {
  it('extracts a year from noisy MARC publication strings', () => {
    expect(toYear('c2020.')).toEqual({ ok: true, value: 2020 });
    expect(toYear('[1998]')).toEqual({ ok: true, value: 1998 });
  });
  it('fails when no year is present', () => {
    expect(toYear('n.d.').ok).toBe(false);
  });
});

describe('toBool', () => {
  it('accepts many truthy/falsy spellings incl. Greek', () => {
    expect(toBool('yes')).toEqual({ ok: true, value: true });
    expect(toBool('ναι')).toEqual({ ok: true, value: true });
    expect(toBool('0')).toEqual({ ok: true, value: false });
    expect(toBool('όχι')).toEqual({ ok: true, value: false });
  });
  it('rejects ambiguous values', () => {
    expect(toBool('maybe').ok).toBe(false);
  });
});

describe('toMoneyCents', () => {
  it('parses both decimal conventions and currency symbols', () => {
    expect(toMoneyCents('€1.50')).toEqual({ ok: true, value: 150 });
    expect(toMoneyCents('1,50 €')).toEqual({ ok: true, value: 150 });
    expect(toMoneyCents('1.234,56')).toEqual({ ok: true, value: 123456 });
    expect(toMoneyCents('1,234.56')).toEqual({ ok: true, value: 123456 });
    expect(toMoneyCents('150')).toEqual({ ok: true, value: 15000 });
  });
  it('treats a comma-thousands group as no decimals', () => {
    expect(toMoneyCents('1,200')).toEqual({ ok: true, value: 120000 });
  });
  it('fails on non-amounts', () => {
    expect(toMoneyCents('free').ok).toBe(false);
  });
});

describe('toDateIso', () => {
  it('accepts ISO dates and datetimes', () => {
    expect(toDateIso('2020-03-05')).toEqual({ ok: true, value: '2020-03-05' });
    expect(toDateIso('2020-03-05T10:00:00Z')).toEqual({ ok: true, value: '2020-03-05' });
  });
  it('defaults to day-first for ambiguous slashed dates', () => {
    expect(toDateIso('05/03/2020')).toEqual({ ok: true, value: '2020-03-05' });
  });
  it('disambiguates when a component exceeds 12', () => {
    expect(toDateIso('13/02/2020')).toEqual({ ok: true, value: '2020-02-13' });
    expect(toDateIso('2020/12/31')).toEqual({ ok: true, value: '2020-12-31' });
  });
  it('honors month-first when requested', () => {
    expect(toDateIso('03/05/2020', { dayFirst: false })).toEqual({ ok: true, value: '2020-03-05' });
  });
  it('rejects impossible dates', () => {
    expect(toDateIso('31/02/2020').ok).toBe(false);
  });
});

describe('toDateTimeIso', () => {
  it('preserves a real datetime and pads a date-only value', () => {
    expect(toDateTimeIso('2020-03-05T10:30:00Z')).toEqual({
      ok: true,
      value: '2020-03-05T10:30:00.000Z',
    });
    expect(toDateTimeIso('05/03/2020')).toEqual({
      ok: true,
      value: '2020-03-05T00:00:00.000Z',
    });
  });
});

describe('ISBN helpers', () => {
  it('upgrades ISBN-10 to ISBN-13 with a correct check digit', () => {
    expect(isbn10to13('0306406152')).toBe('9780306406157');
  });
  it('normalizes a hyphenated ISBN-13', () => {
    expect(normalizeIsbn13('978-0-441-01359-3')).toEqual({ ok: true, value: '9780441013593' });
  });
  it('upgrades a 10-digit ISBN supplied to an isbn13 field', () => {
    expect(normalizeIsbn13('0-306-40615-2')).toEqual({ ok: true, value: '9780306406157' });
  });
  it('keeps a trailing X on ISBN-10', () => {
    expect(normalizeIsbn10('097522980X')).toEqual({ ok: true, value: '097522980X' });
  });
  it('rejects malformed ISBNs', () => {
    expect(normalizeIsbn13('12345').ok).toBe(false);
  });
});

describe('splitMulti / flipName', () => {
  it('splits on ; and | but not commas (so names survive)', () => {
    expect(splitMulti('King, Stephen; Herbert, Frank')).toEqual([
      'King, Stephen',
      'Herbert, Frank',
    ]);
    expect(splitMulti('a|b|c')).toEqual(['a', 'b', 'c']);
  });
  it('A8-03: treats a user separator containing "-" as a literal, not a range', () => {
    // "-" must be escaped inside the char class: as a literal separator it splits
    // on "-", and it must NOT silently become an a–c range.
    expect(splitMulti('a-b-c', '-')).toEqual(['a', 'b', 'c']);
    expect(splitMulti('xqy', 'a-c')).toEqual(['xqy']); // not a range → no split on b
  });
  it('A8-03: an out-of-order range separator does not throw (would crash the batch)', () => {
    expect(() => splitMulti('hello', 'z-a')).not.toThrow();
    expect(splitMulti('p-z-a-q', 'z-a')).toEqual(['p', 'q']); // splits on z, -, a literally
  });
  it('flips Last, First to First Last', () => {
    expect(flipName('Καζαντζάκης, Νίκος')).toBe('Νίκος Καζαντζάκης');
    expect(flipName('Madonna')).toBe('Madonna');
  });
});
