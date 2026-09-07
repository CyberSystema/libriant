import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RULE,
  blocks,
  describeIssue,
  issueKey,
  subtractIssues,
  type ValidationIssue,
} from './issues.js';

/**
 * The issue identity, which is the whole of `validateDelta`.
 *
 * Each of these tests is one way the identity could be chosen wrongly, and each
 * wrong choice ends the same way: a cataloguer cannot save a record because of a
 * fault they did not create, so they switch validation off and it protects
 * nothing from then on.
 */

const issue = (over: Partial<ValidationIssue> = {}): ValidationIssue => ({
  rule: RULE.indicatorNotAllowed,
  severity: 'error',
  message: 'Indicator 2 is not one of the allowed values.',
  at: { tag: '650', occurrence: 1 },
  subject: '9',
  ...over,
});

test('the same fault at a different occurrence is the SAME issue', () => {
  // Deleting the second of five 650s renumbers the three after it. If the
  // ordinal were in the identity, every pre-existing issue on them would look
  // new and the deletion would block on faults it did not touch.
  const first = issue({ at: { tag: '650', occurrence: 2 } });
  const second = issue({ at: { tag: '650', occurrence: 4 } });
  assert.equal(issueKey(first), issueKey(second));
});

test('the same fault after an unrelated edit to the same field is the SAME issue', () => {
  // The trap. A cataloguer fixing a typo in `245 $a` must not be blocked by a
  // pre-existing illegal indicator on that 245 — so an indicator rule's identity
  // carries the INDICATOR, never the field's content.
  const before = issue({ at: { tag: '245', occurrence: 1 }, subject: '9' });
  const after = issue({ at: { tag: '245', occurrence: 1 }, subject: '9' });
  assert.equal(issueKey(before), issueKey(after));
  assert.deepEqual(subtractIssues([before], [after]).introduced, []);
});

test('rewording a message does not turn stored issues into new ones', () => {
  const old = issue({ message: 'Indicator 2 is invalid.' });
  const reworded = issue({ message: 'Indicator 2 is not one of the allowed values.' });
  assert.equal(issueKey(old), issueKey(reworded));
});

test('promoting a warning to an error is a policy change, not an edit', () => {
  assert.equal(issueKey(issue({ severity: 'warning' })), issueKey(issue({ severity: 'error' })));
});

test('a DIFFERENT bad value in the same place is a different issue', () => {
  // The other direction: the identity must be narrow, not blind. Changing an
  // indicator from one illegal value to another illegal value is a new fault the
  // edit introduced.
  const before = issue({ subject: '9' });
  const after = issue({ subject: '8' });
  assert.notEqual(issueKey(before), issueKey(after));
  assert.equal(subtractIssues([before], [after]).introduced.length, 1);
  assert.equal(subtractIssues([before], [after]).resolved.length, 1);
});

test('a rule about the RECORD has one identity per tag, whatever the field holds', () => {
  // "There are two 245s" is one issue about the record. It must not multiply or
  // change identity when either 245 is edited.
  const a: ValidationIssue = {
    rule: RULE.fieldNotRepeatable,
    severity: 'error',
    message: '245 may appear only once.',
    at: { tag: '245' },
  };
  const b: ValidationIssue = { ...a, at: { tag: '245', occurrence: 2 } };
  assert.equal(issueKey(a), issueKey(b));
});

test('two identical faults are two faults, and adding a third is one new issue', () => {
  const one = issue();
  const delta = subtractIssues([one, one], [one, one, one]);
  assert.equal(delta.introduced.length, 1, 'multiset subtraction, not set subtraction');
  assert.equal(delta.preexisting.length, 2);
  assert.equal(delta.resolved.length, 0);
});

test('removing one of two identical faults is resolved, not introduced', () => {
  const one = issue();
  const delta = subtractIssues([one, one], [one]);
  assert.equal(delta.introduced.length, 0);
  assert.equal(delta.resolved.length, 1);
});

test('a neutral edit to a record full of faults introduces nothing', () => {
  // The phase's own acceptance criterion, and the sentence the whole design
  // exists for.
  const twelve = Array.from({ length: 12 }, (_, i) =>
    issue({ at: { tag: `65${i % 10}`, occurrence: 1 }, subject: String(i) }),
  );
  const delta = subtractIssues(twelve, twelve);
  assert.deepEqual(delta.introduced, []);
  assert.deepEqual(delta.resolved, []);
  assert.equal(delta.preexisting.length, 12);
  assert.deepEqual(blocks(delta), []);
});

test('an edit that fixes one fault and introduces another blocks on the new one', () => {
  const fixed = issue({ at: { tag: '245' }, subject: '9' });
  const fresh = issue({ at: { tag: '100' }, subject: '7' });
  const delta = subtractIssues([fixed], [fresh]);
  assert.equal(delta.introduced.length, 1);
  assert.equal(delta.introduced[0]!.at.tag, '100');
  assert.equal(delta.resolved.length, 1);
  assert.equal(blocks(delta).length, 1);
});

test('an edit that trades one fault for an identical one nets to zero, deliberately', () => {
  // Stated rather than discovered: the multiset subtraction cannot tell "fixed
  // here, broke there" from "unchanged" when the two faults share an identity.
  // It errs toward letting the librarian save, which is the direction this whole
  // design errs in.
  const before = issue({ at: { tag: '650', occurrence: 1 } });
  const after = issue({ at: { tag: '650', occurrence: 2 } });
  assert.deepEqual(subtractIssues([before], [after]).introduced, []);
});

test('only introduced ERRORS block; a warning never does', () => {
  const warning = issue({ severity: 'warning', subject: 'w' });
  const error = issue({ severity: 'error', subject: 'e' });
  assert.deepEqual(blocks(subtractIssues([], [warning])), []);
  assert.equal(blocks(subtractIssues([], [warning, error])).length, 1);
  // …and an error that was already there does not block either.
  assert.deepEqual(blocks(subtractIssues([error], [error])), []);
});

test('a described issue names the tag, the occurrence, the subfield and the rule', () => {
  assert.equal(
    describeIssue({
      rule: RULE.subfieldNotRepeatable,
      severity: 'error',
      message: '$a may appear only once in 245.',
      at: { tag: '245', occurrence: 2, code: 'a', codeOccurrence: 2 },
    }),
    '245#2 $a#2: $a may appear only once in 245. [subfield-not-repeatable]',
  );
  assert.equal(
    describeIssue({
      rule: RULE.positionNotAllowed,
      severity: 'warning',
      message: 'Not a listed code.',
      at: { tag: '008', position: '06' },
      subject: 'x',
    }),
    '008/06: Not a listed code. [position-not-allowed]',
  );
});
