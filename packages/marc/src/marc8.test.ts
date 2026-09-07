import assert from 'node:assert/strict';
import test from 'node:test';
import { concatBytes, decodeLatin1, encodeUtf8 } from './bytes.js';
import { readIso2709Record } from './iso2709.js';
import { canEncodeMarc8, decodeMarc8, encodeMarc8, newMarc8State } from './marc8.js';
import { MARC8_SET, readEscape, writeEscape } from './marc8-sets.js';
import { BASIC_LATIN, EXTENDED_LATIN, SUPPORTED_TABLES } from './marc8-tables.js';
import { mulberry32 } from './__fixtures__/corpus.js';
import { ANOMALY, MarcError, isDataField, subfieldValue } from './types.js';

/**
 * MARC-8.
 *
 * Four of these tests exist because the tables are HAND-AUTHORED and there is no
 * second implementation on this machine to check them against (no MARC library
 * is installed, and `TextDecoder` has no `ansel` or `marc-8`). They cannot prove
 * the table matches LC's — nothing here can, without LC's `codetables.xml` — but
 * each rules out a whole class of transcription error:
 *
 *   1. **Unicode property** — every byte in the combining range must map to a
 *      character Unicode itself classifies as a non-spacing mark. Catches a mark
 *      mapped to a spacing character, and a digit transposed into a different
 *      block.
 *   2. **Bijectivity** — every byte decodes and re-encodes to itself. Catches two
 *      MARC-8 bytes accidentally mapped to the same Unicode string.
 *   3. **Normalization stability** — a combining target must be inert under NFD,
 *      which pins the U+FE20-FE23 rows specifically.
 *   4. **No overlap between the two registers** — Basic Latin's bytes and ANSEL's
 *      must not collide, or the register a byte belongs to becomes ambiguous.
 *
 * The residue — "does this table agree with LC" — is irreducible here and is
 * recorded as a phase-7 divergence rather than implied away.
 */

const ESC = 0x1b;

// ---------------------------------------------------------------------------
// The escape-sequence grammar
// ---------------------------------------------------------------------------

test('both spellings of each intermediate designate the same register', () => {
  // `(` and `,` both mean G0; `)` and `-` both mean G1. A decoder that handles
  // only one of each reads half the world's records and silently mis-renders
  // the other half.
  for (const [intermediate, register] of [
    [0x28, 'G0'],
    [0x2c, 'G0'],
    [0x29, 'G1'],
    [0x2d, 'G1'],
  ] as const) {
    const esc = readEscape(new Uint8Array([ESC, intermediate, 0x53]), 0);
    assert.ok(esc, `ESC ${String.fromCharCode(intermediate)} S must parse`);
    assert.equal(esc.register, register);
    assert.equal(esc.set, MARC8_SET.basicGreek);
    assert.equal(esc.length, 3);
  }
});

test('technique 1 is four single-byte shorthands, all of them G0', () => {
  for (const [byte, set] of [
    [0x73, MARC8_SET.basicLatin],
    [0x67, MARC8_SET.greekSymbols],
    [0x62, MARC8_SET.subscripts],
    [0x70, MARC8_SET.superscripts],
  ] as const) {
    const esc = readEscape(new Uint8Array([ESC, byte]), 0);
    assert.ok(esc);
    assert.equal(esc.register, 'G0', 'no technique-1 form touches G1');
    assert.equal(esc.set, set);
    assert.equal(esc.length, 2);
  }
});

test('the multibyte forms are recognised at both widths', () => {
  const short = readEscape(new Uint8Array([ESC, 0x24, 0x31]), 0);
  assert.deepEqual(short, { length: 3, register: 'G0', set: '1', multibyte: true });
  const long = readEscape(new Uint8Array([ESC, 0x24, 0x29, 0x31]), 0);
  assert.deepEqual(long, { length: 4, register: 'G1', set: '1', multibyte: true });
});

test('a truncated escape at the end of a field is not read past the buffer', () => {
  // The same shape of defect as the 1.0 reader's subfield code, three and four
  // bytes deep.
  assert.equal(readEscape(new Uint8Array([ESC]), 0), null);
  assert.equal(readEscape(new Uint8Array([ESC, 0x28]), 0), null);
  assert.equal(readEscape(new Uint8Array([ESC, 0x24, 0x29]), 0), null);
});

test('writeEscape round-trips through readEscape', () => {
  for (const register of ['G0', 'G1'] as const) {
    for (const set of Object.values(MARC8_SET)) {
      const bytes = writeEscape(register, set);
      const back = readEscape(bytes, 0);
      assert.ok(back, `${register} ${set}`);
      assert.equal(back.register, register);
      assert.equal(back.set, set);
      assert.equal(back.length, bytes.length);
    }
  }
});

