import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCorpus } from './__fixtures__/corpus.js';
import { validateSchema } from './avram.js';
import { SHIPPED_PROFILES, UNAVAILABLE_PROFILES, shippedSchema } from './definitions.js';
import { readIso2709Record } from './iso2709.js';
import { RULE_PACKS, packFor, schemaForRecord } from './rules.js';
import { SHIPPED_TEMPLATES, checkTemplate, recordFromTemplate } from './templates.js';
import { validate } from './validate.js';

/**
 * The SHIPPED definition, templates and rule packs — as opposed to
 * `validate.test.ts`, which tests the engine against a definition written in
 * that file.
 *
 * The distinction matters: these assertions are about DATA, and data is what a
 * later session will replace when it vendors an authority. They are written so
 * that replacing it correctly keeps them green and replacing it carelessly does
 * not.
 */

const SCHEMA = shippedSchema('marc21/bibliographic');

test('the shipped definition is well-formed and honest about itself', () => {
  assert.deepEqual(validateSchema(SCHEMA), []);
  assert.equal(SCHEMA.coverage.fieldCount, Object.keys(SCHEMA.fields).length);
  assert.ok(SCHEMA.coverage.limits.length > 200, 'the limits are stated at length, not in passing');
  assert.match(SCHEMA.coverage.source, /hand-transcribed/);
});

test('the shipped definition is TRANSCRIBED, so nothing it says can block a save', () => {
  // The cap that makes a hand-authored definition safe. When a later session
  // vendors an authority and regenerates, this flips to 'generated' and the same
  // rules start blocking — which is the entire promise of the generator.
  assert.equal(SCHEMA.coverage.confidence, 'transcribed');
  const twoTitles = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '245', i: '10', s: [{ a: 'One' }] },
      { t: '245', i: '10', s: [{ a: 'Two' }] },
    ],
  };
  assert.ok(validate(twoTitles, SCHEMA).issues.every((i) => i.severity === 'warning'));
});

test('a profile this build does not ship is refused by name, not silently empty', () => {
  // An empty definition would validate every record clean, which is the one
  // answer a validator must never give by accident.
  for (const profile of Object.keys(UNAVAILABLE_PROFILES)) {
    assert.throws(
      () => shippedSchema(profile),
      (err: unknown) => {
        assert.match((err as Error).message, new RegExp(`no format definition for "${profile}"`));
        return true;
      },
      profile,
    );
  }
  assert.deepEqual(SHIPPED_PROFILES, ['marc21/bibliographic']);
  assert.ok(UNAVAILABLE_PROFILES['unimarc/bibliographic']?.includes('ABEKT'));
});

test('880 is deliberately undefined, because its indicators mirror another field', () => {
  // Giving 880 its own indicator list would be wrong for every record that has
  // one: an 880 carries the indicators of the field it is linked to.
  assert.equal(SCHEMA.fields['880'], undefined);
});

test('every 6XX thesaurus indicator is per-tag, and 653 is not one of them', () => {
  // "6XX ind2 is the thesaurus" is the intuitive rule and it is wrong: 653's
  // indicator 2 is the type of term, and encoding it as a thesaurus would flag
  // every uncontrolled index term in a catalogue.
  const thesaurus = ['600', '610', '611', '630', '650', '651', '655'];
  for (const tag of thesaurus) {
    assert.deepEqual(
      Object.keys(SCHEMA.fields[tag]?.indicator2?.codes ?? {}),
      ['0', '1', '2', '3', '4', '5', '6', '7'],
      `${tag} indicator 2`,
    );
  }
  assert.ok(
    Object.keys(SCHEMA.fields['653']?.indicator2?.codes ?? {}).includes(' '),
    '653 indicator 2 is the type of term and allows a blank',
  );
});

test('440 is obsolete and says what replaced it', () => {
  const field = SCHEMA.fields['440'];
  assert.equal(field?.deprecated, true);
  assert.match(field?.replacedBy ?? '', /490/);
  assert.match(field?.replacedBy ?? '', /830/);
  // …and it keeps its own rules, so an obsolete field is still checked rather
  // than waved through.
  assert.ok(field?.indicator2?.codes, 'a deprecated field keeps its indicator list');
});

test('the fill character is accepted wherever a coded 008 position is defined', () => {
  // `|` means "no attempt to code" and is legal in nearly every coded position.
  // A code list that omitted it would false-positive on a very large share of
  // real records — including all 5,000 in this repository's own corpus.
  for (const [key, position] of Object.entries(SCHEMA.fields['008']?.positions ?? {})) {
    if (!position.codes) continue;
    assert.ok(
      Object.keys(position.codes).includes('|'),
      `008/${key} must accept the fill character`,
    );
  }
});

test('the main-entry group is a group, not four independent rules', () => {
  const group = SCHEMA.groups?.find((g) => g.label === 'main entry');
  assert.deepEqual(group?.tags, ['100', '110', '111', '130']);
  // Each is individually non-repeatable, which is why the group rule is needed:
  // a record with one 100 and one 110 breaks no per-field rule.
  for (const tag of group?.tags ?? []) assert.equal(SCHEMA.fields[tag]?.repeatable, false);
});

