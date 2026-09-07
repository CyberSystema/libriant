import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOverride, loadSchema, validateSchema, type AvramSchema } from './avram.js';
import { RULE } from './issues.js';
import { validate, validateDelta } from './validate.js';
import { MarcError, type MarcRecord } from './types.js';

/**
 * The validator's MECHANISM, exercised against a small definition written here.
 *
 * Deliberately not against the shipped MARC 21 definition: these tests must fail
 * when the validator is wrong, not when a rule in a data file is corrected. The
 * shipped definition is checked by `check:marc-schema` and by its own tests.
 */

const SCHEMA: AvramSchema = {
  title: 'A tiny format, for testing the validator',
  profile: 'test/bibliographic',
  coverage: {
    source: 'hand-authored for the validator tests',
    limits: 'nothing real',
    fieldCount: 7,
    // `generated` so these tests exercise the error path. The cap that a
    // `transcribed` definition applies has its own test below.
    confidence: 'generated',
  },
  fields: {
    LDR: {
      label: 'Leader',
      length: 24,
      positions: { '06': { label: 'Type', codes: { a: {}, c: {} } } },
    },
    '008': {
      label: 'Fixed-length data',
      repeatable: false,
      length: 40,
      positions: { '06': { label: 'Type of date', codes: { s: {}, m: {}, '|': {} } } },
    },
    '100': {
      label: 'Main entry — personal name',
      repeatable: false,
      subfields: { a: { repeatable: false } },
    },
    '110': { label: 'Main entry — corporate name', repeatable: false, subfields: { a: {} } },
    '245': {
      label: 'Title statement',
      repeatable: false,
      required: true,
      indicator1: { label: 'Title added entry', codes: { '0': {}, '1': {} } },
      indicator2: {
        label: 'Nonfiling characters',
        codes: Object.fromEntries('0123456789'.split('').map((c) => [c, {}])),
      },
      subfields: {
        a: { repeatable: false, required: true },
        b: { repeatable: false },
        c: { repeatable: false },
      },
    },
    '440': {
      label: 'Series statement',
      deprecated: true,
      replacedBy: '490 with 830',
      subfields: { a: {} },
    },
    '650': {
      label: 'Subject — topical',
      indicator2: {
        label: 'Thesaurus',
        // `#` on purpose: MARC documentation writes a blank this way and real
        // Avram files in the wild disagree about the spelling.
        codes: { '#': {}, '0': {}, '1': {}, '2': {}, '7': {} },
      },
      subfields: { a: { repeatable: false }, x: {}, '2': { repeatable: false } },
    },
  },
  groups: [{ label: 'main entry', tags: ['100', '110'] }],
};

const LEADER = '00000nam a2200000 a 4500';
const rec = (fields: MarcRecord['fields'], leader = LEADER): MarcRecord => ({ leader, fields });
const title = (): MarcRecord['fields'][number] => ({
  t: '245',
  i: '10',
  s: [{ a: 'A title /' }],
});

// ---------------------------------------------------------------------------
// The open world
// ---------------------------------------------------------------------------

test('a field the definition does not mention produces no issue', () => {
  // MARC 21 reserves the whole 9XX block for local use, and a validator that
  // flagged them would be switched off in the first week.
  const issues = validate(
    rec([title(), { t: '994', i: '  ', s: [{ a: 'local' }] }]),
    SCHEMA,
  ).issues;
  assert.deepEqual(issues, []);
});

test('an unlisted subfield on a DEFINED field is a warning, never an error', () => {
  const issues = validate(
    rec([{ ...title(), s: [{ a: 'A title /' }, { q: 'odd' }] }]),
    SCHEMA,
  ).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.rule, RULE.subfieldNotAllowed);
  assert.equal(issues[0]!.severity, 'warning');
});

test('$9 is never flagged, because it is reserved for local use', () => {
  assert.deepEqual(
    validate(rec([{ ...title(), s: [{ a: 'A' }, { '9': 'local' }] }]), SCHEMA).issues,
    [],
  );
});

