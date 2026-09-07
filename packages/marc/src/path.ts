import {
  MarcError,
  isControlField,
  isDataField,
  subfieldCode,
  subfieldValue,
  type MarcField,
  type MarcRecord,
} from './types.js';

/**
 * How a single place in a MARC record is named.
 *
 * ## A deliberate syntactic subset of MARCspec
 *
 * Not a new invention and not the whole of MARCspec. The addressing core is
 * borrowed exactly — `245[0]$a[1]`, `008/07-10`, `LDR/06`, `245^2` — so a
 * cataloguer who has met MARCspec is not surprised and a later gate can assert
 * that every Libriant path is also a valid MARCspec. Three things are removed on
 * purpose, and writing down why is the point of this comment:
 *
 *   - **Subspecs** (`245{$a~'Zorba'}`) turn an address into a query. A query
 *     language belongs to the report builder (phase 91), not to the thing an
 *     edit operation is addressed with, and having one here would mean an op
 *     could match a different node after an earlier op in the same batch.
 *   - **Tag and subfield-code ranges** (`2XX`, `$a-$c`) mean one op edits an
 *     unknown number of places. Every op in this system carries the old value it
 *     expects, and it cannot do that if it does not know how many nodes it hits.
 *   - **MARCspec's implicit "all occurrences"** when an index is omitted. This
 *     is the important one. In an OP path, every repeatable level must be
 *     indexed explicitly: `245[0]$a[0]`, never `245$a`. Two paths that look
 *     identical and mean different things in the two systems is the kind of
 *     divergence that is discovered by a batch edit hitting five hundred records
 *     instead of one. The abbreviated form stays legal for READING, where
 *     "the first one" is a harmless convenience.
 *
 * ```
 * path        ::= leaderPath | fieldPath
 * leaderPath  ::= "LDR" charSpec?
 * fieldPath   ::= tag occ? tail?
 * tail        ::= indSpec | charSpec | subPath
 * tag         ::= tagChar tagChar tagChar
 * occ         ::= "[" ( NUMBER | "#" | "*" ) "]"      ; 0-based, # last, * all
 * indSpec     ::= "^" ( "1" | "2" )
 * charSpec    ::= "/" pos ( "-" pos )?                ; 0-based, inclusive
 * pos         ::= NUMBER | "#"
 * subPath     ::= "$" subCode occ? charSpec?
 * ```
 *
 * Insertion POSITIONS are deliberately not expressible. `insertField` carries a
 * numeric `at`; a path that could denote the gap between two fields would stop
 * being a selector, and `get()` would stop being total.
 */

export type PathIndex =
  | { readonly type: 'at'; readonly n: number }
  | { readonly type: 'last' }
  | { readonly type: 'all' }
  /** No `[...]` was written. Means "the first" when reading, and is illegal in an op. */
  | { readonly type: 'implicit' };

export type CharRange = {
  readonly from: number;
  /** Inclusive. `'last'` for the `#` end marker. */
  readonly to: number | 'last';
};

export type LeaderPath = {
  readonly kind: 'leader';
  readonly chars?: CharRange;
};

export type FieldPath = {
  readonly kind: 'field';
  readonly tag: string;
  readonly occ: PathIndex;
  /** `^1` or `^2`. Mutually exclusive with `chars` and `sub`. */
  readonly indicator?: 1 | 2;
  /** `/n-m` on a control field. Mutually exclusive with `sub`. */
  readonly chars?: CharRange;
  readonly sub?: {
    readonly code: string;
    readonly occ: PathIndex;
    readonly chars?: CharRange;
  };
};

export type MarcPath = LeaderPath | FieldPath;

const TAG = /^[0-9A-Za-z]{3}$/;

/**
 * Parse a path for READING. Permits `[*]`, `[#]` and omitted indices.
 *
 * Throws `MarcError('path-invalid')` with the offending text: a path arrives
 * from a rule pack, an AI suggestion or a report definition, and "invalid path"
 * with no path in it is unactionable.
 */
