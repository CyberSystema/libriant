import assert from 'node:assert/strict';
import test from 'node:test';
import { diff } from './diff.js';
import {
  allocateOccurrence,
  inspectLinkage,
  linkageOf,
  normalizeLinkage,
  parseLinkage,
} from './linkage.js';
import * as opsModule from './ops.js';
import { applyOps, invert, type MarcOp } from './ops.js';
import { exists, formatMarcPath, get, getOne, parseMarcPath, parseOpPath } from './path.js';
import { mulberry32 } from './__fixtures__/corpus.js';
import { MarcError, isDataField, subfieldCode, subfieldValue, type MarcRecord } from './types.js';

/** A small record with the repeats that make every one of these problems real. */
function sample(): MarcRecord {
  return {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '001', v: 'lbr00000001' },
      { t: '008', v: '260907s1946    gr |||||||||||000 0 gre d' },
      { t: '100', i: '1 ', s: [{ a: 'Καζαντζάκης, Νίκος,' }, { d: '1883-1957' }] },
      { t: '245', i: '13', s: [{ a: 'Ο Ζορμπάς /' }, { c: 'Νίκος Καζαντζάκης.' }] },
      { t: '650', i: ' 0', s: [{ a: 'Greek literature' }, { x: 'History.' }] },
      { t: '650', i: ' 0', s: [{ a: 'Crete (Greece)' }, { x: 'Fiction.' }] },
      { t: '650', i: ' 0', s: [{ a: 'Novelists, Greek' }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// The path grammar
// ---------------------------------------------------------------------------

test('the grammar addresses every level a MARC record has', () => {
  const r = sample();
  assert.equal(getOne(r, '001'), 'lbr00000001');
  assert.equal(getOne(r, '008/07-10'), '1946');
  assert.equal(getOne(r, 'LDR/06'), 'a');
  assert.equal(getOne(r, 'LDR'), '00000nam a2200000 a 4500');
  assert.equal(getOne(r, '245$a'), 'Ο Ζορμπάς /');
  assert.equal(getOne(r, '245^2'), '3', 'the non-filing indicator');
  assert.equal(getOne(r, '650[1]$a'), 'Crete (Greece)');
  assert.equal(getOne(r, '650[#]$a'), 'Novelists, Greek');
  assert.deepEqual(get(r, '650[*]$a'), ['Greek literature', 'Crete (Greece)', 'Novelists, Greek']);
  assert.equal(getOne(r, '100$a[0]'), 'Καζαντζάκης, Νίκος,');
  assert.equal(exists(r, '999'), false);
});

test('every path round-trips through parse and format', () => {
  for (const text of [
    'LDR',
    'LDR/06',
    'LDR/00-04',
    '008',
    '008/07-10',
    '008/35-#',
    '245',
    '245[0]',
    '245[#]',
    '245[*]',
    '245^1',
    '245$a',
    '245[0]$a[1]',
    '245$a/00-03',
  ]) {
    assert.equal(formatMarcPath(parseMarcPath(text)), text, text);
  }
});

test('an op path must name exactly one node', () => {
  // Reading tolerates an implicit "the first one"; editing does not, because a
  // path whose meaning depends on a default is a path that means something else
  // in somebody else's tool.
  assert.ok(parseMarcPath('245$a'), 'legal for reading');
  for (const text of ['245$a', '245[0]$a', '650[*]$a', '650[#]$a']) {
    assert.throws(() => parseOpPath(text), MarcError, `${text} must not address an edit`);
  }
  assert.ok(parseOpPath('650[1]$a[0]'), 'fully indexed is fine');
  assert.ok(parseOpPath('LDR/06'), 'the leader does not repeat');
});

test('a malformed path says what is wrong with it, and quotes it', () => {
  for (const [text, why] of [
    ['', /empty/],
    ['24', /three-character tag/],
    ['245[', /unclosed/],
    ['245[x]', /not an index/],
    ['245^3', /\^1 or \^2/],
    ['245$', /no subfield code/],
    ['008/5-2', /ends before it starts/],
    ['LDRx', /only a \/position/],
  ] as const) {
    assert.throws(
      () => parseMarcPath(text),
      (err: unknown) => {
        assert.ok(err instanceof MarcError);
        assert.match(err.message, why);
        assert.ok(err.message.includes(JSON.stringify(text).slice(1, -1)) || text === '');
        return true;
      },
      text,
    );
  }
});

// ---------------------------------------------------------------------------
// applyOps
// ---------------------------------------------------------------------------

test('a batch resolves every path against the ORIGINAL record', () => {
  // The obvious sequential implementation edits the wrong field here: after
  // 650[0] is removed, the old 650[2] has become 650[1].
  const before = sample();
  const ops: MarcOp[] = [
    { op: 'deleteField', at: 4, field: before.fields[4]! },
    { op: 'setValue', path: '650[1]$a[0]', from: 'Crete (Greece)', to: 'Kriti (Greece)' },
  ];
  const after = applyOps(before, ops);
  const subjects = after.fields.filter((f) => f.t === '650');
  assert.equal(subjects.length, 2);
  assert.equal(getOne(after, '650[0]$a'), 'Kriti (Greece)', 'the SECOND original 650 was edited');
  assert.equal(getOne(after, '650[1]$a'), 'Novelists, Greek');
});

test('every SINGLE op is exactly undone by its own inverse', () => {
  // A property over generated ops, not three examples. The naive
  // reverse-and-invert of a BATCH is not this — see the next test.
  const rng = mulberry32(4242);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const before = sample();
    const at = Math.floor(rng() * before.fields.length);
    const f = before.fields[at]!;
    const occ = before.fields.filter((x, j) => x.t === f.t && j < at).length;
    const roll = rng();
    let op: MarcOp;
    if (roll < 0.2) op = { op: 'deleteField', at, field: f };
    else if (roll < 0.4) {
      op = { op: 'insertField', at, field: { t: '500', i: '  ', s: [{ a: 'note' }] } };
    } else if (roll < 0.6) {
      op = { op: 'moveField', from: at, to: Math.floor(rng() * before.fields.length) };
    } else if (roll < 0.75 && isDataField(f)) {
      op = { op: 'setIndicators', path: `${f.t}[${occ}]`, from: f.i, to: '99' };
    } else if (roll < 0.9 && isDataField(f) && f.s.length) {
      const sf = f.s[0]!;
      op = {
        op: 'setValue',
        path: `${f.t}[${occ}]$${subfieldCode(sf)}[0]`,
        from: subfieldValue(sf),
        to: 'CHANGED',
      };
    } else if (roll < 0.94 && isDataField(f) && f.s.length > 1) {
      op = { op: 'deleteSubfield', path: `${f.t}[${occ}]`, at: 1, subfield: f.s[1]! };
    } else if (roll < 0.97) {
      // A retag into a tag the record ALREADY contains, which is the case a
      // path-addressed setTag got wrong.
      op = { op: 'setTag', at, from: f.t, to: '650' };
    } else if (isDataField(f)) {
      op = { op: 'insertSubfield', path: `${f.t}[${occ}]`, at: 0, subfield: { z: 'new' } };
    } else {
      op = { op: 'setValue', path: `${f.t}[${occ}]`, from: f.v, to: 'CHANGED' };
    }

    const after = applyOps(before, [op]);
    const back = applyOps(after, [invert(op)]);
    assert.equal(
      JSON.stringify(back.fields),
      JSON.stringify(before.fields),
      `not restored by its inverse: ${JSON.stringify(op)}`,
    );
    assert.equal(back.leader, before.leader);
    checked += 1;
  }
  assert.equal(checked, 3000);
});

test('a move is splice semantics, which is what makes it invert', () => {
  const before: MarcRecord = {
    leader: '00000nam a2200000 a 4500',
    fields: ['A', 'B', 'C', 'D'].map((a) => ({ t: '500', i: '  ', s: [{ a }] })),
  };
  const letters = (r: MarcRecord): string[] =>
    r.fields.map((f) => (isDataField(f) ? subfieldValue(f.s[0]!) : ''));
  const moved = applyOps(before, [{ op: 'moveField', from: 0, to: 2 }]);
  assert.deepEqual(letters(moved), ['B', 'C', 'A', 'D'], 'out, then in at position 2');
  const back = applyOps(moved, [invert({ op: 'moveField', from: 0, to: 2 })]);
  assert.deepEqual(letters(back), ['A', 'B', 'C', 'D']);
});

test('a batch is NOT undone by inverting its ops, and there is no API that pretends it is', () => {
  // `insertField.at` and `deleteField.at` are POSITIONS resolved against the
  // record the batch was handed, so a batch that both inserts and deletes has no
  // position-preserving inverse. Undoing a batch is a snapshot restore, which is
  // why `marc_record_versions` keeps full snapshots rather than diff chains.
  const before = sample();
  const ops: MarcOp[] = [
    { op: 'insertField', at: 2, field: { t: '041', i: '0 ', s: [{ a: 'gre' }] } },
    { op: 'deleteField', at: 6, field: before.fields[6]! },
  ];
  const after = applyOps(before, ops);
  const naive = applyOps(after, [invert(ops[1]!), invert(ops[0]!)]);
  assert.notEqual(
    JSON.stringify(naive.fields),
    JSON.stringify(before.fields),
    'if this ever starts passing, the batch semantics changed and the docs are wrong',
  );
  // And the module really exports no `invertAll` or `undo` that would invite it.
  // Asserted on the module NAMESPACE — the previous version asserted a property
  // of the local `ops` array, which was unconditionally undefined.
  assert.equal((opsModule as Record<string, unknown>).invertAll, undefined);
  assert.equal((opsModule as Record<string, unknown>).undo, undefined);
});

test('a stale edit is refused rather than applied over somebody else', () => {
  const before = sample();
  assert.throws(
    () =>
      applyOps(before, [
        { op: 'setValue', path: '245[0]$a[0]', from: 'A title nobody wrote', to: 'x' },
      ]),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'precondition-failed');
      assert.match(err.message, /changed since the edit was prepared/);
      return true;
    },
  );
  // …and the record is untouched, because nothing is written until everything
  // has been checked.
  assert.equal(getOne(before, '245$a'), 'Ο Ζορμπάς /');
});

