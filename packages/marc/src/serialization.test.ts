import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCorpus } from './__fixtures__/corpus.js';
import {
  canonicalJson,
  canonicalLeader,
  contentHashHex,
  sameContent,
  toNfc,
  toNfd,
} from './canonical.js';
import { readIso2709Record } from './iso2709.js';
import { fromMarcJson, readMarcJson, toMarcJson, writeMarcJson } from './marc-json.js';
import { MARCXML_NAMESPACE, readMarcXml, writeMarcXml, writeMarcXmlRecord } from './marcxml.js';
import { MarcError, isDataField, type MarcRecord } from './types.js';

const SAMPLE: MarcRecord = {
  leader: '00714cam a2200205 a 4500',
  fields: [
    { t: '001', v: 'lbr00000001' },
    { t: '005', v: '20260907141207.0' },
    { t: '008', v: '260907s1946    gr |||||||||||000 0 gre d' },
    { t: '245', i: '13', s: [{ a: 'Ο Ζορμπάς /' }, { c: 'Νίκος Καζαντζάκης.' }] },
    { t: '650', i: ' 0', s: [{ a: 'Fiction' }, { x: 'Greek' }, { x: '20th century' }] },
  ],
};

// ---------------------------------------------------------------------------
// MARCXML
// ---------------------------------------------------------------------------

test('a record round-trips through MARCXML', () => {
  const xml = writeMarcXml(SAMPLE);
  const [back] = readMarcXml(xml);
  assert.ok(back);
  assert.equal(back.record.leader, SAMPLE.leader);
  assert.equal(JSON.stringify(back.record.fields), JSON.stringify(SAMPLE.fields));
});

test('repeated subfields keep their order through MARCXML', () => {
  // `preserveOrder: true` is what makes this true. Without it, fast-xml-parser
  // collapses sibling <subfield> elements and `$x $x` becomes one.
  const [back] = readMarcXml(writeMarcXml(SAMPLE));
  const subject = back!.record.fields.find((f) => f.t === '650');
  assert.ok(subject && isDataField(subject));
  assert.deepEqual(
    subject.s.map((s) => Object.entries(s)[0]),
    [
      ['a', 'Fiction'],
      ['x', 'Greek'],
      ['x', '20th century'],
    ],
  );
});

test('fixed-field padding survives, because the reader does not trim', () => {
  // The 1.0 reader sets `trimValues: true`, which takes a 40-character 008 down
  // to 38 and shifts every position after the first run of spaces.
  const [back] = readMarcXml(writeMarcXml(SAMPLE));
  const f008 = back!.record.fields.find((f) => f.t === '008') as { v: string };
  assert.equal(f008.v, '260907s1946    gr |||||||||||000 0 gre d');
  assert.equal(f008.v.length, 40);
});

test('a blank indicator is a space in both directions', () => {
  const xml = writeMarcXml(SAMPLE);
  assert.match(xml, /ind1=" " ind2="0"/);
  // …and an exporter that writes an EMPTY indicator attribute means a blank.
  const [back] = readMarcXml(
    `<record xmlns="${MARCXML_NAMESPACE}"><leader>${SAMPLE.leader}</leader>` +
      `<datafield tag="245" ind1="" ind2=""><subfield code="a">x</subfield></datafield></record>`,
  );
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(f.i, '  ');
});

test('an empty subfield is a subfield, not an absence', () => {
  const [back] = readMarcXml(
    `<record><leader>${SAMPLE.leader}</leader>` +
      `<datafield tag="245" ind1="1" ind2="0"><subfield code="a"/>` +
      `<subfield code="b">Sub</subfield></datafield></record>`,
  );
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(f.s.length, 2);
  assert.deepEqual(f.s[0], { a: '' });
});

