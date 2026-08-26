/**
 * Tests for the help/legal HTML sink — input-and-files-04.
 *
 * `legacySanitizeHtml` below is a verbatim copy of the four-`.replace()` denylist
 * that guarded the help-article body (scripts/ingest-help-articles.ts). Keeping it
 * here lets every payload assert two things at once: that it really does walk past
 * the guard the team believed it had, and that it no longer reaches the page.
 * Without the copy, "this is blocked now" is unfalsifiable — the whole reason the
 * defect survived review is that the old guard *looked* like it worked.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"` (that is
 * what `pnpm --filter @libriant/web test` runs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { marked } from 'marked';
import { renderSafeHtml } from '@/lib/safe-html';

function legacySanitizeHtml(html: string): string {
  return html
    .replace(
      /<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      '',
    )
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):/gi, '$1=$2#blocked:');
}

/** What the browser used to be handed. */
function legacyRender(markdown: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  return legacySanitizeHtml(marked.parse(markdown, { async: false }) as string).trim();
}

/** What the browser is handed now. */
function safeRender(markdown: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  return renderToStaticMarkup(
    renderSafeHtml(marked.parse(markdown, { async: false }) as string),
  ).trim();
}

/** Anything a browser would run out of an href/src, however it is spelled. */
const EXECUTABLE = /(javascript|vbscript|data)\s*(&#|%|:)/i;

/**
 * Payloads the denylist lets through. The third element is the executable
 * fragment: each test asserts the OLD guard still emits it — so deleting
 * `renderSafeHtml` cannot leave this file quietly green — and that the new one
 * does not.
 */
const BYPASSES: readonly (readonly [string, string, string])[] = [
  ['unquoted attribute', '<a href=javascript:alert(1)>x</a>', 'href=javascript:'],
  ['entity-encoded scheme', '<a href="jav&#97;script:alert(1)">x</a>', 'jav&#97;script:'],
  ['entity-encoded colon', '[x](javascript&colon;alert(1))', 'javascript&colon;'],
  [
    'svg animate',
    '<svg><animate attributeName=href values=javascript:alert(1) /></svg>',
    'values=javascript:',
  ],
  // A tab inside the scheme: browsers strip it from a URL before resolving, the
  // denylist's literal "javascript:" match never sees it.
  ['tab inside the scheme', '<a href="jav&#9;ascript:alert(1)">x</a>', 'jav&#9;ascript:'],
];

/** Payloads the denylist did stop. They must stay stopped. */
const ALREADY_BLOCKED: readonly (readonly [string, string])[] = [
  ['script element', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['details ontoggle', '<details open ontoggle=alert(1)>x</details>'],
  ['markdown link with a javascript scheme', '[x](javascript:alert(1))'],
  ['object data', '<object data=javascript:alert(1)></object>'],
];

function assertInert(payload: string, rendered: string): void {
  assert.ok(!EXECUTABLE.test(rendered), `${payload} → still executable: ${rendered}`);
  assert.ok(!/\son[a-z]+=/i.test(rendered), `${payload} → event handler survived: ${rendered}`);
  assert.ok(
    !/<(script|svg|object|iframe|embed|animate)\b/i.test(rendered),
    `${payload} → active element survived: ${rendered}`,
  );
}

for (const [name, payload, executable] of BYPASSES) {
  test(`walks past the old denylist, blocked now: ${name}`, () => {
    assert.ok(
      legacyRender(payload).includes(executable),
      `the denylist copy no longer emits "${executable}" — check it is still verbatim`,
    );
    const rendered = safeRender(payload);
    assert.ok(!rendered.includes(executable), `${payload} → survived: ${rendered}`);
    assertInert(payload, rendered);
  });
}

for (const [name, payload] of ALREADY_BLOCKED) {
  test(`stays blocked: ${name}`, () => {
    assertInert(payload, safeRender(payload));
  });
}

test('the legal documents had no sanitizer at all, so raw script reached the page', () => {
  // apps/web/lib/legal.ts fed `marked.parse()` straight into
  // dangerouslySetInnerHTML — not even the denylist stood between the two.
  const raw = marked.parse('<script>alert(1)</script>', { async: false }) as string;
  assert.equal(raw.trim(), '<script>alert(1)</script>');
  assert.equal(safeRender('<script>alert(1)</script>'), '');
});

test('ordinary help-article markdown still renders', () => {
  assert.equal(
    safeRender('## Lending a book\n\nOpen the **Loans** page and [scan](/en/t/demo/loans) it.\n'),
    '<h2>Lending a book</h2>\n<p>Open the <strong>Loans</strong> page and <a href="/en/t/demo/loans">scan</a> it.</p>',
  );
});

test('tables, code fences and external links survive intact', () => {
  const table = safeRender('| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.match(table, /<th align="left">a<\/th>/);
  assert.match(table, /<td align="right">2<\/td>/);
  assert.match(safeRender('```js\nconst x = 1;\n```'), /class="language-js"/);
  assert.match(safeRender('[site](https://libriant.com)'), /href="https:\/\/libriant\.com"/);
  assert.match(safeRender('[mail](mailto:hello@example.org)'), /href="mailto:hello@example\.org"/);
});

test('a rejected href keeps the link text, so no wording is silently lost', () => {
  assert.equal(safeRender('[read this](javascript:alert(1))'), '<p><a>read this</a></p>');
});

test('greek prose and typographic entities are not mangled', () => {
  assert.equal(
    safeRender('Καλώς ήρθατε &mdash; «Βιβλιοθήκη» & co.'),
    '<p>Καλώς ήρθατε — «Βιβλιοθήκη» &amp; co.</p>',
  );
});

test('a dropped VOID element does not swallow everything after it', () => {
  // The parser pushes a frame for a dropped tag and pops it on the close tag.
  // A void element has no close tag, so a dropped void element used to push a
  // frame nothing could pop, and the final unwind discarded every sibling that
  // followed. Silent — no error, no log, the words were simply gone.
  //
  // A GFM task list is the shape that made this real: it is what a help article
  // is made of, and `<input type=checkbox>` sits in front of the text on every
  // line. Before the fix this rendered as `<li></li><li></li>`.
  assert.equal(
    safeRender('- [x] Check every loan back in\n- [ ] Shelve the returns\n'),
    '<ul>\n<li> Check every loan back in</li>\n<li> Shelve the returns</li>\n</ul>',
  );
  // The worst case: one <meta> ate the remainder of the document.
  assert.equal(
    safeRender('<p>one</p>\n<meta charset="utf-8">\n<p>two</p>'),
    '<p>one</p>\n\n<p>two</p>',
  );
  // Still dropped, though — surviving the element must not mean rendering it.
  assert.equal(safeRender('<p>a<input type="checkbox">b</p>'), '<p>ab</p>');
});