test('a fixed-field write is padded to its range and never grows the field', () => {
  const before = sample();
  // `008[0]`, not `008`: the codec has no format definition, so it cannot know
  // that 008 is non-repeatable. An op path indexes every field level, always.
  const after = applyOps(before, [
    { op: 'setValue', path: '008[0]/07-10', from: '1946', to: '19u' },
  ]);
  const f008 = getOne(after, '008') as string;
  assert.equal(f008.length, (getOne(before, '008') as string).length, '008 must not change length');
  assert.equal(getOne(after, '008/07-10'), '19u ');
  assert.throws(
    () => applyOps(before, [{ op: 'setValue', path: '008[0]/07-10', from: '1946', to: '19460' }]),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'value-too-long');
      return true;
    },
  );
});

test('the leader is editable by position', () => {
  const after = applyOps(sample(), [{ op: 'setValue', path: 'LDR/17', from: ' ', to: '7' }]);
  assert.equal(after.leader[17], '7');
  assert.equal(after.leader.length, 24);
});

// ---------------------------------------------------------------------------
// $6 linkage
// ---------------------------------------------------------------------------

function linked(): MarcRecord {
  return {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '100', i: '1 ', s: [{ 6: '880-07' }, { a: 'Kazantzakis, Nikos,' }] },
      { t: '245', i: '13', s: [{ 6: '880-42' }, { a: 'O Zorbas /' }] },
      { t: '880', i: '1 ', s: [{ 6: '100-07/(S' }, { a: 'Καζαντζάκης, Νίκος,' }] },
      { t: '880', i: '13', s: [{ 6: '245-42/(S' }, { a: 'Ο Ζορμπάς /' }] },
    ],
  };
}

