/**
 * The simple form's op builder (2.0 phase 20j).
 *
 * This is the piece that stands between a cataloguer's keystroke and
 * `applyOps`, and it is pure, so it is tested here rather than through a
 * rendered screen. What it must get right is narrow and sharp: address the
 * occurrence it READ, send ops only for what CHANGED, and carry the `from`
 * precondition that stops a stale form overwriting somebody else's save.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIMPLE_FIELDS,
  canEdit,
  opsForChanges,
  readField,
  readSimpleFields,
} from '@/lib/marc-simple-fields';

/** A record shaped the way `marcFromBook` builds one. */
function record() {
  return {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '008', v: '260905s1946    gr |||||||||||000 0 gre d' },
      { t: '020', i: '  ', s: [{ a: '9789600501926' }] },
      { t: '100', i: '1 ', s: [{ a: 'Καζαντζάκης, Νίκος,' }, { d: '1883-1957' }] },
      { t: '245', i: '10', s: [{ a: 'Η ΠΟΛΙΣ ΕΑΛΩ /' }, { c: 'Νίκος Καζαντζάκης.' }] },
      { t: '264', i: ' 1', s: [{ b: 'Εστία,' }, { c: '1946.' }] },
    ],
  } as never;
}

test('reads each widget from the record', () => {
  const values = readSimpleFields(record());
  assert.equal(values.title, 'Η ΠΟΛΙΣ ΕΑΛΩ /');
  assert.equal(values.publisher, 'Εστία,');
  assert.equal(values.publicationYear, '1946.');
  assert.equal(values.isbn, '9789600501926');
  assert.equal(values.edition, '');
});

test('sends ops ONLY for the widget that changed', () => {
  const r = record();
  const before = readSimpleFields(r);
  const ops = opsForChanges(r, before, { ...before, title: 'Η ΠΟΛΙΣ ΕΑΛΩ' });
  assert.equal(ops.length, 1, 'a form that sends every field makes each edit a whole-record diff');
  assert.deepEqual(ops[0], {
    op: 'setValue',
    path: '245[0]$a[0]',
    from: 'Η ΠΟΛΙΣ ΕΑΛΩ /',
    to: 'Η ΠΟΛΙΣ ΕΑΛΩ',
  });
});

test('nothing changed is no ops — a version that says nothing happened', () => {
  const r = record();
  const before = readSimpleFields(r);
  assert.deepEqual(opsForChanges(r, before, { ...before }), []);
});

test('whitespace-only edits are not edits', () => {
  const r = record();
  const before = readSimpleFields(r);
  assert.deepEqual(opsForChanges(r, before, { ...before, title: '  Η ΠΟΛΙΣ ΕΑΛΩ /  ' }), []);
});

test('carries `from` as the precondition that refuses a stale overwrite', () => {
  const r = record();
  const before = readSimpleFields(r);
  const ops = opsForChanges(r, before, { ...before, publisher: 'Κέδρος,' });
  assert.equal(ops[0]?.op, 'setValue');
  // `applyOps` refuses the whole batch when what is there is not this.
  assert.equal((ops[0] as { from: string }).from, 'Εστία,');
});

test('addresses the occurrence it read, not the first that matches', () => {
  // Two 264s — a reprint records both the original and the reissue. The path
  // must name the one whose value the form displayed.
  const r = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ a: 'Τίτλος' }] },
      { t: '264', i: ' 1', s: [{ b: 'Πρώτος,' }, { c: '1946.' }] },
      { t: '264', i: ' 4', s: [{ c: '©1946' }] },
    ],
  } as never;
  const before = readSimpleFields(r);
  assert.equal(before.publicationYear, '1946.');
  const ops = opsForChanges(r, before, { ...before, publicationYear: '1947.' });
  assert.equal((ops[0] as { path: string }).path, '264[0]$c[0]');
});

test('falls back to 260 on an imported record, and writes back to 260', () => {
  // A record from an older system carries 260, not RDA's 264. The form shows
  // what is there and edits it where it is, rather than silently migrating the
  // record to 264 behind the cataloguer.
  const r = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ a: 'Τίτλος' }] },
      { t: '260', i: '  ', s: [{ b: 'Παλιός,' }, { c: '1970.' }] },
    ],
  } as never;
  const before = readSimpleFields(r);
  assert.equal(before.publisher, 'Παλιός,');
  const ops = opsForChanges(r, before, { ...before, publisher: 'Νέος,' });
  assert.equal((ops[0] as { path: string }).path, '260[0]$b[0]');
});