test('an indicator the definition does not constrain is not checked', () => {
  // 650 defines only indicator 2, so indicator 1 may hold anything.
  assert.deepEqual(
    validate(rec([title(), { t: '650', i: 'Z0', s: [{ a: 'X' }] }]), SCHEMA).issues,
    [],
  );
});

// ---------------------------------------------------------------------------
// The four named acceptance cases
// ---------------------------------------------------------------------------

test('a repeated 245 produces exactly one issue, naming the tag and the rule', () => {
  const issues = validate(rec([title(), title()]), SCHEMA).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  const [issue] = issues;
  assert.equal(issue!.rule, RULE.fieldNotRepeatable);
  assert.equal(issue!.severity, 'error');
  assert.equal(issue!.at.tag, '245');
  assert.match(issue!.message, /245 may appear only once in a record; this record has 2\./);
});

test('an illegal 6XX indicator 2 produces exactly one issue, naming the value and the alternatives', () => {
  const issues = validate(
    rec([title(), { t: '650', i: ' 9', s: [{ a: 'Subject' }] }]),
    SCHEMA,
  ).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  const [issue] = issues;
  assert.equal(issue!.rule, RULE.indicatorNotAllowed);
  assert.equal(issue!.severity, 'error');
  assert.equal(issue!.at.tag, '650');
  assert.equal(issue!.at.occurrence, 1);
  assert.match(issue!.message, /indicator 2 \(Thesaurus\) holds "9"/);
  assert.match(issue!.message, /blank, "0", "1", "2", "7"/, 'the message lists what IS allowed');
});

test('an obsolete 440 produces exactly one issue, and it is a WARNING', () => {
  const issues = validate(
    rec([title(), { t: '440', i: ' 0', s: [{ a: 'A series' }] }]),
    SCHEMA,
  ).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  const [issue] = issues;
  assert.equal(issue!.rule, RULE.fieldObsolete);
  assert.equal(
    issue!.severity,
    'warning',
    'a record catalogued under AACR2 is history, not a mistake — and importing it is the point',
  );
  assert.match(
    issue!.message,
    /440 \(Series statement\) is obsolete in this format; 490 with 830 replaced it\./,
  );
});

test('a three-character indicator produces exactly one issue', () => {
  // Phase 7's ISO 2709 reader normalises indicators to two characters, so this
  // can only arrive from MARCXML, MARC-in-JSON or an editor — which is why it is
  // checked rather than assumed away.
  const issues = validate(rec([{ t: '245', i: '10 ', s: [{ a: 'A title /' }] }]), SCHEMA).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.indicatorMalformed);
  assert.match(issues[0]!.message, /has 3 indicator characters; MARC 21 fixes it at two/);
});

// ---------------------------------------------------------------------------
// The rest of the rules
// ---------------------------------------------------------------------------

test('a blank indicator is accepted however the definition spells it', () => {
  // The definition writes it `#`; the record carries 0x20.
  assert.deepEqual(
    validate(rec([title(), { t: '650', i: ' 0', s: [{ a: 'S' }] }]), SCHEMA).issues,
    [],
  );
  assert.deepEqual(
    validate(rec([title(), { t: '650', i: '7 ', s: [{ a: 'S' }] }]), SCHEMA).issues,
    [],
  );
});

test('a required field that is absent is an error', () => {
  const issues = validate(rec([{ t: '650', i: ' 0', s: [{ a: 'S' }] }]), SCHEMA).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.rule, RULE.fieldMissing);
  assert.match(issues[0]!.message, /245 \(Title statement\) is required/);
});

test('a required subfield that is absent is an error', () => {
  const issues = validate(rec([{ t: '245', i: '10', s: [{ b: 'subtitle' }] }]), SCHEMA).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.rule, RULE.subfieldMissing);
  assert.equal(issues[0]!.at.code, 'a');
});

test('a repeated non-repeatable subfield is one issue, not one per extra copy', () => {
  const { issues } = validate(
    rec([{ t: '245', i: '10', s: [{ a: 'One' }, { a: 'Two' }, { a: 'Three' }] }]),
    SCHEMA,
  );
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.subfieldNotRepeatable);
});