test('$6 is parsed into its four parts', () => {
  assert.deepEqual(parseLinkage('880-07'), { tag: '880', occurrence: '07' });
  assert.deepEqual(parseLinkage('245-42/(S'), { tag: '245', occurrence: '42', script: '(S' });
  assert.deepEqual(parseLinkage('245-42/Grek/r'), {
    tag: '245',
    occurrence: '42',
    script: 'Grek',
    orientation: 'r',
  });
  assert.equal(parseLinkage('245-4'), null, 'the occurrence is two digits');
  assert.equal(parseLinkage('not a link'), null);
});

test('repair leaves a correct, sparse record completely alone', () => {
  // This is the case the plan's literal wording would break: an imported record
  // whose occurrence numbers are 07 and 42 is CORRECT, and rewriting them on
  // first save produces a version nobody asked for.
  const before = linked();
  const after = normalizeLinkage(before, 'repair');
  assert.equal(after, before, 'the same object: nothing needed changing');
});

test('compact renumbers every pair densely, on both sides', () => {
  const after = normalizeLinkage(linked(), 'compact');
  assert.equal(linkageOf(after.fields[0]!)?.occurrence, '01');
  assert.equal(linkageOf(after.fields[2]!)?.occurrence, '01', 'the 880 partner follows it');
  assert.equal(linkageOf(after.fields[1]!)?.occurrence, '02');
  assert.equal(linkageOf(after.fields[3]!)?.occurrence, '02');
  // The script code survives the renumbering.
  assert.equal(linkageOf(after.fields[3]!)?.script, '(S');
});