test('a first value for an absent subfield is an insert, APPENDED', () => {
  // `setValue` resolves a path and fails when it names nothing, so a first
  // value has to be an insert. `at` is a position in the field's subfield
  // array, and the end is the one position that is right without knowing the
  // field's own ordering rules — a `$b` led before the `$a` it qualifies is a
  // title statement that reads backwards.
  const r = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ a: 'Τίτλος' }] },
      { t: '250', i: '  ', s: [{ b: 'επιμέλεια' }] },
    ],
  } as never;
  const before = readSimpleFields(r);
  const ops = opsForChanges(r, before, { ...before, edition: '2η έκδοση.' });
  assert.equal(ops[0]?.op, 'insertSubfield');
  assert.equal((ops[0] as { path: string }).path, '250[0]');
  assert.equal((ops[0] as { at: number }).at, 1, 'appended after the existing subfield');
});

test('a value for a field the record does not have is NOT invented', () => {
  // Creating a 250 from a text box is a cataloguing decision, not an edit, so
  // the builder emits nothing and the screen disables the input (`canEdit`).
  // Emitting an op against a path that resolves to nothing would be a 400 the
  // cataloguer could not act on.
  const r = record();
  const before = readSimpleFields(r);
  assert.deepEqual(opsForChanges(r, before, { ...before, edition: '2η έκδοση.' }), []);
});

test('delete carries the ABSOLUTE position, not the per-code occurrence', () => {
  // Conflating the two is a 409 rather than a wrong edit: `applyOps` reads `at`
  // against the field's whole subfield array and refuses when what is there is
  // not what the op expected to remove. On `245` holding [$a, $c], `$c` is
  // occurrence 0 and position 1. The integration test in
  // apps/api/test/integration/bib-write-path.spec.ts is what caught this.
  const r = record();
  const before = readSimpleFields(r);
  const ops = opsForChanges(r, before, { ...before, publicationYear: '' });
  assert.equal(ops[0]?.op, 'deleteSubfield');
  assert.equal((ops[0] as { path: string }).path, '264[0]$c[0]');
  assert.equal((ops[0] as { at: number }).at, 1, 'the $c sits second in [$b, $c]');
});

test('clearing a value deletes the subfield rather than setting it empty', () => {
  const r = record();
  const before = readSimpleFields(r);
  const ops = opsForChanges(r, before, { ...before, isbn: '' });
  assert.equal(ops[0]?.op, 'deleteSubfield');
  assert.equal((ops[0] as { path: string }).path, '020[0]$a[0]');
});

test('canEdit is false where the field itself is missing', () => {
  // Creating a 264 from a text form is a cataloguing decision — which
  // indicators? which of the three RDA functions? — not an edit.
  const r = {
    leader: '00000nam a2200000 a 4500',
    fields: [{ t: '245', i: '10', s: [{ a: 'Μόνο τίτλος' }] }],
  } as never;
  const publisher = SIMPLE_FIELDS.find((f) => f.key === 'publisher')!;
  assert.equal(canEdit(r, publisher), false);
  const title = SIMPLE_FIELDS.find((f) => f.key === 'title')!;
  assert.equal(canEdit(r, title), true);
});

test('no widget claims a fixed-field position', () => {
  // The language of a record is 008/35-37 — three bytes inside a positional
  // control field whose other bytes must survive being written around. A form
  // that wrote them would be the one way to corrupt a record silently, and it
  // needs the positional editor phase 29 designs.
  for (const f of SIMPLE_FIELDS) {
    assert.ok(/^\d{3}$/.test(f.tag), `${f.key} must name a data field`);
    assert.notEqual(f.tag, '008');
    assert.notEqual(f.tag, '006');
    assert.notEqual(f.tag, '007');
  }
});

test('readField returns null rather than guessing', () => {
  const r = { leader: '00000nam a2200000 a 4500', fields: [] } as never;
  for (const f of SIMPLE_FIELDS) assert.equal(readField(r, f), null);
});