test('two members of a mutually exclusive group is one issue', () => {
  // 100 and 110 are each non-repeatable, so a record with one of each breaks no
  // per-field rule while being unambiguously wrong.
  const { issues } = validate(
    rec([title(), { t: '100', i: '1 ', s: [{ a: 'A' }] }, { t: '110', i: '2 ', s: [{ a: 'B' }] }]),
    SCHEMA,
  );
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.groupNotRepeatable);
  assert.match(issues[0]!.message, /at most one main entry, and this one has 2: 100, 110/);
});

test('a fixed field of the wrong length is one issue, not one per position', () => {
  const issues = validate(rec([title(), { t: '008', v: 'too short' }]), SCHEMA).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.fixedFieldLength);
  assert.match(issues[0]!.message, /must be exactly 40 characters; this one is 9/);
});

test('a fixed-field position outside its code list is a warning naming the position', () => {
  const value = `26090${6}z${'x'.repeat(33)}`;
  const issues = validate(rec([title(), { t: '008', v: value }]), SCHEMA).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.positionNotAllowed);
  assert.equal(issues[0]!.at.position, '06');
  assert.equal(issues[0]!.subject, 'z');
});

test('the leader is validated like any other fixed field', () => {
  const issues = validate(rec([title()], '00000nZm a2200000 a 4500'), SCHEMA).issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.at.tag, 'LDR');
  assert.equal(issues[0]!.at.position, '06');
});

test('a control field held as a data field is reported once and not descended into', () => {
  const issues = validate(
    rec([title(), { t: '008', i: '  ', s: [{ a: 'wrong' }] }]),
    SCHEMA,
  ).issues;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]!.rule, RULE.fieldKindMismatch);
});

test('the issue count is capped, so one broken record cannot flood a report', () => {
  const many = Array.from({ length: 50 }, () => ({ t: '440', i: ' 0', s: [{ a: 'S' }] }));
  assert.equal(validate(rec([title(), ...many]), SCHEMA, { limit: 5 }).issues.length, 5);
});

test('the report says which tags it never checked', () => {
  // "No issues" from a definition that describes seven tags is a lie of
  // omission, and it is the one that would make this phase worse than nothing.
  const report = validate(
    rec([title(), { t: '994', i: '  ', s: [{ a: 'local' }] }, { t: '035', v: 'x' }]),
    SCHEMA,
  );
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.uncheckedTags, ['035', '994'], 'and it says so');
  assert.equal(report.confidence, 'generated');
});

test('a TRANSCRIBED definition cannot raise an error from its own tables', () => {
  // The cap that makes a hand-authored definition safe: a row that turns out to
  // be wrong costs a spurious warning, never a refused save.
  const transcribed = {
    ...SCHEMA,
    coverage: { ...SCHEMA.coverage, confidence: 'transcribed' as const },
  };
  const table = validate(rec([title(), title()]), transcribed).issues;
  assert.equal(table.length, 1);
  assert.equal(table[0]!.rule, RULE.fieldNotRepeatable);
  assert.equal(table[0]!.severity, 'warning', 'repeatability is read out of a table');

  // …but a STRUCTURAL rule is an error whatever the confidence, because it comes
  // from the format rather than from a row somebody typed.
  const structural = validate(rec([{ t: '245', i: '10 ', s: [{ a: 'x' }] }]), transcribed).issues;
  assert.equal(structural[0]!.rule, RULE.indicatorMalformed);
  assert.equal(structural[0]!.severity, 'error');
});

test('a transcribed definition therefore blocks only structural faults', () => {
  const transcribed = {
    ...SCHEMA,
    coverage: { ...SCHEMA.coverage, confidence: 'transcribed' as const },
  };
  const before = rec([title()]);
  // A newly added second 245 — a table rule — must not block.
  assert.deepEqual(validateDelta(before, rec([title(), title()]), transcribed).blocking, []);
  // A malformed indicator — structural — must.
  const broken = rec([title(), { t: '650', i: 'x', s: [{ a: 'S' }] }]);
  assert.equal(validateDelta(before, broken, transcribed).blocking.length, 1);
});

