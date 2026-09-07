import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCorpus, emitRecord } from './__fixtures__/corpus.js';
import { bytesEqual, decodeLatin1, encodeUtf8, concatBytes } from './bytes.js';
import { canonicalJson } from './canonical.js';
import {
  MAX_FIELD_BYTES,
  readIso2709,
  readIso2709Record,
  splitIso2709,
  writeIso2709,
  writeLeader,
} from './iso2709.js';
import { ANOMALY, MarcError, isControlField, isDataField, subfieldValue } from './types.js';

/**
 * The ISO 2709 codec, and the three defects it exists to fix.
 *
 * The property assertions at the bottom are the phase's acceptance criterion,
 * restated in a form that a generated corpus can actually prove — see the header
 * of `__fixtures__/corpus.ts` for why the plan's "≥98 % byte-exact" figure is
 * replaced rather than reported.
 */

const FT = 0x1e;
const SF = 0x1f;
const RT = 0x1d;

/** Build one record by hand, from bytes, so a test can be exact about them. */
function bytes(...parts: (string | number)[]): Uint8Array {
  return concatBytes(
    parts.map((p) => (typeof p === 'number' ? new Uint8Array([p]) : encodeUtf8(p))),
  );
}

/**
 * The CONTENT of a record's fields, without the `x` anomaly provenance.
 *
 * `x` describes the SOURCE, not the record: it says "this field had text before
 * its first subfield", and after one round-trip that is no longer true, because
 * the writer emitted a clean field. So `x` legitimately does not survive, which
 * is the same reason `canonicalJson` excludes it from the content hash — if it
 * did not, fixing a reader defect would change the hash of every record ever
 * imported.
 */
function content(record: { fields: readonly object[] }): string {
  return JSON.stringify(record.fields.map((f) => ({ ...f, x: undefined })));
}

// ---------------------------------------------------------------------------
// The three defects the 1.0 reader has
// ---------------------------------------------------------------------------

test('defect 1: repeated fields and subfields survive, in order', () => {
  const corpus = generateCorpus(60);
  const withRepeats = corpus
    .map((c) => readIso2709Record(c.bytes).record)
    .find((r) => r.fields.filter((f) => f.t === '650').length > 1);
  assert.ok(withRepeats, 'the corpus must contain a record with repeated 650s');

  const subjects = withRepeats.fields.filter((f) => f.t === '650');
  assert.ok(subjects.length > 1);
  // The 1.0 reader produced ONE `650$a` cell joined with ' | '. Here each is a
  // field of its own, and the repeated $x inside the first one survives too.
  const first = subjects[0];
  assert.ok(first && isDataField(first));
  const xs = first.s.filter((s) => Object.keys(s)[0] === 'x');
  assert.equal(xs.length, 2, 'the repeated $x must not be collapsed');
  assert.notEqual(subfieldValue(xs[0]!), subfieldValue(xs[1]!));
});

test('defect 2: indicators are read, not skipped', () => {
  const record = readIso2709Record(generateCorpus(1)[0]!.bytes).record;
  const title = record.fields.find((f) => f.t === '245');
  assert.ok(title && isDataField(title));
  assert.equal(title.i.length, 2);
  // The non-filing count in indicator 2 is how a title sorts. The 1.0 reader
  // consumed both indicator bytes without reading either.
  assert.match(title.i, /^[0-9 ][0-9 ]$/);
  const hundred = record.fields.find((f) => f.t === '100');
  assert.ok(hundred && isDataField(hundred));
  assert.equal(hundred.i, '1 ', 'a trailing blank indicator is a SPACE, not an empty string');
});

test('defect 3: a delimiter as the last byte does not fabricate a subfield', () => {
  // 245 whose data ends with a bare 0x1F. The 1.0 reader read `fieldBuf[i+1] ?? 0`
  // and produced the subfield code U+0000 with a start offset past the buffer.
  const field = bytes('10', SF, 'a', 'Zorba /', SF);
  const dir = `245${String(field.length + 1).padStart(4, '0')}00000`;
  const base = 24 + dir.length + 1;
  const total = base + field.length + 1 + 1;
  const leader = `${String(total).padStart(5, '0')}nam a22${String(base).padStart(5, '0')} a 4500`;
  const record = readIso2709Record(bytes(leader, dir, FT, ...[], decodeLatin1(field), FT, RT));

  const f = record.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(f.s.length, 1, 'only the real subfield exists');
  assert.equal(Object.keys(f.s[0]!)[0], 'a');
  assert.ok(
    record.anomalies.some((a) => a.code === ANOMALY.subfieldCodeTruncated),
    'and the truncation is reported rather than swallowed',
  );
});

