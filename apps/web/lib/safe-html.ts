import { createElement, type ReactNode } from 'react';

/**
 * Render a markdown-produced HTML string as React elements, keeping only an
 * explicit allowlist of tags, attributes and URL schemes.
 *
 * input-and-files-04. This app has exactly two HTML sinks — the help-article
 * body and the public legal documents — and both went straight into
 * `dangerouslySetInnerHTML`. The help body had first passed the four-`.replace()
 * denylist in `scripts/ingest-help-articles.ts`; the legal body had passed
 * nothing at all. The denylist does not hold. Run against the real function,
 * these three come out byte-identical:
 *
 *   <a href=javascript:alert(1)>x</a>          (its scheme regex demands a quote after `=`)
 *   <a href="jav&#97;script:alert(1)">x</a>    (it matches the literal text "javascript:")
 *   <svg><animate attributeName=href values=javascript:alert(1)/>…</svg>   (it only reads href/src)
 *
 * and `script-src 'unsafe-inline'` (next.config.mjs) means nothing catches them
 * afterwards. Adding a fifth pattern is the same bet a sixth time.
 *
 * What this does instead: parse the HTML ourselves, emit React elements, and
 * never hand a string back to the browser's HTML parser. That removes the whole
 * mutation-XSS family too — those attacks work by getting the sanitizer and the
 * browser to disagree about the same bytes, and here there is no second parse to
 * disagree with. Anything not on the allowlist below is unwrapped (its text
 * survives, its tag does not) or, for active-content elements, dropped whole.
 *
 * Rejected: pulling in `sanitize-html` / `isomorphic-dompurify`. Both still
 * produce a *string* that `dangerouslySetInnerHTML` re-parses, DOMPurify needs a
 * DOM shim in a server render, and the element set we actually emit is markdown
 * output — small, known, and fully covered here. A new runtime dependency buys
 * no safety we do not already have.
 *
 * Today's authors are people with commit access, so nothing here is remotely
 * exploitable. The point is that the next step the product wants — admin-authored
 * help, a library writing its own notices — must not be one commit away from
 * stored XSS in the shell every librarian works inside all day.
 */

type Attrs = Record<string, string>;

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; tag: string; attrs: Attrs; selfClosing: boolean }
  | { kind: 'close'; tag: string };

/** Every element `marked` can emit from our markdown, and nothing else. */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'span',
  'div',
  'figure',
  'figcaption',
]);

/**
 * Every void element in the HTML spec, not just the ones we allow.
 *
 * This set is consulted before the drop/keep/unwrap decision is acted on, so it
 * has to be COMPLETE rather than merely covering the allowlist. It originally
 * held only br/hr/img/wbr, and the eight missing ones — input, meta, link,
 * base, source, track, embed, area, col, param — are all in DROP_SUBTREE. A
 * dropped non-void tag pushes a frame that its close tag pops; a dropped VOID
 * tag pushed a frame that nothing could ever pop, so the unwind at the end
 * discarded every sibling that followed it.
 *
 * The visible effect was silent content loss on the two markdown-authored
 * surfaces this module exists to serve. A GFM task list — exactly what a help
 * article is made of — rendered as empty bullets, because `<input
 * type=checkbox>` ate the text beside it. A single `<meta>` ate the entire rest
 * of the page. No error, no log, the sentence simply was not there.
 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Tags whose *contents* go too. Unwrapping `<script>alert(1)</script>` would
 * print "alert(1)" as visible prose, and `<svg>` is the classic sanitizer
 * bypass surface (`<animate attributeName="href">`, `<set>`, `<foreignObject>`),
 * so nothing inside either is worth keeping.
 */
const DROP_SUBTREE = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'title',
  'textarea',
  'xmp',
  'frame',
  'frameset',
  'applet',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'option',
]);

/** React warns (loudly, in every render) about whitespace text nodes here. */
const TABLE_STRUCTURE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr']);

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  code: ['class'],
  pre: ['class'],
  th: ['align', 'colspan', 'rowspan', 'scope'],
  td: ['align', 'colspan', 'rowspan'],
};