// ---------------------------------------------------------------------------
// validateDelta — the reason the phase exists
// ---------------------------------------------------------------------------

test('a neutral edit to a record with a dozen faults blocks nothing', () => {
  // The phase's own acceptance criterion.
  const faults: MarcRecord['fields'] = [
    { t: '245', i: '90', s: [{ a: 'Bad ind1' }] },
    { t: '650', i: ' 9', s: [{ a: 'One' }] },
    { t: '650', i: ' 8', s: [{ a: 'Two' }] },
    { t: '650', i: ' 6', s: [{ a: 'Three' }] },
    { t: '440', i: ' 0', s: [{ a: 'Obsolete' }] },
    { t: '100', i: '1 ', s: [{ a: 'A' }] },
    { t: '110', i: '2 ', s: [{ a: 'B' }] },
    { t: '008', v: 'z'.repeat(40) },
  ];
  const before = rec(faults);
  // Enumerated rather than counted, so the fixture cannot quietly stop being a
  // mess and turn this test vacuous.
  assert.deepEqual(
    validate(before, SCHEMA)
      .issues.map((i) => i.rule)
      .sort(),
    [
      RULE.fieldObsolete,
      RULE.groupNotRepeatable,
      RULE.indicatorNotAllowed,
      RULE.indicatorNotAllowed,
      RULE.indicatorNotAllowed,
      RULE.indicatorNotAllowed,
      RULE.positionNotAllowed,
    ].sort(),
  );

  // A neutral edit: change the text of one subfield, touching nothing else.
  const after = rec(
    faults.map((f) =>
      f.t === '650' && 's' in f && f.s[0] && 'a' in f.s[0] && f.s[0].a === 'One'
        ? { ...f, s: [{ a: 'One, revised' }] }
        : f,
    ),
  );
  const delta = validateDelta(before, after, SCHEMA);
  assert.deepEqual(delta.blocking, [], JSON.stringify(delta.introduced));
  assert.deepEqual(delta.introduced, []);
  assert.equal(delta.preexisting.length, delta.after.issues.length);
});

test('an edit that introduces a fault blocks, naming only that fault', () => {
  const before = rec([title(), { t: '650', i: ' 9', s: [{ a: 'Pre-existing fault' }] }]);
  const after = rec([
    title(),
    { t: '650', i: ' 9', s: [{ a: 'Pre-existing fault' }] },
    { t: '650', i: ' 8', s: [{ a: 'New fault' }] },
  ]);
  const delta = validateDelta(before, after, SCHEMA);
  assert.equal(delta.blocking.length, 1);
  assert.equal(delta.blocking[0]!.subject, '28', 'indicator 2 holding 8');
  assert.equal(delta.preexisting.length, 1);
});

test('deleting a field renumbers the rest and still blocks nothing', () => {
  // The identity carries no occurrence ordinal, which is what makes this true.
  const bad = (a: string, i: string) => ({ t: '650', i, s: [{ a }] });
  const before = rec([title(), bad('one', ' 9'), bad('two', ' 8'), bad('three', ' 6')]);
  const after = rec([title(), bad('two', ' 8'), bad('three', ' 6')]);
  const delta = validateDelta(before, after, SCHEMA);
  assert.deepEqual(delta.blocking, []);
  assert.equal(delta.resolved.length, 1);
});

test('creating a record reports everything wrong with it', () => {
  // ind1 '9' — 245 allows only 0 and 1 there. (ind2 accepts 0-9, so an illegal
  // value has to come from indicator 1.)
  const delta = validateDelta(null, rec([{ t: '245', i: '90', s: [{ a: 'x' }] }]), SCHEMA);
  assert.equal(delta.blocking.length, 1);
  assert.equal(delta.preexisting.length, 0);
});

