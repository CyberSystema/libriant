/**
 * Bibliographic identifiers, and whether they are self-consistent.
 *
 * §5's standards matrix puts "ISBN/ISSN/ISMN/DOI/EAN-13, check-digit validated"
 * at phase 11, with one sentence that decides the whole shape of this module:
 * **"None is a uniqueness constraint."**
 *
 * ## Validation here means FLAGGING, never refusing
 *
 * §3 is explicit that ISBN is deliberately not unique in 2.0 — the 1.0
 * constraint "would refuse the exact catalogues this product exists to import",
 * because a set and its volumes, a reprint, and endemic publisher ISBN reuse in
 * small Greek presses all legitimately share one. The same reasoning applies a
 * level down: a record whose ISBN fails its check digit is a record a library
 * HAS, and refusing to store it would refuse the catalogue. So every function
 * here returns a verdict; nothing throws and nothing rejects.
 *
 * What the verdict buys is a queue. A cataloguer can be shown "these 40 records
 * have an ISBN that cannot be right" and fix them, which is impossible if the
 * bad value was never stored and equally impossible if it was stored unmarked.
 *
 * ## Why this is not the existing code
 *
 * `apps/api/src/import/mapping/transforms.ts` has `normalizeIsbn13`, and it
 * checks only the SHAPE. Measured: `normalizeIsbn13('9780306406158')` — the
 * well-known 978-0-306-40615-7 with a deliberately wrong final digit — returns
 * `{ ok: true }`, and so does `'0000000000000'`. `isbn10to13` COMPUTES a check
 * digit and never VERIFIES one. That module is 1.0 import code the phase-20
 * cutover deletes; this is the 2.0 answer and it lives in `@libriant/shared`
 * because the projector, the OPAC and the Rust core all need the same one.
 */

/** The identifier schemes the projector extracts and validates. */
export const IDENTIFIER_SCHEMES = ['isbn', 'issn', 'ismn', 'doi', 'ean'] as const;
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

export type IdentifierVerdict = {
  /** Digits only, upper-cased, hyphens and spaces removed. Never null. */
  readonly normalized: string;
  /**
   * Whether the value is self-consistent — the check digit agrees with the rest.
   *
   * `false` is a fact about the value, not a refusal: the caller stores it
   * anyway and shows the cataloguer a queue.
   */
  readonly valid: boolean;
  /** One phrase, for that queue. Empty when valid. */
  readonly reason: string;
};

/**
 * The qualifying information a real 020/022/024 `$a` carries after the number.
 *
 * MARC 21 gained `020 $q` for this in 2013. Everything catalogued before then —
 * which is most of what an ABEKT, Koha or Aleph export contains — puts it inside
 * `$a`: `9780306406157 (pbk.)`, `0-306-40615-2 (v. 1)`, `0028-0836 (print)`,
 * `978-960-... : alk. paper`.
 *
 * Stripping only whitespace and hyphens left that text in the value, so the
 * digit test failed and the projector stored `value_norm =
 * '9780306406157(PBK.)'` with `valid = false`. Measured, and it is the worse of
 * the two possible failures: `bib_identifiers_lookup_idx` is on
 * `(scheme, value_norm)`, so an ISBN search for `9780306406157` matched nothing,
 * and the "these records have an impossible ISBN" queue filled with records
 * whose ISBN is perfectly good. A qualified ISBN-10 lost its 13-digit upgrade as
 * well, so the same book catalogued once with a qualifier and once without
 * produced two `value_norm` values that do not match — which also degrades the
 * duplicate signal phase 39 reads.
 *
 * Order matters: the parenthetical goes first, because `(v. 1)` contains the
 * `.` and the space that the trailing-phrase rule would otherwise stop at.
 */
const QUALIFIER = [
  /\([^)]*\)/g, // (pbk.), (v. 1), (Print)
  /\[[^\]]*\]/g, // [electronic resource]
  /\s*[:;]\s*.*$/, // : alk. paper — ISBD qualifying phrase
] as const;

/**
 * Reduce a transcribed identifier to the characters the check digit is over.
 *
 * NOT applied to what is stored as `value`: the schema requires that column to
 * hold the string as transcribed, qualifiers and all. This is only the input to
 * the arithmetic and the source of `value_norm`.
 */
const strip = (raw: string) => {
  let v = raw;
  for (const re of QUALIFIER) v = v.replace(re, ' ');
  return v.replace(/[\s‐-―-]/g, '').toUpperCase();
};

/** Sum of digits under alternating weights, the EAN/ISBN-13 rule. */
function mod10Alternating(digits: string, firstWeight: 1 | 3): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const w = i % 2 === 0 ? firstWeight : firstWeight === 1 ? 3 : 1;
    sum += w * Number(digits[i]);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * ISBN-13 and EAN-13 — the same arithmetic, mod 10 with weights 1,3.
 *
 * An ISBN-13 is an EAN-13 whose prefix is 978 or 979; the check digit does not
 * know the difference, which is why they share an implementation and differ only
 * in what `reason` says.
 */