test('inserting a paired field under compact renumbers every $6 on both sides', () => {
  // The phase's literal acceptance criterion, satisfied by the policy that was
  // written for it.
  const before = linked();
  const after = applyOps(
    before,
    [
      {
        op: 'insertField',
        at: 1,
        field: { t: '246', i: '3 ', s: [{ 6: '880-99' }, { a: 'Zorbas' }] },
      },
      {
        op: 'insertField',
        at: 4,
        field: { t: '880', i: '3 ', s: [{ 6: '246-99/(S' }, { a: 'Ζορμπάς' }] },
      },
    ],
    { linkage: 'compact' },
  );
  // The invariant, not a literal sequence: the numbering is dense from 01, and
  // every occurrence is used by exactly two fields that name each other's tags.
  // (Asserting a literal sequence would only be asserting where `insertField`
  // put the new fields, which is a different test.)
  const occurrences = after.fields.map((f) => linkageOf(f)?.occurrence);
  assert.equal(occurrences.filter(Boolean).length, 6, 'every field is linked');
  assert.deepEqual([...new Set(occurrences)].sort(), ['01', '02', '03'], 'dense from 01');
  const counts = new Map<string, number>();
  for (const o of occurrences) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  assert.deepEqual([...counts.values()], [2, 2, 2], 'each number names exactly one pair');
  for (const [occurrence] of counts) {
    const pair = after.fields.filter((f) => linkageOf(f)?.occurrence === occurrence);
    assert.equal(linkageOf(pair[0]!)?.tag, pair[1]!.t, 'the two members point at each other');
    assert.equal(linkageOf(pair[1]!)?.tag, pair[0]!.t);
  }
});

test('a collision is broken, and 00 is never allocated', () => {
  const colliding: MarcRecord = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ 6: '880-01' }, { a: 'One' }] },
      { t: '880', i: '10', s: [{ 6: '245-01' }, { a: 'Ένα' }] },
      { t: '246', i: '30', s: [{ 6: '880-01' }, { a: 'Two' }] },
      // Deliberately unlinked: 00 means "not linked" and must survive untouched.
      { t: '880', i: '30', s: [{ 6: '246-00' }, { a: 'Δύο' }] },
    ],
  };
  const report = inspectLinkage(colliding);
  assert.deepEqual(report.collisions, ['01']);
  const after = normalizeLinkage(colliding, 'repair');
  assert.equal(linkageOf(after.fields[0]!)?.occurrence, '01', 'the first pair keeps the number');
  assert.equal(linkageOf(after.fields[1]!)?.occurrence, '01');
  assert.equal(linkageOf(after.fields[2]!)?.occurrence, '02', 'the third field is reallocated');
  assert.equal(linkageOf(after.fields[3]!)?.occurrence, '00', 'and 00 is left alone');
});