// ---------------------------------------------------------------------------
// The table checks
// ---------------------------------------------------------------------------

test('check 1: every combining byte maps to something Unicode calls a mark', () => {
  const MARK = /^(?:\p{Mn}|\p{Me})+$/u;
  for (const byte of EXTENDED_LATIN.combining) {
    const mapped = EXTENDED_LATIN.map.get(byte);
    assert.ok(mapped, `0x${byte.toString(16)} is listed as combining but has no mapping`);
    assert.match(
      mapped,
      MARK,
      `0x${byte.toString(16)} maps to ${JSON.stringify(mapped)}, which Unicode does not call a mark`,
    );
  }
  // …and nothing OUTSIDE the combining set maps to a mark.
  for (const [byte, mapped] of EXTENDED_LATIN.map) {
    if (EXTENDED_LATIN.combining.has(byte)) continue;
    assert.doesNotMatch(mapped, MARK, `0x${byte.toString(16)} is a mark but is not listed as one`);
  }
});

test('check 2: every byte in every supported set decodes and re-encodes to itself', () => {
  for (const table of SUPPORTED_TABLES) {
    for (const [byte, text] of table.map) {
      const decoded = decodeMarc8(new Uint8Array([byte]));
      assert.equal(decoded.text, text, `0x${byte.toString(16)} in ${table.name}`);
      const encoded = encodeMarc8(text);
      assert.deepEqual(
        [...encoded],
        [byte],
        `${JSON.stringify(text)} did not encode back to 0x${byte.toString(16)}`,
      );
    }
  }
});

test('check 2b: no two bytes map to the same string', () => {
  const seen = new Map<string, string>();
  for (const table of SUPPORTED_TABLES) {
    for (const [byte, text] of table.map) {
      const where = `${table.set}:0x${byte.toString(16)}`;
      const previous = seen.get(text);
      assert.equal(previous, undefined, `${JSON.stringify(text)} is both ${previous} and ${where}`);
      seen.set(text, where);
    }
  }
});

test('check 3: every combining target is inert under NFD and NFC', () => {
  for (const byte of EXTENDED_LATIN.combining) {
    const mark = EXTENDED_LATIN.map.get(byte) as string;
    assert.equal(mark.normalize('NFD'), mark, `0x${byte.toString(16)} decomposes`);
    assert.equal(mark.normalize('NFC'), mark, `0x${byte.toString(16)} composes on its own`);
  }
});

test('check 5: an uppercase Latin letter has its lowercase in the table too', () => {
  // The check that closes the class rather than the two rows. `Ơ` and `Ư` were
  // in ANSEL and `ơ` and `ư` were missing, so every Vietnamese lowercase horn
  // was unencodable — and nothing noticed, because no other check looks across
  // rows. `ı` is excluded: its uppercase `I` lives in Basic Latin, and `Ð` has
  // no ANSEL lowercase.
  const values = new Set(EXTENDED_LATIN.map.values());
  const exempt = new Set(['ı', 'ß', 'ð', 'þ']);
  for (const value of values) {
    if (value.length !== 1 || exempt.has(value)) continue;
    const lower = value.toLowerCase();
    if (lower === value) continue;
    assert.ok(
      values.has(lower) || BASIC_LATIN.map.has(lower.charCodeAt(0)),
      `${value} is in ANSEL but ${lower} is in neither table`,
    );
  }
});

test('check 4: the two supported sets occupy disjoint byte ranges', () => {
  for (const byte of BASIC_LATIN.map.keys()) {
    assert.ok(byte >= 0x20 && byte <= 0x7e, `Basic Latin 0x${byte.toString(16)} is outside G0`);
    assert.ok(!EXTENDED_LATIN.map.has(byte), `0x${byte.toString(16)} is in both sets`);
  }
  for (const byte of EXTENDED_LATIN.map.keys()) {
    assert.ok(byte >= 0xa0 && byte <= 0xfe, `ANSEL 0x${byte.toString(16)} is outside G1`);
  }
});

// ---------------------------------------------------------------------------
// Combining marks
// ---------------------------------------------------------------------------

test('a combining mark precedes its base in MARC-8 and follows it in Unicode', () => {
  // 0xE2 is the acute accent, 0x61 is `a`.
  assert.equal(decodeMarc8(new Uint8Array([0xe2, 0x61])).text, 'á');
  // …and the encoder puts it back in front.
  assert.deepEqual([...encodeMarc8('á')], [0xe2, 0x61]);
  // A precomposed character decomposes first: ANSEL has `a` and an acute, not `á`.
  assert.deepEqual([...encodeMarc8('á')], [0xe2, 0x61]);
});