const REACT_ATTR: Record<string, string> = {
  class: 'className',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
};

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * The subset of named entities our markdown actually contains, plus the five
 * `marked` emits when it escapes text. Decoding matters beyond display: an
 * attribute value has to be decoded *before* its scheme is checked, which is
 * precisely what the old denylist skipped.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  euro: '€',
  copy: '©',
  deg: '°',
  times: '×',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g;

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        // Lone surrogate — leave the source text alone.
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const WS_RE = /\s/;
const ATTR_BOUNDARY_RE = /[\s/>=]/;
const TAG_NAME_RE = /[a-zA-Z]/;
const OPEN_NAME_RE = /<([a-zA-Z][a-zA-Z0-9:_.-]*)/y;
const CLOSE_NAME_RE = /<\/\s*([a-zA-Z][a-zA-Z0-9:_.-]*)[^>]*>?/y;

/**
 * Decide whether a URL may be handed to the browser as an `href`/`src`.
 *
 * The value arrives already entity-decoded. Browsers additionally ignore C0
 * control characters and whitespace *inside* a scheme, so `jav&#9;ascript:` and
 * a newline-split scheme both execute — strip them before looking. A URL with no
 * scheme is relative and cannot execute; protocol-relative `//host` is rejected
 * because nothing we author uses it and it would silently leave the origin.
 */
function safeUrl(raw: string): string | null {
  let probe = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code > 0x20 && code !== 0x7f) probe += ch;
  }
  if (probe.startsWith('//')) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return raw.trim();
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase()) ? raw.trim() : null;
}

function parseOpenTag(html: string, start: number): { token: Token; end: number } | null {
  OPEN_NAME_RE.lastIndex = start;
  const nameMatch = OPEN_NAME_RE.exec(html);
  if (!nameMatch) return null;
  const tag = nameMatch[1]!.toLowerCase();
  const attrs: Attrs = {};
  let selfClosing = false;
  let i = OPEN_NAME_RE.lastIndex;

  while (i < html.length) {
    while (i < html.length && WS_RE.test(html[i]!)) i++;
    if (i >= html.length) break;
    if (html[i] === '>') {
      i++;
      break;
    }
    if (html[i] === '/' && html[i + 1] === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    if (html[i] === '/' || html[i] === '=') {
      i++;
      continue;
    }

    let nameEnd = i;
    while (nameEnd < html.length && !ATTR_BOUNDARY_RE.test(html[nameEnd]!)) nameEnd++;
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < html.length && WS_RE.test(html[i]!)) i++;

    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && WS_RE.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, close === -1 ? html.length : close);
        i = close === -1 ? html.length : close + 1;
      } else {
        let end = i;
        while (end < html.length && !/[\s>]/.test(html[end]!)) end++;
        value = html.slice(i, end);
        i = end;
      }
    }
    if (name.length > 0) attrs[name] = decodeEntities(value);
  }

  return { token: { kind: 'open', tag, attrs, selfClosing }, end: i };
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart)
      tokens.push({ kind: 'text', text: decodeEntities(html.slice(textStart, end)) });
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1];
    // A `<` that starts nothing is just text ("a < b").
    if (
      next === undefined ||
      !(TAG_NAME_RE.test(next) || next === '/' || next === '!' || next === '?')
    ) {
      i = lt + 1;
      continue;
    }

    if (next === '!' || next === '?') {
      let end: number;
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        end = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf('>', lt + 2);
        end = close === -1 ? html.length : close + 1;
      }
      flushText(lt);
      i = end;
      textStart = end;
      continue;
    }

    if (next === '/') {
      CLOSE_NAME_RE.lastIndex = lt;
      const match = CLOSE_NAME_RE.exec(html);
      if (!match) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      tokens.push({ kind: 'close', tag: match[1]!.toLowerCase() });
      i = CLOSE_NAME_RE.lastIndex;
      textStart = i;
      continue;
    }

    const open = parseOpenTag(html, lt);
    if (!open) {
      i = lt + 1;
      continue;
    }
    flushText(lt);
    tokens.push(open.token);
    i = open.end;
    textStart = i;
  }

  flushText(html.length);
  return tokens;
}

