import assert from 'node:assert/strict';
import test from 'node:test';
import { foldGreek as sharedFoldGreek } from '@libriant/shared/greek';
import { foldGreek, decodeMarc8, readIso2709, writeIso2709 } from './index.js';

/**
 * The package's own wiring, asserted rather than assumed.
 *
 * `node --test "src/**\/*.test.ts"` exits 0 when the glob matches NOTHING, so a
 * renamed directory or a moved file would silently disarm the whole suite and
 * the build would stay green. These assertions are cheap and they are the only
 * thing standing between that and a codec nobody is testing.
 */

test('the Greek fold is RE-EXPORTED, never reimplemented', () => {
  // The phase-7 criterion ends "`check:greek-folding` still green", and that
  // gate holds one fold to one answer across TypeScript, Postgres, and later
  // OpenSearch and Rust. A second `foldGreek` in this package would be a fifth
  // answer nothing checks — so this asserts reference identity, not equal
  // output, because equal output today is exactly how a fork starts.
  assert.equal(foldGreek, sharedFoldGreek);
  assert.equal(foldGreek('ΠΟΛΙΣ'), foldGreek('πολισ'));
});

test('the public surface is present', () => {
  for (const fn of [readIso2709, writeIso2709, decodeMarc8]) {
    assert.equal(typeof fn, 'function');
  }
});