test('a run of marks all attach to the one base that follows them', () => {
  // cedilla, acute, then `e` — "e with an acute and a cedilla" is three bytes.
  const decoded = decodeMarc8(new Uint8Array([0xf0, 0xe2, 0x65]));
  assert.equal(decoded.text, 'ȩ́');
  assert.deepEqual([...encodeMarc8(decoded.text)], [0xf0, 0xe2, 0x65]);
});

test('the double-diacritic halves land on DIFFERENT base characters', () => {
  // Interleaved, which is how a conforming encoder writes it:
  // ligature-left, `t`, ligature-right, `s`.
  const interleaved = decodeMarc8(new Uint8Array([0xeb, 0x74, 0xec, 0x73]));
  assert.equal(interleaved.text, 't︠s︡');

  // Both halves FIRST, which real files also contain. The general
  // one-mark-one-base rule would put both on the `t`; the dedicated pass carries
  // the right half to the `s`.
  const upfront = decodeMarc8(new Uint8Array([0xeb, 0xec, 0x74, 0x73]));
  assert.equal(upfront.text, 't︠s︡', 'the right half must move to the next base');

  const doubleTilde = decodeMarc8(new Uint8Array([0xfa, 0xfb, 0x6e, 0x67]));
  assert.equal(doubleTilde.text, 'n︢g︣');
});

test('U+FE20 blocks composition, so its position relative to another mark matters', () => {
  // Measured Unicode behaviour, and the reason the halves get their own pass:
  // normalization cannot repair a wrong order here, it just produces a
  // different, valid-looking, permanently different string.
  assert.notEqual('a︠́'.normalize('NFC'), 'á︠'.normalize('NFC'));
  assert.equal('á︠'.normalize('NFC'), 'á︠');
});

// ---------------------------------------------------------------------------
// The designation reset — the phase's named acceptance vector
// ---------------------------------------------------------------------------

test('a designation lasts to the end of the field and no further', () => {
  const state = newMarc8State();
  // ANSEL designated into G0, where Basic Latin normally sits.
  decodeMarc8(new Uint8Array([ESC, 0x28, 0x45]), state);
  assert.equal(state.g0, MARC8_SET.extendedLatin, 'the escape took effect');
  // The SAME state serves the next subfield of the same field.
  decodeMarc8(new Uint8Array([0x61]), state);
  assert.equal(state.g0, MARC8_SET.extendedLatin, 'and survives a subfield boundary');
  // A new field starts clean.
  assert.equal(newMarc8State().g0, MARC8_SET.basicLatin);
});

test('an escape in $a is still in force in $b of the same field', () => {
  // The subfield code byte must NOT go through the state machine: `a` is 0x61,
  // inside G0's invocation range, so a decoder run over the raw field buffer
  // would translate every subfield code.
  const state = newMarc8State();
  const first = decodeMarc8(new Uint8Array([ESC, 0x28, 0x45, 0xa5]), state);
  const second = decodeMarc8(new Uint8Array([0xa5]), state);
  assert.equal(first.text, 'Æ');
  assert.equal(second.text, 'Æ', 'the G1 designation is unchanged, and $b decodes the same');
});