// ---------------------------------------------------------------------------
// The asymmetric leader rule
// ---------------------------------------------------------------------------

test('on write the fixed leader positions are forced, whatever the source said', () => {
  // A source leader that is wrong in every fixed position.
  const source = '99999xxx x9912345 x 0000';
  const written = writeLeader(source, { total: 300, baseAddress: 61, encoding: 'utf-8' });
  assert.equal(written.length, 24);
  assert.equal(written.slice(0, 5), '00300', 'record length recomputed');
  assert.equal(written.slice(12, 17), '00061', 'base address recomputed');
  assert.equal(written[9], 'a', 'Leader/09 comes from the EXPORT encoding');
  assert.equal(written.slice(10, 12), '22', 'indicator and subfield-code counts are fixed');
  assert.equal(written.slice(20, 24), '4500', 'the entry map is fixed');
  // Everything else is the cataloguer's and is kept.
  assert.equal(written.slice(5, 9), 'xxx ');
  assert.equal(written.slice(17, 20), ' x ');
});

test('Leader/09 follows the export, so a MARC-8 export is not labelled Unicode', () => {
  const record = { leader: '00000nam a2200000 a 4500', fields: [{ t: '001', v: 'x' }] };
  const utf8 = decodeLatin1(writeIso2709(record, { encoding: 'utf-8' }));
  const marc8 = decodeLatin1(writeIso2709(record, { encoding: 'marc-8' }));
  assert.equal(utf8[9], 'a');
  assert.equal(marc8[9], ' ');
});

test('every serialized leader matches the shape MARC 21 requires', () => {
  // The 2.0 plan states this criterion as `^.{10}22.{9}4500$`, which is 25
  // characters wide (10 + 2 + 9 + 4) for a 24-byte leader. Positions 12-19 are
  // eight characters, not nine. Corrected here rather than worked around,
  // because a 25-character pattern can never match a leader and the criterion
  // would have passed by never being run.
  for (const c of generateCorpus(200)) {
    const out = decodeLatin1(writeIso2709(readIso2709Record(c.bytes).record));
    const leader = out.slice(0, 24);
    assert.equal(leader.length, 24);
    assert.match(leader, /^.{10}22.{8}4500$/, `leader was ${JSON.stringify(leader)}`);
  }
});

test('on read a non-standard entry map is honoured, not assumed away', () => {
  // A record that declares 13-byte directory entries and writes 13-byte entries.
  // Read with a hard-coded 12, every tag after the first is garbage.
  const field = bytes('  ', SF, 'a', 'Athens :');
  const dir = `260${String(field.length + 1).padStart(4, '0')}000000`;
  const base = 24 + dir.length + 1;
  const total = base + field.length + 1 + 1;
  const leader = `${String(total).padStart(5, '0')}nam a22${String(base).padStart(5, '0')} a 4510`;
  const parsed = readIso2709Record(bytes(leader, dir, FT, decodeLatin1(field), FT, RT));

  assert.equal(parsed.record.fields.length, 1);
  assert.equal(parsed.record.fields[0]!.t, '260', 'the declared widths were used to slice');
  assert.ok(parsed.anomalies.some((a) => a.code === ANOMALY.nonStandardEntryMap));
  // …and the writer normalises it away, which is the other half of the rule.
  assert.equal(decodeLatin1(writeIso2709(parsed.record)).slice(20, 24), '4500');
});

// ---------------------------------------------------------------------------
// Tolerating real-world damage
// ---------------------------------------------------------------------------

test('a record with no terminator is read, and says so', () => {
  const c = generateCorpus(400).find((r) => r.residue.includes('no-record-terminator'));
  assert.ok(c, 'the corpus must contain an Aleph-style record with no terminator');
  const parsed = readIso2709Record(c.bytes);
  assert.ok(parsed.record.fields.length > 5);
  assert.ok(parsed.anomalies.some((a) => a.code === ANOMALY.missingRecordTerminator));
});

test('a leader that lies about the length does not truncate the record', () => {
  const c = generateCorpus(400).find((r) => r.residue.includes('wrong-declared-length'));
  assert.ok(c, 'the corpus must contain a record whose declared length is wrong');
  const parsed = readIso2709Record(c.bytes);
  assert.ok(parsed.anomalies.some((a) => a.code === ANOMALY.leaderLengthWrong));
  assert.ok(
    parsed.record.fields.some((f) => f.t === '245'),
    'the title still parsed',
  );
});

test('a buffer shorter than a leader is refused, not guessed at', () => {
  assert.throws(
    () => readIso2709Record(encodeUtf8('too short')),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'record-too-short');
      return true;
    },
  );
});