test('repair moves whole PAIRS, so it never creates a dangling link', () => {
  // Four fields sharing `01` — two genuine pairs. A field-wise reallocation
  // keeps one member of each pair and renumbers the other two, turning two
  // correct pairs into four dangling links. This runs on EVERY applyOps.
  const colliding: MarcRecord = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ 6: '880-01' }, { a: 'One' }] },
      { t: '880', i: '10', s: [{ 6: '245-01' }, { a: 'Ένα' }] },
      { t: '246', i: '30', s: [{ 6: '880-01' }, { a: 'Two' }] },
      { t: '880', i: '30', s: [{ 6: '246-01' }, { a: 'Δύο' }] },
    ],
  };
  const before = inspectLinkage(colliding);
  assert.deepEqual(before.collisions, ['01']);
  assert.equal(before.dangling.length, 0);

  const after = normalizeLinkage(colliding, 'repair');
  const report = inspectLinkage(after);
  assert.equal(report.dangling.length, 0, 'no pair was broken up');
  assert.deepEqual(report.collisions, [], 'and the collision is gone');
  // Both members of each pair carry the same number.
  assert.equal(linkageOf(after.fields[0]!)?.occurrence, linkageOf(after.fields[1]!)?.occurrence);
  assert.equal(linkageOf(after.fields[2]!)?.occurrence, linkageOf(after.fields[3]!)?.occurrence);
  assert.notEqual(linkageOf(after.fields[0]!)?.occurrence, linkageOf(after.fields[2]!)?.occurrence);

  // …and `compact` ends at the same invariant, not a different one.
  const compacted = inspectLinkage(normalizeLinkage(colliding, 'compact'));
  assert.deepEqual(compacted.collisions, []);
  assert.equal(compacted.dangling.length, 0);
});

test('a retag does not shift the fields later ops in the same batch address', () => {
  // The tag change used to be written into the working record during the resolve
  // pass, so `650[1]` meant a different field for every op after it — breaking
  // the one rule the batch has.
  const before = sample();
  // In the ORIGINAL, `650[1]` is Crete at index 5. Had the retag of index 4
  // been written before this op resolved, only two 650s would remain and
  // `650[1]` would have been Novelists — so this `from` is what detects it.
  const after = applyOps(before, [
    { op: 'setTag', at: 4, from: '650', to: '655' },
    { op: 'setValue', path: '650[1]$a[0]', from: 'Crete (Greece)', to: 'CHANGED' },
  ]);
  assert.equal(getOne(after, '655[0]$a'), 'Greek literature');
  assert.equal(getOne(after, '650[0]$a'), 'CHANGED');
  assert.equal(getOne(after, '650[1]$a'), 'Novelists, Greek');
});

test('a fixed-field value shorter than its range round-trips through its inverse', () => {
  const before = sample();
  const op: MarcOp = { op: 'setValue', path: '008[0]/07-10', from: '1946', to: '19u' };
  const after = applyOps(before, [op]);
  assert.equal(getOne(after, '008[0]/07-10'), '19u ', 'padded to the range width on write');
  // …and the inverse's `from` must match the PADDED value, or it fails its own
  // precondition and undo throws.
  const back = applyOps(after, [invert(op)]);
  assert.equal(getOne(back, '008[0]'), getOne(before, '008[0]'));
});

test('a character range past the end of a SUBFIELD is refused, not padded into being', () => {
  // A subfield is variable-length. Growing one to fit a range would change the
  // value the caller thought it was editing.
  assert.throws(
    () => applyOps(sample(), [{ op: 'setValue', path: '245[0]$a[0]/00-99', from: 'x', to: 'y' }]),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'index-out-of-range');
      assert.match(err.message, /not a fixed-width field/);
      return true;
    },
  );
});