test('almost nothing is marked required, because almost nothing actually is', () => {
  // The false-positive trap. What MARC 21 REQUIRES is far less than what an LC
  // record contains: real records routinely lack 001, 003, 040, 300 and any 1XX,
  // and a definition that required them would flag most of a real catalogue. The
  // leader and 008 are required by the FORMAT and are checked structurally
  // rather than through this flag.
  const required = Object.entries(SCHEMA.fields)
    .filter(([, f]) => f.required)
    .map(([tag]) => tag);
  assert.deepEqual(required, ['245']);
  for (const tag of ['001', '003', '040', '300', '260', '264', '100']) {
    assert.notEqual(SCHEMA.fields[tag]?.required, true, `${tag} must not be required`);
  }
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('every shipped template binds only tags the definition defines', () => {
  assert.ok(SHIPPED_TEMPLATES.length >= 2);
  for (const template of SHIPPED_TEMPLATES) {
    assert.deepEqual(checkTemplate(template, SCHEMA), [], template.id);
  }
});

test('a new record from a template validates clean', () => {
  // A template that starts a cataloguer off with a warning teaches them on their
  // first day that the warnings do not mean anything.
  for (const template of SHIPPED_TEMPLATES) {
    const record = recordFromTemplate(template);
    const report = validate(record, schemaForRecord(SCHEMA, record));
    assert.deepEqual(
      report.issues.map((i) => `${i.at.tag}: ${i.rule}`),
      [],
      `${template.id} starts with issues`,
    );
  }
});

test('a template that binds an undefined tag is reported, not accepted', () => {
  const problems = checkTemplate(
    { ...SHIPPED_TEMPLATES[0]!, fields: [{ tag: '946', i: '  ', codes: ['a'] }] },
    SCHEMA,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /binds 946, which marc21\/bibliographic does not define/);
});

// ---------------------------------------------------------------------------
// Rule packs
// ---------------------------------------------------------------------------

test('a record selects its own rule pack from Leader/18', () => {
  const at18 = (form: string) => ({
    leader: `00000nam a2200000 ${form} 4500`,
    fields: [],
  });
  assert.equal(packFor(at18('a'))?.id, 'aacr2');
  assert.equal(packFor(at18('i'))?.id, 'rda');
  assert.equal(packFor(at18('c'))?.id, 'isbd');
  assert.equal(packFor(at18(' ')), null, 'a non-ISBD record selects nothing');
});

test('Leader/18 "c" means ISBD punctuation OMITTED, not "not ISBD"', () => {
  // The plan calls this out by name: `c` is growing under RDA, and treating it
  // as pass-through is exactly backwards.
  const isbd = RULE_PACKS.find((p) => p.id === 'isbd');
  assert.ok(isbd?.descriptiveForm.includes('c'));
  assert.match(isbd?.note ?? '', /punctuation omitted/i);
});

test('RDA adds content, media and carrier type; AACR2 adds nothing', () => {
  const rda = {
    leader: '00000nam a2200000 i 4500',
    fields: [{ t: '245', i: '10', s: [{ a: 'x' }] }],
  };
  const withRda = schemaForRecord(SCHEMA, rda);
  for (const tag of ['336', '337', '338']) {
    assert.equal(withRda.fields[tag]?.required, true, `${tag} required under RDA`);
  }
  const issues = validate(rda, withRda).issues;
  assert.equal(issues.length, 3, 'three missing fields, and they are warnings');
  assert.ok(issues.every((i) => i.severity === 'warning'));

  // The same record coded AACR2 predates all three and is not deficient.
  const aacr2 = { ...rda, leader: '00000nam a2200000 a 4500' };
  assert.deepEqual(validate(aacr2, schemaForRecord(SCHEMA, aacr2)).issues, []);
});

test('a tenant override beats a rule pack, because a library that wrote it down meant it', () => {
  const rda = {
    leader: '00000nam a2200000 i 4500',
    fields: [{ t: '245', i: '10', s: [{ a: 'x' }] }],
  };
  const schema = schemaForRecord(SCHEMA, rda, {
    fields: { '336': null, '337': null, '338': null },
  });
  assert.deepEqual(validate(rda, schema).issues, []);
});

// ---------------------------------------------------------------------------
// The false-positive property
// ---------------------------------------------------------------------------

test('the definition raises no ERROR on any of 5,000 corpus records', () => {
  // What replaces "zero false positives on LC-published-valid records" in a
  // repository that has none. Not a substitute for real records — but not
  // circular either: the corpus was written for phase 7 to test byte-level
  // round-tripping, and its tags were chosen to exercise a serializer.
  const errors: string[] = [];
  const unchecked = new Set<string>();
  for (const entry of generateCorpus(5000)) {
    const record = readIso2709Record(entry.bytes).record;
    const report = validate(record, schemaForRecord(SCHEMA, record));
    for (const tag of report.uncheckedTags) unchecked.add(tag);
    for (const issue of report.issues) {
      if (issue.severity === 'error') errors.push(`${issue.at.tag}: ${issue.rule}`);
    }
  }
  assert.deepEqual([...new Set(errors)], []);
  // …and the coverage is reported rather than implied. 880 is the one tag the
  // corpus uses that this definition deliberately says nothing about.
  assert.deepEqual([...unchecked].sort(), ['880']);
});