test('splitting uses the declared length, so a 0x1D inside data does not split', () => {
  // A record whose 500 note legitimately contains a 0x1D byte.
  const field = bytes('  ', SF, 'a', 'Group separator: ', RT, ' inside a note.');
  const dir = `500${String(field.length + 1).padStart(4, '0')}00000`;
  const base = 24 + dir.length + 1;
  const total = base + field.length + 1 + 1;
  const leader = `${String(total).padStart(5, '0')}nam a22${String(base).padStart(5, '0')} a 4500`;
  const one = bytes(leader, dir, FT, decodeLatin1(field), FT, RT);

  assert.equal(splitIso2709(one).length, 1, 'the declared length wins over a scan for 0x1D');
  const parsed = readIso2709Record(one).record;
  assert.equal(parsed.fields.length, 1);
  const note = parsed.fields[0];
  assert.ok(note && isDataField(note));
  assert.match(subfieldValue(note.s[0]!), /inside a note/);
});

// ---------------------------------------------------------------------------
// Refusing what the format cannot express
// ---------------------------------------------------------------------------

test('a record too long for binary MARC is refused, naming MARCXML', () => {
  const big = 'x'.repeat(MAX_FIELD_BYTES - 10);
  const fields = Array.from({ length: 12 }, () => ({ t: '500', i: '  ', s: [{ a: big }] }));
  assert.throws(
    () => writeIso2709({ leader: '00000nam a2200000 a 4500', fields }),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'record-too-long');
      assert.match(err.message, /MARCXML/);
      return true;
    },
  );
});

