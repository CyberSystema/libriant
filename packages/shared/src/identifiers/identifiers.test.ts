import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDoi,
  checkEan,
  checkIdentifier,
  checkIsbn,
  checkIsmn,
  checkIssn,
  isbn10To13,
} from './index.js';

test('ISBN-13 accepts a real one and rejects a wrong check digit', () => {
  // 978-0-306-40615-7 is the canonical worked example.
  assert.equal(checkIsbn('978-0-306-40615-7').valid, true);
  assert.equal(checkIsbn('9780306406157').normalized, '9780306406157');
  // …and the SAME digits with the check changed. This is the case the 1.0
  // `normalizeIsbn13` accepts — measured `{ok: true}` — because it tests only
  // the shape.
  const wrong = checkIsbn('9780306406158');
  assert.equal(wrong.valid, false);
  assert.match(wrong.reason, /check digit is 8, expected 7/);
});

test('ISBN-10 validates mod 11 and upgrades only when valid', () => {
  assert.equal(checkIsbn('0-306-40615-2').valid, true);
  assert.equal(checkIsbn('0306406152').normalized, '9780306406157');
  assert.equal(isbn10To13('0306406152'), '9780306406157');
  // X is ten.
  assert.equal(checkIsbn('080442957X').valid, true);
  // An invalid ISBN-10 keeps its OWN digits. Upgrading it would manufacture a
  // 13-digit value that passes mod 10 and is fiction, and the cataloguer would
  // see in the queue a number the record does not contain.
  const bad = checkIsbn('0306406153');
  assert.equal(bad.valid, false);
  assert.equal(bad.normalized, '0306406153');
});

test('ISSN validates mod 11, including the X check', () => {
  assert.equal(checkIssn('0378-5955').valid, true);
  assert.equal(checkIssn('2049-3630').valid, true);
  const wrong = checkIssn('0378-5956');
  assert.equal(wrong.valid, false);
  assert.match(wrong.reason, /expected 5/);
});

test('ISMN accepts the current and the older printed form', () => {
  assert.equal(checkIsmn('979-0-2600-0043-8').valid, true);
  // The M form is still on the front of a great deal of sheet music.
  assert.equal(checkIsmn('M260000438').normalized, '9790260000438');
  assert.equal(checkIsmn('M260000438').valid, true);
  assert.equal(checkIsmn('9781234567897').valid, false, 'a 978 prefix is not an ISMN');
});

test('EAN-13 is the same arithmetic under a different name', () => {
  assert.equal(checkEan('4006381333931').valid, true);
  assert.equal(checkEan('4006381333930').valid, false);
});

test('DOI is a shape test and says so', () => {
  assert.equal(checkDoi('10.1000/182').valid, true);
  assert.equal(checkDoi('https://doi.org/10.1000/182').normalized, '10.1000/182');
  assert.equal(checkDoi('doi:10.1000/182').normalized, '10.1000/182');
  assert.equal(checkDoi('10.1000').valid, false);
  assert.equal(checkDoi('not a doi').valid, false);
});

test('nothing throws, on anything', () => {
  // The projector is required to be total, and it calls these. A librarian's
  // typo must not be able to abort a 50,000-record import halfway through.
  const hostile = [
    '',
    ' ',
    'X',
    'XXXXXXXXXX',
    '—'.repeat(50),
    '9'.repeat(500),
    '978-0-306-40615-7 (pbk.)',
    'ISBN 0306406152',
    ' �',
    '𝟵𝟷𝟴', // mathematical digits, not ASCII ones
    '\uD800', // a lone surrogate
    'null',
  ];
  for (const scheme of ['isbn', 'issn', 'ismn', 'doi', 'ean'] as const) {
    for (const value of hostile) {
      const v = checkIdentifier(scheme, value);
      assert.equal(typeof v.valid, 'boolean');
      assert.equal(typeof v.normalized, 'string');
      // An invalid verdict must always say why — an empty reason in a
      // cataloguer's queue is a row nobody can act on.
      if (!v.valid) assert.ok(v.reason.length > 0, `${scheme} ${JSON.stringify(value)}`);
    }
  }
});

test('a qualifier in the source does not defeat the check', () => {
  // THIS TEST WAS NAMED FOR A BEHAVIOUR IT DID NOT ASSERT. Its two lines were
  // both hyphen/space variants of a bare ISBN, and the qualifier case was
  // broken: `strip()` removed only whitespace and hyphens, so
  // `978-0-306-40615-7 (pbk.)` normalised to `9780306406157(PBK.)` and was
  // reported invalid. That is the worse of the two failures — `value_norm` backs
  // the ISBN lookup index, so the record became unfindable by its ISBN, and the
  // "impossible ISBN" queue filled with perfectly good numbers.
  //
  // MARC 21 gained `020 $q` for qualifying information in 2013; everything
  // catalogued before then, which is most of an ABEKT or Aleph export, puts it
  // in `$a`.
  assert.equal(checkIsbn('978 0 306 40615 7').valid, true);
  assert.equal(checkIsbn('978‐0‐306‐40615‐7').valid, true);

  for (const [raw, expected] of [
    ['978-0-306-40615-7 (pbk.)', '9780306406157'],
    ['9780306406157 (hardback ; alk. paper)', '9780306406157'],
    ['9780306406157 [electronic resource]', '9780306406157'],
    ['978-0-306-40615-7 : alk. paper', '9780306406157'],
    // An ISBN-10 with a qualifier keeps its 13-digit upgrade, which is the part
    // that matters for duplicate detection: the same book catalogued once with
    // a qualifier and once without must produce ONE value_norm.
    ['0-306-40615-2 (v. 1)', '9780306406157'],
  ] as const) {
    const v = checkIsbn(raw);
    assert.equal(v.valid, true, `${raw}: ${v.reason}`);
    assert.equal(v.normalized, expected, raw);
  }

  assert.equal(checkIssn('0028-0836 (print)').valid, true);
  assert.equal(checkIssn('0028-0836 (print)').normalized, '00280836');
  assert.equal(checkEan('4006381333931 (case)').valid, true);

  // Stripping the qualifier must not rescue a genuinely wrong number.
  assert.equal(checkIsbn('9780306406158 (pbk.)').valid, false);
});