function checkEan13(value: string, label: string): IdentifierVerdict {
  if (!/^\d{13}$/.test(value)) {
    return { normalized: value, valid: false, reason: `${label} must be 13 digits` };
  }
  const expected = mod10Alternating(value.slice(0, 12), 1);
  return Number(value[12]) === expected
    ? { normalized: value, valid: true, reason: '' }
    : {
        normalized: value,
        valid: false,
        reason: `${label} check digit is ${value[12]}, expected ${expected}`,
      };
}

/** ISBN-10: mod 11, weights 10 down to 1, check digit may be X (=10). */
function checkIsbn10(value: string): IdentifierVerdict {
  if (!/^\d{9}[\dX]$/.test(value)) {
    return { normalized: value, valid: false, reason: 'ISBN-10 must be 9 digits and a check' };
  }
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(value[i]);
  const check = value[9] === 'X' ? 10 : Number(value[9]);
  return (sum + check) % 11 === 0
    ? { normalized: value, valid: true, reason: '' }
    : { normalized: value, valid: false, reason: 'ISBN-10 check digit does not agree' };
}

/**
 * Upgrade a valid ISBN-10 to its ISBN-13 form.
 *
 * Only ever applied to a value that already passed its own check digit: a
 * 10-digit string that fails mod 11 is not an ISBN, and converting it would
 * manufacture a 13-digit value that passes mod 10 and is fiction.
 */
export function isbn10To13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  return `${core}${mod10Alternating(core, 1)}`;
}

/**
 * An ISBN in either length.
 *
 * A 10-digit ISBN is normalized to its 13-digit form so the catalogue has ONE
 * spelling to match on — but only when it is valid, for the reason above. An
 * invalid ISBN-10 keeps its own digits, so what the cataloguer sees in the
 * queue is what the record actually says.
 */
export function checkIsbn(raw: string): IdentifierVerdict {
  const v = strip(raw);
  if (v.length === 10) {
    const ten = checkIsbn10(v);
    return ten.valid ? { normalized: isbn10To13(v), valid: true, reason: '' } : ten;
  }
  return checkEan13(v, 'ISBN-13');
}

/** ISSN: mod 11 over 7 digits, weights 8 down to 2, check may be X. */
export function checkIssn(raw: string): IdentifierVerdict {
  const v = strip(raw);
  if (!/^\d{7}[\dX]$/.test(v)) {
    return { normalized: v, valid: false, reason: 'ISSN must be 7 digits and a check' };
  }
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += (8 - i) * Number(v[i]);
  const remainder = sum % 11;
  const expected = remainder === 0 ? '0' : remainder === 1 ? 'X' : String(11 - remainder);
  return v[7] === expected
    ? { normalized: v, valid: true, reason: '' }
    : { normalized: v, valid: false, reason: `ISSN check digit is ${v[7]}, expected ${expected}` };
}

/**
 * ISMN — printed music.
 *
 * The current form is a 13-digit EAN beginning 9790. The older form was an `M`
 * followed by nine digits; it is still on the front of a great deal of sheet
 * music, so it is accepted and upgraded rather than refused.
 */
export function checkIsmn(raw: string): IdentifierVerdict {
  let v = strip(raw);
  if (/^M\d{9}$/.test(v)) v = `979-0${v.slice(1)}`.replace(/-/g, '');
  if (!v.startsWith('9790')) {
    return { normalized: v, valid: false, reason: 'ISMN must begin 979-0 (or the older M form)' };
  }
  return checkEan13(v, 'ISMN');
}

export function checkEan(raw: string): IdentifierVerdict {
  return checkEan13(strip(raw), 'EAN-13');
}

/**
 * DOI — a SHAPE test, because a DOI has no check digit at all.
 *
 * `10.<registrant>/<suffix>`. The suffix is opaque by design and may contain
 * almost anything, so this asserts only what the syntax guarantees. Saying
 * `valid: true` here means "this is shaped like a DOI", never "this resolves" —
 * and the reason string says so, because a queue that promises more than it
 * checks is worse than one that checks nothing.
 */
export function checkDoi(raw: string): IdentifierVerdict {
  const v = raw.trim();
  const m = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?(10\.\d{4,9}\/\S+)$/i.exec(v);
  return m
    ? { normalized: m[1]!.toLowerCase(), valid: true, reason: '' }
    : { normalized: v, valid: false, reason: 'not shaped like a DOI (10.nnnn/suffix)' };
}

/** Dispatch, for a caller that has the scheme as data. */
export function checkIdentifier(scheme: IdentifierScheme, raw: string): IdentifierVerdict {
  switch (scheme) {
    case 'isbn':
      return checkIsbn(raw);
    case 'issn':
      return checkIssn(raw);
    case 'ismn':
      return checkIsmn(raw);
    case 'ean':
      return checkEan(raw);
    case 'doi':
      return checkDoi(raw);
  }
}