test('the writer escapes the five characters that would change the document', () => {
  const nasty: MarcRecord = {
    leader: SAMPLE.leader,
    fields: [
      {
        t: '500',
        i: '  ',
        s: [{ a: 'A & B <tag> "quoted" \'single\'' }, { b: ']]> and </record>' }],
      },
    ],
  };
  const xml = writeMarcXmlRecord(nasty);
  assert.ok(!xml.includes('<tag>'), 'a literal < would open an element');
  assert.ok(xml.includes('&amp;'));
  assert.ok(xml.includes('&lt;tag&gt;'));
  // The injected `</record>` must appear escaped and NOT as a real close tag:
  // exactly one `</record>` in the document, at the end.
  assert.ok(xml.includes('&lt;/record&gt;'), 'the injected close tag was escaped');
  assert.equal(xml.split('</record>').length - 1, 1, 'exactly one real close tag');
  // …and it reads back as exactly what went in.
  const [back] = readMarcXml(`<collection>${xml}</collection>`);
  assert.equal(JSON.stringify(back!.record.fields), JSON.stringify(nasty.fields));
});

test('characters XML 1.0 forbids are dropped rather than emitted', () => {
  // A 0x1F that survived a bad earlier import is legal MARC and illegal XML —
  // and it cannot be written as a numeric character reference either. Emitting
  // it would produce a document no parser will read.
  const record: MarcRecord = {
    leader: SAMPLE.leader,
    fields: [{ t: '500', i: '  ', s: [{ a: `before${String.fromCharCode(0x1f)}after` }] }],
  };
  const xml = writeMarcXmlRecord(record);
  assert.ok(!xml.includes(String.fromCharCode(0x1f)));
  const [back] = readMarcXml(`<collection>${xml}</collection>`);
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(Object.values(f.s[0]!)[0], 'beforeafter');
});

test('a collection of records reads back as that many records', () => {
  const records = generateCorpus(12).map((c) => readIso2709Record(c.bytes).record);
  const parsed = readMarcXml(writeMarcXml(records));
  assert.equal(parsed.length, records.length);
  for (let i = 0; i < records.length; i++) {
    assert.equal(
      JSON.stringify(parsed[i]!.record.fields),
      JSON.stringify(records[i]!.fields),
      `record ${i}`,
    );
  }
});