test('a Greek field followed by a Latin field: the second one is not mis-designated', () => {
  // The plan's vector is a Greek 245 followed by a Latin 260. Basic Greek is not
  // a table this build ships (see marc8-tables.ts), so the identical mechanism
  // is exercised with a set that IS shipped: ANSEL designated into G0 in the
  // first field must not leak into the second.
  //
  // Without the per-field reset, `Oxford` in the 260 would be looked up in
  // whatever the 245 left in G0 — no invalid byte, no error, just a wrong record.
  const field245 = concatBytes([
    encodeUtf8('10'),
    new Uint8Array([0x1f, 0x61, ESC, 0x28, 0x45, 0xa5, 0xa2]),
  ]);
  const field260 = concatBytes([
    encodeUtf8('  '),
    new Uint8Array([0x1f, 0x61]),
    encodeUtf8('Oxford'),
  ]);
  const dir =
    `245${String(field245.length + 1).padStart(4, '0')}00000` +
    `260${String(field260.length + 1).padStart(4, '0')}${String(field245.length + 1).padStart(5, '0')}`;
  const base = 24 + dir.length + 1;
  const total = base + field245.length + field260.length + 2 + 1;
  // Leader/09 is a SPACE: this record is MARC-8.
  const leader = `${String(total).padStart(5, '0')}nam  22${String(base).padStart(5, '0')}   4500`;
  const bytes = concatBytes([
    encodeUtf8(leader),
    encodeUtf8(dir),
    new Uint8Array([0x1e]),
    field245,
    new Uint8Array([0x1e]),
    field260,
    new Uint8Array([0x1e, 0x1d]),
  ]);

  const parsed = readIso2709Record(bytes);
  const title = parsed.record.fields.find((f) => f.t === '245');
  const imprint = parsed.record.fields.find((f) => f.t === '260');
  assert.ok(title && isDataField(title));
  assert.ok(imprint && isDataField(imprint));
  // 0xA5 and 0xA2 in ANSEL: Æ and Ø. Read through Basic Latin they would be two
  // bytes with no meaning at all.
  assert.equal(subfieldValue(title.s[0]!), 'ÆØ', 'the escaped field decoded through ANSEL in G0');
  assert.equal(
    subfieldValue(imprint.s[0]!),
    'Oxford',
    'and the NEXT field started from Basic Latin again',
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('an unsupported graphic set is named, replaced visibly, and never guessed', () => {
  // ESC ( S designates Basic Greek, which this build has no table for.
  const decoded = decodeMarc8(new Uint8Array([ESC, 0x28, 0x53, 0x61, 0x62]));
  assert.ok(decoded.anomalies.includes(ANOMALY.marc8UnsupportedCharset));
  assert.equal(decoded.text, '��', 'visibly wrong beats plausibly wrong');
});

test('the ! intermediate is accepted, not read as a set called "!"', () => {
  // `ESC ) ! E` designates ANSEL into G1 in some LC registrations. Read without
  // the 0x21, the sequence designates a set named "!", consumes three bytes, and
  // leaves the real final byte `E` to appear as literal text in the field.
  const esc = readEscape(new Uint8Array([ESC, 0x29, 0x21, 0x45]), 0);
  assert.deepEqual(esc, { length: 4, register: 'G1', set: 'E', multibyte: false });
  const decoded = decodeMarc8(new Uint8Array([ESC, 0x29, 0x21, 0x45, 0xa5]));
  assert.equal(decoded.text, 'Æ', 'no stray E, and ANSEL really was designated');
});

test('the encoder refuses a character MARC-8 cannot express, naming it', () => {
  assert.equal(canEncodeMarc8('Zorba'), true);
  assert.equal(canEncodeMarc8('Ζορμπάς'), false);
  assert.throws(
    () => encodeMarc8('Ζορμπάς'),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'marc8-unencodable');
      assert.match(err.message, /U\+0396/, 'the offending character is named');
      assert.match(err.message, /UTF-8 or MARCXML/, 'and the way out is stated');
      return true;
    },
  );
});

test('a stray ESC costs one character, not the record', () => {
  // 0x41 is not a technique-1 final and not an intermediate, so this is not an
  // escape sequence at all. (0x62 would have been: `ESC b` designates
  // Subscripts, which is why picking a byte at random for this test is wrong.)
  const decoded = decodeMarc8(new Uint8Array([0x61, ESC, 0x41, 0x62]));
  assert.ok(decoded.anomalies.includes(ANOMALY.marc8UnmappedByte));
  assert.equal(decoded.text, 'aAb', 'the ESC is dropped and the data around it survives');
});

test('encoding never REORDERS marks, only composes where the table needs it', () => {
  // 0xF2 is a dot below (combining class 220) and 0xF0 a cedilla (202). NFC
  // sorts marks by class, so `.normalize('NFC')` swaps them — and an encoder
  // that normalized would emit different bytes from the ones it read, for a
  // record nobody edited. Found by fuzzing decode→encode over random bytes: 22
  // of 4,622 clean decodes came back reordered.
  const source = new Uint8Array([0xf2, 0xf0, 0x6c]);
  const decoded = decodeMarc8(source);
  assert.deepEqual([...encodeMarc8(decoded.text)], [...source], 'byte-identical, marks in order');
  assert.notEqual(
    decoded.text.normalize('NFC'),
    decoded.text,
    'and NFC really would have changed it',
  );

  // Composition IS applied where the table needs it: ANSEL has `Ơ` as one byte
  // and no combining horn, so the decomposed spelling must still encode.
  assert.deepEqual([...encodeMarc8('Ơ')], [0xac]);
  assert.deepEqual([...encodeMarc8('O\u031B')], [0xac], 'composed for the lookup');
});

test('decode then encode is byte-identical for every encodable input', () => {
  // A property over genuinely varied input. The first version drew its bytes
  // from `(seed * K + k * K2) % 256`, which is periodic in `k`: it produced 76
  // DISTINCT inputs out of 4,000 iterations, none longer than six bytes, and its
  // count assertion passed anyway. A real PRNG, independent bytes, longer
  // strings, and a floor on DISTINCT inputs rather than on iterations.
  const rng = mulberry32(31337);
  const seen = new Set<string>();
  let unencodable = 0;
  for (let i = 0; i < 60000; i++) {
    const n = 1 + Math.floor(rng() * 20);
    const b = new Uint8Array(n).map(() => Math.floor(rng() * 256));
    const first = decodeMarc8(b);
    if (first.anomalies.length) continue;
    let re: Uint8Array;
    try {
      re = encodeMarc8(first.text);
    } catch {
      unencodable += 1;
      continue;
    }
    assert.deepEqual([...re], [...b], `bytes changed for [${[...b]}]`);
    seen.add(b.join(','));
  }
  // Most random byte strings decode with an anomaly (an unmapped byte) and are
  // skipped, so the yield is low by construction — around 2,900 distinct clean
  // inputs from 60,000 draws. The floor is on DISTINCT inputs because that is
  // what the previous version got wrong.
  assert.ok(
    seen.size > 2000,
    `only ${seen.size} DISTINCT inputs reached the assertion (${unencodable} unencodable)`,
  );
});

test('precomposed horn letters encode, because ANSEL holds the byte', () => {
  // `Ớ` is O + horn + acute. ANSEL has the acute and it has `Ơ`, but it has NO
  // combining horn — so neither the whole cluster nor its pieces encode, and the
  // encoder refused a character its own table contains. The base is composed
  // with each following mark in turn, and the rest stay ordinary marks.
  for (const [text, expected] of [
    ['Ơ', [0xac]],
    ['ơ', [0xbc]],
    ['Ư', [0xad]],
    ['ư', [0xbd]],
    ['Ớ', [0xe2, 0xac]],
    ['ờ', [0xe1, 0xbc]],
    ['Ự', [0xf2, 0xad]],
    ['ữ', [0xe4, 0xbd]],
  ] as const) {
    assert.deepEqual([...encodeMarc8(text)], [...expected], text);
    assert.equal(decodeMarc8(encodeMarc8(text)).text.normalize('NFC'), text.normalize('NFC'));
  }
});

test('a truncated escape does not leak its intermediate byte into the text', () => {
  // `ESC (` at the end of a field is not an escape, but `(` is still structure.
  // Skipping only the ESC left a literal `(` in the middle of the value.
  const decoded = decodeMarc8(new Uint8Array([0x61, ESC, 0x28]));
  assert.equal(decoded.text, 'a');
  assert.ok(decoded.anomalies.includes(ANOMALY.marc8UnmappedByte));
  // `ESC $ )` with nothing after it. (`ESC $ ) b` would be a VALID multibyte
  // designation of set `b` into G1, which is why picking bytes at random for
  // this test is wrong.)
  assert.equal(decodeMarc8(new Uint8Array([0x61, ESC, 0x24, 0x29])).text, 'a');
  // …and the valid four-byte form really does consume all four: `ESC $ ) b`
  // designates Subscripts into G1, so the following 0x63 is still read through
  // G0's Basic Latin and comes out as `c`.
  assert.equal(decodeMarc8(new Uint8Array([0x61, ESC, 0x24, 0x29, 0x62, 0x63])).text, 'ac');
});

test('the structural decoder is byte-to-code-point, not CP1252', () => {
  // `new TextDecoder('latin1')` is windows-1252 on every platform — measured:
  // `.encoding === 'windows-1252'`, and byte 0x80 decodes to U+20AC. Structure
  // must be read as itself or a damaged tag becomes an unencodable character
  // several frames from its cause.
  const all = new Uint8Array(256).map((_, i) => i);
  const text = decodeLatin1(all);
  assert.equal(text.length, 256);
  for (let i = 0; i < 256; i++) {
    assert.equal(text.charCodeAt(i), i, `byte 0x${i.toString(16)} must decode to itself`);
  }
});

test('ASCII passes through unchanged in both directions', () => {
  const ascii = 'Zorba the Greek / by N. Kazantzakis. 1946.';
  assert.equal(decodeMarc8(encodeMarc8(ascii)).text, ascii);
  assert.equal(decodeLatin1(encodeMarc8(ascii)), ascii);
});