test('the issue limit never turns a pre-existing fault into an introduced one', () => {
  // The limit applies to the RESULT, not to either side. Limiting each side
  // first is the obvious implementation and it drops pre-existing faults from
  // the subtraction, so they reappear as introduced and block a save on exactly
  // the ruined record where the amnesty matters most.
  const many = Array.from({ length: 40 }, (_, n) => ({
    t: '650',
    i: ` ${n % 2 ? '8' : '9'}`,
    s: [{ a: `Subject ${n}` }],
  }));
  const before = rec([title(), ...many]);
  const after = rec([{ ...title(), s: [{ a: 'A title, revised /' }] }, ...many]);
  const delta = validateDelta(before, after, SCHEMA, { limit: 3 });
  assert.deepEqual(delta.introduced, [], 'nothing was introduced by a neutral edit');
  assert.deepEqual(delta.blocking, []);
  assert.equal(delta.preexisting.length, 3, 'and the limit is spent on the report');
});

test('a warning is never blocking, however new it is', () => {
  const before = rec([title()]);
  const after = rec([title(), { t: '440', i: ' 0', s: [{ a: 'Newly added obsolete field' }] }]);
  const delta = validateDelta(before, after, SCHEMA);
  assert.equal(delta.introduced.length, 1);
  assert.deepEqual(delta.blocking, []);
});

// ---------------------------------------------------------------------------
// The layered loader
// ---------------------------------------------------------------------------

test('a tenant override patches a field without replacing the definition', () => {
  const merged = applyOverride(SCHEMA, {
    fields: { '245': { subfields: { n: { label: 'Number of part' } } } },
  });
  // The added subfield is there…
  assert.ok(merged.fields['245']?.subfields?.n);
  // …and the shipped ones survived, which whole-file replacement would not do.
  assert.ok(merged.fields['245']?.subfields?.a);
  assert.equal(merged.fields['245']?.repeatable, false);
  assert.ok(merged.fields['650'], 'and every other field is untouched');
  assert.match(merged.coverage.source, /tenant override/);
});

test('an override can remove a rule entirely, which is how a library disagrees', () => {
  const merged = applyOverride(SCHEMA, { fields: { '440': null } });
  assert.equal(merged.fields['440'], undefined);
  // …and the obsolete-440 warning stops, because the field is now unconstrained.
  assert.deepEqual(
    validate(rec([title(), { t: '440', i: ' 0', s: [{ a: 'S' }] }]), merged).issues,
    [],
  );
});

test('the base definition is not mutated by an override', () => {
  applyOverride(SCHEMA, { fields: { '245': null } });
  assert.ok(SCHEMA.fields['245'], 'applyOverride returns a new schema');
});

// ---------------------------------------------------------------------------
// The definition's own shape
// ---------------------------------------------------------------------------

test('a definition that lies about its own coverage is refused', () => {
  const problems = validateSchema({ ...SCHEMA, coverage: { ...SCHEMA.coverage, fieldCount: 99 } });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /says 99 but the file defines 7/);
});

test('a definition with a field that is both fixed and variable is refused', () => {
  const problems = validateSchema({
    ...SCHEMA,
    coverage: { ...SCHEMA.coverage, fieldCount: 8 },
    fields: { ...SCHEMA.fields, '007': { positions: { '00': {} }, subfields: { a: {} } } },
  });
  assert.ok(problems.some((p) => /positions or subfields, never both/.test(p)));
});

test('a group naming a field the definition does not define is refused', () => {
  const problems = validateSchema({
    ...SCHEMA,
    groups: [{ label: 'main entry', tags: ['100', '111'] }],
  });
  assert.ok(problems.some((p) => /names 111, which the definition does not define/.test(p)));
});

test('a position running past the declared length is refused', () => {
  const problems = validateSchema({
    ...SCHEMA,
    fields: { ...SCHEMA.fields, LDR: { length: 24, positions: { '30': {} } } },
  });
  assert.ok(problems.some((p) => /runs past the declared length 24/.test(p)));
});

test('loadSchema refuses a bad definition rather than half-applying it', () => {
  assert.throws(
    () =>
      loadSchema({
        title: 'x',
        profile: 'y',
        coverage: { source: 's', limits: 'l', fieldCount: 0 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof MarcError);
      assert.equal(err.code, 'avram-invalid');
      assert.match(err.message, /fields is required/);
      return true;
    },
  );
});
