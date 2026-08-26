/**
 * frontend-20. The whole point of `FormError` is that the live region exists
 * before it has anything to say, so a screen reader has a mutation to notice.
 * These assertions are about the EMPTY render — the state nobody looks at, and
 * the one that decides whether a refused login is ever spoken.
 *
 * Run from `packages/ui`: `node --import tsx --test "src/**\/*.test.tsx"`
 * (that is what `pnpm --filter @libriant/ui test` runs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Banner } from './Banner';
import { FormError } from './FormError';

test('the live region is in the markup before there is an error', () => {
  assert.equal(
    renderToStaticMarkup(<FormError>{null}</FormError>),
    '<div role="alert" aria-live="assertive" style="position:absolute"></div>',
  );
});

test('the wrapper is the same element with and without a message', () => {
  const empty = renderToStaticMarkup(<FormError>{null}</FormError>);
  const filled = renderToStaticMarkup(<FormError>Wrong password.</FormError>);
  assert.ok(empty.startsWith('<div role="alert" aria-live="assertive"'));
  assert.ok(filled.startsWith('<div role="alert" aria-live="assertive"'));
  assert.match(filled, /Wrong password\./);
});

test("an empty region drops the caller's margin and leaves the flow", () => {
  // Two separate claims, and the old version of this test only made the first
  // one while its NAME promised the second ("so it leaves no gap").
  //
  // 1. The caller's margin/class must not be worn by an empty div — every call
  //    site passes a marginBottom, and applied unconditionally it reserved a
  //    permanent blank strip above the first field of every guarded form.
  // 2. The empty div must not be laid out AT ALL, because four call sites make
  //    it the child of a `display: grid; gap: var(--sp-4)`, where a
  //    zero-height item still takes a track and the track still takes a gap.
  //    Dropping the margin cannot reach a gap that belongs to the parent.
  //    Measured in a browser on that shape: 32px of dead space above the first
  //    field, gone once the empty state is out of flow.
  //
  // This asserts the mechanism (the markup), not the pixels — this suite has no
  // layout engine, and a test that could not see the gap is what let it stand.
  const empty = renderToStaticMarkup(
    <FormError style={{ marginBottom: '1rem' }} className="x">
      {null}
    </FormError>,
  );
  assert.ok(!empty.includes('margin-bottom'), empty);
  assert.ok(!empty.includes('class='), empty);
  assert.match(empty, /style="position:absolute"/);

  const filled = renderToStaticMarkup(
    <FormError style={{ marginBottom: '1rem' }} className="x">
      Wrong password.
    </FormError>,
  );
  assert.match(filled, /margin-bottom:1rem/);
  assert.match(filled, /class="x"/);
  // And the error state is laid out normally — out-of-flow there would take
  // the message off the page.
  assert.ok(!filled.includes('position:absolute'), filled);
});

test('the inner banner does not become a second live region', () => {
  // Nested live regions make some screen readers read the message twice.
  const filled = renderToStaticMarkup(<FormError>Wrong password.</FormError>);
  assert.equal(filled.match(/role="alert"/g)?.length, 1);
  assert.ok(!filled.includes('role="status"'), filled);
});

test('a critical banner interrupts; the other severities wait their turn', () => {
  assert.match(renderToStaticMarkup(<Banner severity="critical">x</Banner>), /role="alert"/);
  for (const severity of ['info', 'warning', 'success'] as const) {
    assert.match(renderToStaticMarkup(<Banner severity={severity}>x</Banner>), /role="status"/);
  }
});
