import { describe, it, expect } from 'vitest';
import { patternLooksCatastrophic, REGEX_INPUT_CAP } from './field-types.js';

/**
 * Locks the ReDoS screen (`patternLooksCatastrophic`). The dominant exponential
 * class is a REPEATED group with an ambiguous body — nested unbounded quantifier
 * or overlapping alternation. We must reject those while keeping ordinary
 * field-validation patterns usable.
 */
describe('patternLooksCatastrophic — rejects exponential patterns', () => {
  const evil = [
    '(a+)+',
    '(a+)+$',
    '(a*)+',
    '(.*)*',
    '([a-z]+)*',
    '(\\d+)+',
    '(a|a)*',
    '(a|ab)+',
    '(a|a*)*',
    '(foo|foobar)+',
    '(a|)*', // empty branch
    '(a+){2,}',
    '(.*a){11,}',
    'a+*', // stacked quantifiers
    '\\w*+',
    'a*a*a*a*a*a*a*$', // many overlapping quantifiers → high-degree polynomial
    // A4-01: bounded {n}/{n,m} repetition of an ambiguous group — the bypass the
    // old open-ended-only check missed. Each still backtracks catastrophically.
    '([a-z]*){8}$',
    '(a*){5}c',
    '(a|a){10}',
    '(.*){10}',
    '(a+){8}',
    '(.*a){11}',
  ];
  for (const p of evil) {
    it(`flags ${p}`, () => expect(patternLooksCatastrophic(p)).toBe(true));
  }

  it('flags absurdly long patterns', () => {
    expect(patternLooksCatastrophic('a'.repeat(201))).toBe(true);
  });
});

describe('patternLooksCatastrophic — accepts ordinary patterns', () => {
  const safe = [
    '^[A-Z]{2}-\\d+$', // used by the dynamic-validator spec — must stay accepted
    '(foo|bar)+',
    '(ab|cd)*',
    '([A-Z]{2})+',
    '\\d{4}-\\d{2}-\\d{2}',
    '^[a-z0-9_]+$',
    '(https?|ftp)://.+',
    '^\\+?[0-9 ()-]{7,20}$',
    '[A-Z][a-z]+',
    '(cat|dog|bird)s?',
    'a*b*c*', // 3 distinct sequential quantifiers — linear, fine
  ];
  for (const p of safe) {
    it(`accepts ${p}`, () => expect(patternLooksCatastrophic(p)).toBe(false));
  }
});

describe('ReDoS guard is effective in practice', () => {
  it('a pattern the guard accepts cannot blow up within the input cap', () => {
    // Sanity: the canonical evil regex IS caught, so it never reaches a match.
    const pat = '(a+)+$';
    expect(patternLooksCatastrophic(pat)).toBe(true);

    // And an accepted pattern run against a capped, adversarial input stays fast.
    const accepted = '^[a-z0-9_]+$';
    expect(patternLooksCatastrophic(accepted)).toBe(false);
    const input = 'a'.repeat(REGEX_INPUT_CAP) + '!'; // worst case for `+$`
    const re = new RegExp(accepted);
    const t0 = performance.now();
    re.test(input.slice(0, REGEX_INPUT_CAP));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