export function parseMarcPath(text: string): MarcPath {
  const fail = (why: string): never => {
    throw new MarcError('path-invalid', `Invalid MARC path "${text}": ${why}`);
  };
  if (!text) return fail('it is empty.');

  if (text.startsWith('LDR')) {
    const rest = text.slice(3);
    if (!rest) return { kind: 'leader' };
    if (!rest.startsWith('/')) return fail('after LDR only a /position is allowed.');
    return { kind: 'leader', chars: parseCharSpec(rest, fail) };
  }

  const tag = text.slice(0, 3);
  if (!TAG.test(tag)) return fail('a path starts with a three-character tag or LDR.');
  let rest = text.slice(3);

  let occ: PathIndex = { type: 'implicit' };
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return fail('an unclosed "[".');
    occ = parseIndex(rest.slice(1, close), fail);
    rest = rest.slice(close + 1);
  }

  if (!rest) return { kind: 'field', tag, occ };

  if (rest.startsWith('^')) {
    const which = rest.slice(1);
    if (which !== '1' && which !== '2') return fail('an indicator is ^1 or ^2.');
    return { kind: 'field', tag, occ, indicator: which === '1' ? 1 : 2 };
  }

  if (rest.startsWith('/')) {
    return { kind: 'field', tag, occ, chars: parseCharSpec(rest, fail) };
  }

  if (rest.startsWith('$')) {
    let sub = rest.slice(1);
    if (!sub) return fail('a "$" with no subfield code.');
    const code = sub[0] as string;
    sub = sub.slice(1);
    let subOcc: PathIndex = { type: 'implicit' };
    if (sub.startsWith('[')) {
      const close = sub.indexOf(']');
      if (close < 0) return fail('an unclosed "[".');
      subOcc = parseIndex(sub.slice(1, close), fail);
      sub = sub.slice(close + 1);
    }
    const chars = sub ? parseCharSpec(sub, fail) : undefined;
    return { kind: 'field', tag, occ, sub: { code, occ: subOcc, ...(chars ? { chars } : {}) } };
  }

  return fail(`unexpected "${rest[0]}".`);
}

/**
 * Parse a path that will ADDRESS AN EDIT.
 *
 * Stricter than {@link parseMarcPath} in exactly one way, and it is the whole
 * reason the two functions are separate: every repeatable level must be indexed.
 * A path that could name more than one node cannot carry the old value an
 * invertible operation needs, and a path whose meaning depends on a MARCspec
 * default is a path that means something else in somebody else's tool.
 */
export function parseOpPath(text: string): MarcPath {
  const path = parseMarcPath(text);
  const fail = (why: string): never => {
    throw new MarcError('path-not-addressable', `"${text}" cannot address an edit: ${why}`);
  };
  if (path.kind === 'leader') return path;
  if (path.occ.type === 'all' || path.occ.type === 'last') {
    return fail('an edit must name one field, so [*] and [#] are not allowed.');
  }
  if (path.occ.type === 'implicit') {
    return fail(`fields repeat, so the occurrence must be written out — "${path.tag}[0]…".`);
  }
  if (path.sub) {
    if (path.sub.occ.type === 'all' || path.sub.occ.type === 'last') {
      return fail('an edit must name one subfield, so [*] and [#] are not allowed.');
    }
    if (path.sub.occ.type === 'implicit') {
      return fail(`subfields repeat, so write "$${path.sub.code}[0]".`);
    }
  }
  return path;
}

function parseIndex(text: string, fail: (why: string) => never): PathIndex {
  if (text === '*') return { type: 'all' };
  if (text === '#') return { type: 'last' };
  if (!/^\d+$/.test(text)) return fail(`"[${text}]" is not an index.`);
  return { type: 'at', n: Number(text) };
}