test('allocation takes the lowest free number, not the next one up', () => {
  assert.equal(allocateOccurrence(new Set(['01', '03'])), '02');
  assert.equal(allocateOccurrence(new Set()), '01');
  assert.equal(allocateOccurrence(new Set(['00'])), '01', '00 is never free to allocate');
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('deleting one of five repeated fields is ONE change, not five', () => {
  // The failure that makes a version history worthless: index alignment reports
  // the deletion plus a false "changed" for every field after it.
  const before = sample();
  const after = applyOps(before, [{ op: 'deleteField', at: 4, field: before.fields[4]! }]);
  const d = diff(before, after);
  assert.equal(d.fields.length, 1, JSON.stringify(d.fields));
  assert.equal(d.fields[0]!.kind, 'removed');
  assert.equal(d.fields[0]!.tag, '650');
  assert.deepEqual(d.changedTags, ['650']);
  assert.equal(d.verdict, 'changed');
});

test('an identical record is identical, and the derived leader positions are ignored', () => {
  const a = sample();
  const b: MarcRecord = { ...sample(), leader: '01234nam a2200567 a 4500' };
  const d = diff(a, b);
  assert.equal(d.verdict, 'identical', JSON.stringify(d));
  assert.equal(d.leader.length, 0);
});

test('a leader change is reported by NAME, not by position number', () => {
  const a = sample();
  const b: MarcRecord = { ...a, leader: `${a.leader.slice(0, 17)}7${a.leader.slice(18)}` };
  const d = diff(a, b);
  assert.equal(d.leader.length, 1);
  assert.equal(d.leader[0]!.position, 'encodingLevel');
  assert.equal(d.leader[0]!.to, '7');
});

test('a subfield edit is located to the subfield, not the field', () => {
  const before = sample();
  const after = applyOps(before, [
    { op: 'setValue', path: '245[0]$c[0]', from: 'Νίκος Καζαντζάκης.', to: 'N. Kazantzakis.' },
  ]);
  const d = diff(before, after);
  assert.equal(d.fields.length, 1);
  const change = d.fields[0]!;
  assert.equal(change.kind, 'changed');
  assert.deepEqual(change.subfields, [
    {
      kind: 'changed',
      code: 'c',
      occurrence: 1,
      from: 'Νίκος Καζαντζάκης.',
      to: 'N. Kazantzakis.',
    },
  ]);
  assert.equal(change.indicators, undefined, 'the indicators did not change');
});

test('a normalization-only change is classified as such, so it writes no version', () => {
  const before = sample();
  // The same title in NFD instead of NFC.
  const after: MarcRecord = {
    ...before,
    fields: before.fields.map((f) =>
      f.t === '245' && 's' in f ? { ...f, s: [{ a: 'Ο Ζορμπάς /'.normalize('NFD') }, f.s[1]!] } : f,
    ),
  };
  const d = diff(before, after);
  assert.equal(d.verdict, 'normalization-only', JSON.stringify(d.fields));
});

test('a $6 repair is classified as linkage, not as a content edit', () => {
  const before = linked();
  const after = normalizeLinkage(before, 'compact');
  const d = diff(before, after);
  assert.equal(d.verdict, 'linkage-only', JSON.stringify(d.fields));
  assert.ok(d.fields.every((f) => f.class === 'linkage'));
});

test('moving a field is a move, not a removal and an addition', () => {
  const before = sample();
  const after = applyOps(before, [{ op: 'moveField', from: 6, to: 4 }]);
  const d = diff(before, after);
  assert.ok(
    d.fields.some((f) => f.kind === 'moved'),
    `expected a move, got ${JSON.stringify(d.fields.map((f) => f.kind))}`,
  );
  assert.ok(!d.fields.some((f) => f.kind === 'added' || f.kind === 'removed'));
});