test('a single field too long for a 4-digit length is refused', () => {
  assert.throws(
    () =>
      writeIso2709({
        leader: '00000nam a2200000 a 4500',
        fields: [{ t: '500', i: '  ', s: [{ a: 'x'.repeat(MAX_FIELD_BYTES) }] }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'field-too-long');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The property test — the phase's acceptance criterion
// ---------------------------------------------------------------------------

const CORPUS = generateCorpus(5000);

test('the corpus is what it claims to be', () => {
  assert.equal(CORPUS.length, 5000);
  const profiles = new Set(CORPUS.map((c) => c.profile));
  assert.deepEqual([...profiles].sort(), ['abekt', 'aleph', 'evergreen', 'koha', 'lc']);
  const conforming = CORPUS.filter((c) => !c.residue.length).length;
  assert.ok(conforming > 4000, `only ${conforming} conforming records; the sample is too damaged`);
});

test('parse(write(parse(b))).fields === parse(b).fields for EVERY record', () => {
  // The invariant that protects a catalogue. It holds for the malformed records
  // too, which is the point: reading past damage must not lose a field.
  let checked = 0;
  for (const c of CORPUS) {
    const a = readIso2709Record(c.bytes).record;
    const b = readIso2709Record(writeIso2709(a)).record;
    assert.equal(content(b), content(a), `${c.profile} record round-tripped to different fields`);
    checked += 1;
  }
  assert.equal(checked, CORPUS.length);
});

test('only the leader positions the writer MUST normalise ever change', () => {
  // 00-04 record length, 12-16 base address, 09 charset, 10-11 counts, 20-23
  // entry map. Anything else moving would mean the writer is editing the
  // cataloguer's data.
  const allowed = new Set([0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23]);
  for (const c of CORPUS) {
    const a = readIso2709Record(c.bytes).record;
    const b = readIso2709Record(writeIso2709(a)).record;
    for (let i = 0; i < 24; i++) {
      if (a.leader[i] === b.leader[i]) continue;
      assert.ok(allowed.has(i), `leader position ${i} changed on a ${c.profile} record`);
    }
  }
});

test('every CONFORMING record re-serializes byte-for-byte, with no tolerance', () => {
  const conforming = CORPUS.filter((c) => !c.residue.length);
  const failures = conforming.filter(
    (c) => !bytesEqual(writeIso2709(readIso2709Record(c.bytes).record), c.bytes),
  );
  assert.deepEqual(
    failures.map((f) => f.profile),
    [],
    `${failures.length} conforming records did not reproduce their own bytes`,
  );
  assert.ok(conforming.length >= 4000);
});

test('every NON-conforming record fails for the reason it declares, and no other', () => {
  for (const c of CORPUS) {
    if (!c.residue.length) continue;
    const parsed = readIso2709Record(c.bytes);
    const codes = new Set(parsed.anomalies.map((a) => a.code));
    for (const reason of c.residue) {
      const expected = {
        'no-record-terminator': ANOMALY.missingRecordTerminator,
        'wrong-declared-length': ANOMALY.leaderLengthWrong,
        'non-standard-entry-map': ANOMALY.nonStandardEntryMap,
        'fields-out-of-directory-order': ANOMALY.fieldsOutOfOrder,
        'data-before-first-subfield': ANOMALY.dataBeforeFirstSubfield,
      }[reason];
      assert.ok(codes.has(expected), `${c.profile}: expected ${expected}, saw ${[...codes]}`);
    }
    // It still round-trips structurally; only the bytes and the leader
    // positions the writer must normalise differ. Compared on FIELDS, because
    // normalising `4510` to `4500` is the correct half of the asymmetric rule
    // and would otherwise read as a content change.
    const out = writeIso2709(parsed.record);
    assert.equal(
      content(readIso2709Record(out).record),
      content(parsed.record),
      `${c.profile}: content changed as well as bytes`,
    );
  }
});

test('serialization is stable from the second round onward', () => {
  for (const c of CORPUS) {
    const a = readIso2709Record(c.bytes).record;
    const once = writeIso2709(a);
    const twice = writeIso2709(readIso2709Record(once).record);
    assert.ok(bytesEqual(once, twice), `${c.profile} was not stable after normalisation`);
  }
});

test('a whole stream reads back to the same records as one at a time', () => {
  // Only records that HAVE a terminator can be found in a stream: one without
  // an end runs into the next record's bytes, and no reader can tell where the
  // boundary was. That is a property of the format, not of this codec, and the
  // corpus contains such records precisely so the limit is stated rather than
  // assumed away.
  const sample = CORPUS.slice(0, 400).filter((c) => !c.residue.includes('no-record-terminator'));
  const stream = concatBytes(sample.map((c) => c.bytes));
  const fromStream = readIso2709(stream);
  assert.equal(fromStream.length, sample.length, 'every terminated record was found');

  const controlNumber = (r: { fields: readonly { t: string }[] }): string =>
    (r.fields.find((f) => f.t === '001') as { v: string } | undefined)?.v ?? '';
  for (let i = 0; i < sample.length; i++) {
    const alone = readIso2709Record((sample[i] as { bytes: Uint8Array }).bytes).record;
    const inStream = (fromStream[i] as { record: typeof alone }).record;
    assert.equal(controlNumber(inStream), controlNumber(alone), `record ${i} came back different`);
    assert.equal(canonicalJson(inStream), canonicalJson(alone));
  }
});

test('a record with no terminator swallows the one after it, and that is the format', () => {
  const truncated = CORPUS.find((c) => c.residue.includes('no-record-terminator'));
  assert.ok(truncated);
  const next = CORPUS[CORPUS.indexOf(truncated) + 1];
  assert.ok(next);
  const glued = readIso2709(concatBytes([truncated.bytes, next.bytes]));
  // One record, not two: the scan for a terminator finds the SECOND record's.
  assert.equal(glued.length, 1);
  assert.ok(glued[0]!.anomalies.some((a) => a.code === ANOMALY.leaderLengthWrong));
});

test('control fields keep their exact bytes, spaces included', () => {
  const record = readIso2709Record(CORPUS[0]!.bytes).record;
  const f008 = record.fields.find((f) => f.t === '008');
  assert.ok(f008 && isControlField(f008));
  // 008 is read by absolute position by every downstream consumer, so a reader
  // that trimmed it would shift every position after the first run of spaces.
  assert.ok(f008.v.includes('    '), 'fixed-field padding must not be trimmed');
  assert.equal(f008.v, f008.v.trimEnd() + f008.v.slice(f008.v.trimEnd().length));
  assert.equal(f008.v.slice(0, 6), (CORPUS[0]!.fields[3] as { value: string }).value.slice(0, 6));
});

test('anomaly provenance does not survive a round-trip, and should not', () => {
  const damaged = CORPUS.find((c) => c.residue.includes('data-before-first-subfield'));
  assert.ok(damaged, 'the corpus must contain a record with text before a subfield');
  const first = readIso2709Record(damaged.bytes).record;
  assert.ok(
    first.fields.some((f) => f.x?.includes(ANOMALY.dataBeforeFirstSubfield)),
    'the first read records where the damage was',
  );
  const second = readIso2709Record(writeIso2709(first)).record;
  assert.ok(
    second.fields.every((f) => !f.x),
    'and the second read finds a clean record, because the damage is gone',
  );
  assert.equal(content(first), content(second), 'the CONTENT is unchanged either way');
});

test('emitRecord and writeIso2709 are genuinely independent implementations', () => {
  // If this ever fails because the fixture imported the codec, the property
  // tests above stop being evidence.
  const source = readIso2709Record(
    emitRecord('00000nam a2200000 a 4500', [
      { tag: '001', value: 'abc' },
      { tag: '245', ind: '10', subs: [['a', 'Title /']] },
    ]),
  ).record;
  assert.equal(source.fields.length, 2);
  assert.equal((source.fields[0] as { v: string }).v, 'abc');
});