function parseCharSpec(text: string, fail: (why: string) => never): CharRange {
  const body = text.slice(1);
  const [fromText, toText, ...extra] = body.split('-');
  if (extra.length) return fail('a character range has at most one "-".');
  if (fromText === undefined || !/^\d+$/.test(fromText)) {
    return fail(`"/${body}" does not start with a position.`);
  }
  const from = Number(fromText);
  if (toText === undefined) return { from, to: from };
  if (toText === '#') return { from, to: 'last' };
  if (!/^\d+$/.test(toText)) return fail(`"${toText}" is not a position.`);
  const to = Number(toText);
  if (to < from) return fail('the range ends before it starts.');
  return { from, to };
}

/** Render a parsed path back to its canonical text. Round-trips. */
export function formatMarcPath(path: MarcPath): string {
  const idx = (i: PathIndex): string =>
    i.type === 'implicit' ? '' : i.type === 'all' ? '[*]' : i.type === 'last' ? '[#]' : `[${i.n}]`;
  // Two digits, always. MARC writes `008/07-10` and `LDR/06`, never `008/7-10`,
  // and a formatter that dropped the zero would not round-trip its own output.
  const pos = (n: number): string => String(n).padStart(2, '0');
  const chars = (c?: CharRange): string =>
    !c
      ? ''
      : c.to === 'last'
        ? `/${pos(c.from)}-#`
        : c.from === c.to
          ? `/${pos(c.from)}`
          : `/${pos(c.from)}-${pos(c.to)}`;
  if (path.kind === 'leader') return `LDR${chars(path.chars)}`;
  let out = `${path.tag}${idx(path.occ)}`;
  if (path.indicator) return `${out}^${path.indicator}`;
  if (path.chars) return out + chars(path.chars);
  if (path.sub) out += `$${path.sub.code}${idx(path.sub.occ)}${chars(path.sub.chars)}`;
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Every field with a given tag, in record order. */
export function fieldsWithTag(record: MarcRecord, tag: string): MarcField[] {
  return record.fields.filter((f) => f.t === tag);
}

function pick<T>(items: readonly T[], index: PathIndex): T[] {
  switch (index.type) {
    case 'all':
      return [...items];
    case 'last':
      return items.length ? [items[items.length - 1] as T] : [];
    case 'at':
      return index.n < items.length ? [items[index.n] as T] : [];
    case 'implicit':
      return items.length ? [items[0] as T] : [];
  }
}

function slice(value: string, range?: CharRange): string {
  if (!range) return value;
  const to = range.to === 'last' ? value.length - 1 : range.to;
  return value.slice(range.from, to + 1);
}

/**
 * Read every value a path names. Empty when it names nothing.
 *
 * An array even for a path that can only match once, so a caller never has to
 * know which kind of path it was handed. {@link getOne} is the convenience for
 * when it does.
 */
export function get(record: MarcRecord, path: MarcPath | string): string[] {
  const p = typeof path === 'string' ? parseMarcPath(path) : path;
  if (p.kind === 'leader') return [slice(record.leader, p.chars)];

  const fields = pick(fieldsWithTag(record, p.tag), p.occ);
  const out: string[] = [];
  for (const f of fields) {
    if (p.indicator) {
      if (isDataField(f)) out.push(f.i[p.indicator - 1] ?? ' ');
      continue;
    }
    if (p.sub) {
      if (!isDataField(f)) continue;
      const matching = f.s.filter((s) => subfieldCode(s) === p.sub!.code);
      for (const s of pick(matching, p.sub.occ)) out.push(slice(subfieldValue(s), p.sub.chars));
      continue;
    }
    if (isControlField(f)) {
      out.push(slice(f.v, p.chars));
      continue;
    }
    // A whole data field with no subfield named: the concatenation of its
    // subfield values, which is what every display and index rule means by "the
    // 245". Deliberately without the subfield codes — a caller that needs those
    // has the record.
    out.push(f.s.map(subfieldValue).join(' '));
  }
  return out;
}

/** The first value a path names, or undefined. */
export function getOne(record: MarcRecord, path: MarcPath | string): string | undefined {
  return get(record, path)[0];
}

/** Whether a path names anything at all. */
export function exists(record: MarcRecord, path: MarcPath | string): boolean {
  return get(record, path).length > 0;
}