test('a document with no records says so rather than returning nothing', () => {
  assert.throws(
    () => readMarcXml('<html><body>Not MARC at all</body></html>'),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'marcxml-no-records');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// MARC-in-JSON
// ---------------------------------------------------------------------------

test('a record round-trips through MARC-in-JSON', () => {
  assert.equal(JSON.stringify(fromMarcJson(toMarcJson(SAMPLE))), JSON.stringify(SAMPLE));
  assert.equal(JSON.stringify(readMarcJson(writeMarcJson(SAMPLE))), JSON.stringify(SAMPLE));
});

test('the exchange shape is Singer’s, not the compact stored one', () => {
  const json = toMarcJson(SAMPLE);
  assert.deepEqual(json.fields[0], { '001': 'lbr00000001' });
  assert.deepEqual(json.fields[3], {
    '245': {
      ind1: '1',
      ind2: '3',
      subfields: [{ a: 'Ο Ζορμπάς /' }, { c: 'Νίκος Καζαντζάκης.' }],
    },
  });
});

test('a value that is not text is refused, not stringified', () => {
  // `String({})` is "[object Object]", and importing that as a title is worse
  // than refusing the record.
  for (const value of [{}, [], null]) {
    assert.throws(
      () =>
        fromMarcJson({
          leader: SAMPLE.leader,
          fields: [{ '245': { ind1: '1', ind2: '0', subfields: [{ a: value }] } }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof MarcError);
        assert.equal(err.code, 'marc-json-shape');
        return true;
      },
      JSON.stringify(value),
    );
  }
  // A number or a boolean is what a JSON encoder makes of a control number or a
  // flag, and converting those is a kindness rather than a guess.
  const ok = fromMarcJson({
    leader: SAMPLE.leader,
    fields: [{ '245': { ind1: '1', ind2: '0', subfields: [{ a: 12345 }] } }],
  });
  const first = ok.fields[0];
  assert.ok(first && isDataField(first));
  assert.deepEqual(first.s[0], { a: '12345' });
});

test('a short leader is repaired at the boundary, not left to look like an edit', () => {
  const short = fromMarcJson({ leader: '00714cam', fields: [] });
  assert.equal(short.leader.length, 24);
  assert.equal(short.leader.slice(0, 8), '00714cam');
});

test('numeric character references are expanded, not kept as text', () => {
  // A great many exporters escape non-ASCII, so a Greek title arrives as
  // `&#x0391;`. Kept literal it is well-formed XML and a wrong record.
  const [back] = readMarcXml(
    `<record><leader>${SAMPLE.leader}</leader>` +
      `<datafield tag="245" ind1="1" ind2="0">` +
      `<subfield code="a">&#x0391;&#952;&#942;&#957;&#945; &amp; more</subfield>` +
      `</datafield></record>`,
  );
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(Object.values(f.s[0]!)[0], 'Αθήνα & more');
});

test('a multi-line value is not re-indented by the collection wrapper', () => {
  // The writer used to indent a collection by splitting each serialized record
  // on newlines, which injected the indent into the middle of any value that
  // contained one — a 505 contents note, which is where they live.
  const note = 'Line one\nLine two\nLine three';
  const record: MarcRecord = {
    leader: SAMPLE.leader,
    fields: [{ t: '505', i: '0 ', s: [{ a: note }] }],
  };
  const [back] = readMarcXml(writeMarcXml([record, record]));
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(Object.values(f.s[0]!)[0], note);
});

test('a carriage return survives, because XML would otherwise normalise it away', () => {
  const value = `CR${String.fromCharCode(13)}here`;
  const record: MarcRecord = {
    leader: SAMPLE.leader,
    fields: [{ t: '500', i: '  ', s: [{ a: value }] }],
  };
  const xml = writeMarcXmlRecord(record);
  assert.ok(xml.includes('&#13;'), 'a literal CR would be read back as a line feed');
  const [back] = readMarcXml(`<collection>${xml}</collection>`);
  const f = back!.record.fields[0];
  assert.ok(f && isDataField(f));
  assert.equal(Object.values(f.s[0]!)[0], value);
});

test('a collapsed field object is refused, because it has already lost data', () => {
  // `{"650": {...}, "651": {...}}` in one entry cannot represent two 650s, and a
  // reader that accepted it would silently import a shorter record.
  assert.throws(
    () => fromMarcJson({ leader: SAMPLE.leader, fields: [{ '001': 'a', '003': 'b' }] }),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'marc-json-shape');
      assert.match(err.message, /exactly one key/);
      return true;
    },
  );
});

test('repeated fields survive the exchange shape', () => {
  const two: MarcRecord = {
    leader: SAMPLE.leader,
    fields: [
      { t: '650', i: ' 0', s: [{ a: 'One' }] },
      { t: '650', i: ' 0', s: [{ a: 'Two' }] },
    ],
  };
  const back = fromMarcJson(toMarcJson(two));
  assert.equal(back.fields.length, 2);
  assert.equal(JSON.stringify(back.fields), JSON.stringify(two.fields));
});

// ---------------------------------------------------------------------------
// The canonical form and the hash
// ---------------------------------------------------------------------------

test('005 is omitted from the hash, so a re-stamp is not a change', () => {
  const stamped: MarcRecord = {
    ...SAMPLE,
    fields: SAMPLE.fields.map((f) => (f.t === '005' ? { t: '005', v: '20991231235959.0' } : f)),
  };
  assert.ok(sameContent(SAMPLE, stamped));
  const without: MarcRecord = { ...SAMPLE, fields: SAMPLE.fields.filter((f) => f.t !== '005') };
  assert.ok(sameContent(SAMPLE, without), 'and a record that never had one hashes the same');
});

test('NFC and NFD spellings of the same title are the same record', async () => {
  const nfd = toNfd(SAMPLE);
  const nfc = toNfc(SAMPLE);
  assert.notEqual(JSON.stringify(nfd.fields), JSON.stringify(nfc.fields), 'the strings differ');
  assert.ok(sameContent(nfd, nfc), 'but the canonical form does not');
  assert.equal(await contentHashHex(nfd), await contentHashHex(nfc));
});

test('the derived leader positions are zeroed, the rest are hashed', () => {
  const canonical = canonicalLeader('00714cam a2200205 a 4500');
  assert.equal(canonical.slice(0, 5), '00000', 'record length');
  assert.equal(canonical.slice(12, 17), '00000', 'base address');
  assert.equal(canonical.slice(5, 12), 'cam a22');
  assert.equal(canonical.slice(17), ' a 4500');
  assert.equal(canonical.length, 24);

  // A record that round-tripped through ISO 2709 has different bytes there and
  // must hash the same.
  const grown: MarcRecord = { ...SAMPLE, leader: '99999cam a2299999 a 4500' };
  assert.ok(sameContent(SAMPLE, grown));
  // …but a change to the encoding level is a real change.
  const levelled: MarcRecord = { ...SAMPLE, leader: '00714cam a2200205 7 4500' };
  assert.ok(!sameContent(SAMPLE, levelled));
});

test('field ORDER is part of the record identity', () => {
  const swapped: MarcRecord = {
    ...SAMPLE,
    fields: [SAMPLE.fields[3]!, SAMPLE.fields[0]!, ...SAMPLE.fields.slice(1, 3), SAMPLE.fields[4]!],
  };
  assert.ok(!sameContent(SAMPLE, swapped));
});

test('the canonical form does not depend on how the object was built', () => {
  // `JSON.stringify` preserves insertion order, so `{t, i, s}` and `{i, s, t}`
  // are different strings for identical content. This is why the canonicalizer
  // writes the keys itself.
  const reordered: MarcRecord = {
    leader: SAMPLE.leader,
    fields: SAMPLE.fields.map((f) =>
      isDataField(f) ? ({ s: f.s, i: f.i, t: f.t } as typeof f) : ({ v: f.v, t: f.t } as typeof f),
    ),
  };
  assert.notEqual(
    JSON.stringify(reordered.fields),
    JSON.stringify(SAMPLE.fields),
    'the raw objects really are different strings',
  );
  assert.equal(canonicalJson(reordered), canonicalJson(SAMPLE));
});

test('anomaly provenance is not part of the identity', () => {
  // Otherwise fixing a reader defect would change the hash of every record ever
  // imported.
  const flagged: MarcRecord = {
    ...SAMPLE,
    fields: SAMPLE.fields.map((f) =>
      f.t === '245' ? { ...f, x: ['data-before-first-subfield'] } : f,
    ),
  };
  assert.ok(sameContent(SAMPLE, flagged));
});

test('the hash is a 64-character hex SHA-256 and is stable', async () => {
  const hex = await contentHashHex(SAMPLE);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(hex, await contentHashHex(SAMPLE));
  const changed: MarcRecord = {
    ...SAMPLE,
    fields: SAMPLE.fields.map((f) =>
      f.t === '245' && isDataField(f) ? { ...f, s: [{ a: 'Something else' }, f.s[1]!] } : f,
    ),
  };
  assert.notEqual(hex, await contentHashHex(changed));
});

test('every corpus record survives all three serializations identically', () => {
  for (const c of generateCorpus(300)) {
    const record = readIso2709Record(c.bytes).record;
    const viaXml = readMarcXml(writeMarcXml(record))[0]!.record;
    const viaJson = readMarcJson(writeMarcJson(record));
    assert.equal(canonicalJson(viaXml), canonicalJson(record), `${c.profile} via MARCXML`);
    assert.equal(canonicalJson(viaJson), canonicalJson(record), `${c.profile} via MARC-in-JSON`);
  }
});