function attrValueIsSafe(name: string, value: string): boolean {
  switch (name) {
    case 'class':
      // Only the `language-*` hook `marked` puts on fenced code.
      return /^language-[a-zA-Z0-9+#._-]+$/.test(value);
    case 'align':
      return ['left', 'right', 'center', 'justify'].includes(value.toLowerCase());
    case 'scope':
      return ['row', 'col', 'rowgroup', 'colgroup'].includes(value.toLowerCase());
    case 'width':
    case 'height':
    case 'colspan':
    case 'rowspan':
      return /^[0-9]{1,4}$/.test(value);
    default:
      // alt / title are prose; React escapes them on the way out.
      return true;
  }
}

function propsFor(tag: string, attrs: Attrs): Record<string, unknown> | null {
  const allowed = ALLOWED_ATTRS[tag];
  const props: Record<string, unknown> = {};
  if (!allowed) return props;

  for (const name of allowed) {
    const raw = attrs[name];
    if (raw === undefined) continue;

    if (name === 'href' || name === 'src') {
      const url = safeUrl(raw);
      if (url === null) {
        // A link keeps its text and loses its destination; an image with a
        // rejected source has nothing left to show, so the caller drops it.
        if (name === 'src') return null;
        continue;
      }
      props[name] = url;
      continue;
    }
    if (!attrValueIsSafe(name, raw)) continue;
    props[REACT_ATTR[name] ?? name] = raw;
  }
  return props;
}

function build(tokens: Token[]): ReactNode[] {
  type Frame = {
    tag: string;
    attrs: Attrs;
    children: ReactNode[];
    mode: 'keep' | 'unwrap' | 'drop';
  };

  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  let key = 0;

  const currentChildren = (): ReactNode[] => stack[stack.length - 1]?.children ?? root;
  const currentTag = (): string => stack[stack.length - 1]?.tag ?? '';

  const emitElement = (tag: string, attrs: Attrs, children: ReactNode[], into: ReactNode[]) => {
    const props = propsFor(tag, attrs);
    if (props === null) return;
    props.key = `n${key++}`;
    into.push(
      VOID_TAGS.has(tag)
        ? createElement(tag, props)
        : createElement(tag, props, children.length > 0 ? children : undefined),
    );
  };

  const closeFrame = (frame: Frame) => {
    const into = currentChildren();
    if (frame.mode === 'keep') emitElement(frame.tag, frame.attrs, frame.children, into);
    else if (frame.mode === 'unwrap') into.push(...frame.children);
  };

  for (const token of tokens) {
    if (token.kind === 'text') {
      if (TABLE_STRUCTURE.has(currentTag()) && token.text.trim() === '') continue;
      currentChildren().push(token.text);
      continue;
    }

    if (token.kind === 'open') {
      const mode: Frame['mode'] = DROP_SUBTREE.has(token.tag)
        ? 'drop'
        : ALLOWED_TAGS.has(token.tag)
          ? 'keep'
          : 'unwrap';
      if (token.selfClosing || VOID_TAGS.has(token.tag)) {
        if (mode === 'keep') emitElement(token.tag, token.attrs, [], currentChildren());
        continue;
      }
      stack.push({ tag: token.tag, attrs: token.attrs, children: [], mode });
      continue;
    }

    // Close: unwind to the nearest matching open tag. A stray `</div>` with no
    // opener is ignored rather than allowed to pop somebody else's frame.
    let depth = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.tag === token.tag) {
        depth = i;
        break;
      }
    }
    if (depth === -1) continue;
    while (stack.length > depth) closeFrame(stack.pop()!);
  }

  while (stack.length > 0) closeFrame(stack.pop()!);
  return root;
}

/**
 * Parse `html` and return React children. Safe to render directly:
 *
 *   <article className="lbr-prose">{renderSafeHtml(article.bodyHtml)}</article>
 */
export function renderSafeHtml(html: string): ReactNode[] {
  return build(tokenize(html));
}
