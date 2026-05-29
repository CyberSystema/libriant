import { describe, expect, it } from 'vitest';
import { validateRecord } from './dynamic-validator.js';
import type { FieldDef } from './field-types.js';

const F = (overrides: Partial<FieldDef> & Pick<FieldDef, 'fieldKey' | 'type'>): FieldDef => ({
  required: false,
  optionsJson: null,
  validationJson: null,
  ...overrides,
});

describe('validateRecord — type checks', () => {
  it('short_text passes a string and surfaces it in cleaned', () => {
    const out = validateRecord([F({ fieldKey: 'shelf', type: 'short_text' })], { shelf: 'A-12' });
    expect(out).toEqual({ ok: true, cleaned: { shelf: 'A-12' } });
  });

  it('short_text rejects non-strings', () => {
    const out = validateRecord([F({ fieldKey: 'shelf', type: 'short_text' })], { shelf: 42 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatchObject({ field: 'shelf', message: /text/i });
  });

  it('number passes integers + floats', () => {
    const def = F({ fieldKey: 'pages', type: 'number' });
    expect(validateRecord([def], { pages: 100 })).toMatchObject({ ok: true });
    expect(validateRecord([def], { pages: 3.14 })).toMatchObject({ ok: true });
  });

  it('number rejects non-numeric strings', () => {
    const out = validateRecord([F({ fieldKey: 'pages', type: 'number' })], { pages: 'big' });
    expect(out.ok).toBe(false);
  });

  it('boolean accepts true/false; rejects anything else', () => {
    const def = F({ fieldKey: 'rare', type: 'boolean' });
    expect(validateRecord([def], { rare: true })).toMatchObject({ ok: true });
    expect(validateRecord([def], { rare: false })).toMatchObject({ ok: true });
    expect(validateRecord([def], { rare: 'yes' })).toMatchObject({ ok: false });
  });

  it('date accepts ISO YYYY-MM-DD, rejects malformed', () => {
    const def = F({ fieldKey: 'acquired', type: 'date' });
    expect(validateRecord([def], { acquired: '2026-05-29' })).toMatchObject({ ok: true });
    expect(validateRecord([def], { acquired: '29/05/2026' })).toMatchObject({ ok: false });
  });

  it('email — basic shape check', () => {
    const def = F({ fieldKey: 'contact', type: 'email' });
    expect(validateRecord([def], { contact: 'ops@step18a.test' })).toMatchObject({ ok: true });
    expect(validateRecord([def], { contact: 'not-an-email' })).toMatchObject({ ok: false });
  });

  it('url — accepts http/https; rejects garbage', () => {
    const def = F({ fieldKey: 'homepage', type: 'url' });
    expect(validateRecord([def], { homepage: 'https://libriant.app' })).toMatchObject({ ok: true });
    expect(validateRecord([def], { homepage: 'not-a-url' })).toMatchObject({ ok: false });
  });

  it('select_one rejects values not in the options list', () => {
    const def = F({
      fieldKey: 'genre',
      type: 'select_one',
      optionsJson: { options: [{ value: 'fiction' }, { value: 'reference' }] },
    });
    expect(validateRecord([def], { genre: 'fiction' })).toMatchObject({ ok: true });
    expect(validateRecord([def], { genre: 'foo' })).toMatchObject({ ok: false });
  });

  it('select_many accepts a subset of options', () => {
    const def = F({
      fieldKey: 'tags',
      type: 'select_many',
      optionsJson: { options: [{ value: 'rare' }, { value: 'signed' }, { value: 'damaged' }] },
    });
    expect(validateRecord([def], { tags: ['rare', 'signed'] })).toMatchObject({ ok: true });
    expect(validateRecord([def], { tags: ['rare', 'unknown'] })).toMatchObject({ ok: false });
  });
});

describe('validateRecord — required + missing', () => {
  it('required + missing → error', () => {
    const out = validateRecord([F({ fieldKey: 'shelf', type: 'short_text', required: true })], {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatchObject({ field: 'shelf' });
  });

  it('optional + missing → null in cleaned (caller may persist nothing)', () => {
    const out = validateRecord([F({ fieldKey: 'shelf', type: 'short_text' })], {});
    expect(out).toEqual({ ok: true, cleaned: { shelf: null } });
  });

  it('partial mode skips required checks for fields not provided', () => {
    const defs = [F({ fieldKey: 'shelf', type: 'short_text', required: true })];
    const out = validateRecord(defs, {}, { partial: true });
    expect(out).toEqual({ ok: true, cleaned: {} });
  });
});

describe('validateRecord — unknown fields', () => {
  it('rejects unknown fields by default', () => {
    const out = validateRecord([F({ fieldKey: 'shelf', type: 'short_text' })], {
      shelf: 'A-12',
      extra: 'oops',
    });
    expect(out.ok).toBe(false);
  });

  it('strips unknown fields when unknownFields="strip"', () => {
    const out = validateRecord(
      [F({ fieldKey: 'shelf', type: 'short_text' })],
      { shelf: 'A-12', extra: 'ignored' },
      { unknownFields: 'strip' },
    );
    expect(out).toEqual({ ok: true, cleaned: { shelf: 'A-12' } });
  });

  it('rejects non-object payloads upfront', () => {
    expect(validateRecord([], null)).toMatchObject({ ok: false });
    expect(validateRecord([], [])).toMatchObject({ ok: false });
    expect(validateRecord([], 'string')).toMatchObject({ ok: false });
  });
});

describe('validateRecord — custom validation rules', () => {
  it('number min/max', () => {
    const def = F({
      fieldKey: 'pages',
      type: 'number',
      validationJson: { min: 1, max: 5000 },
    });
    expect(validateRecord([def], { pages: 0 })).toMatchObject({ ok: false });
    expect(validateRecord([def], { pages: 5001 })).toMatchObject({ ok: false });
    expect(validateRecord([def], { pages: 250 })).toMatchObject({ ok: true });
  });

  it('text minLength/maxLength', () => {
    const def = F({
      fieldKey: 'note',
      type: 'short_text',
      validationJson: { minLength: 3, maxLength: 10 },
    });
    expect(validateRecord([def], { note: 'ab' })).toMatchObject({ ok: false });
    expect(validateRecord([def], { note: 'abcdefghijk' })).toMatchObject({ ok: false });
    expect(validateRecord([def], { note: 'okay' })).toMatchObject({ ok: true });
  });

  it('text pattern enforcement', () => {
    const def = F({
      fieldKey: 'callno',
      type: 'short_text',
      validationJson: { pattern: '^[A-Z]{2}-\\d+$' },
    });
    expect(validateRecord([def], { callno: 'AB-123' })).toMatchObject({ ok: true });
    expect(validateRecord([def], { callno: 'AB123' })).toMatchObject({ ok: false });
  });
});
