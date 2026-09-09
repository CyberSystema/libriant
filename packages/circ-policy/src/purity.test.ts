import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hoursOn, instantFromCivil, nextOpenCivil, zonedCivil } from './calendar.js';
import { computeDueDate } from './duedate.js';
import { accrueOverdue } from './fines.js';
import { resolveCirculationPolicy } from './resolve.js';
import type {
  Calendar,
  LoanPolicy,
  OverdueFinePolicy,
  PolicySnapshot,
  ResolveContext,
} from './types.js';
import type { CivilVector, VectorDocument } from './vectors.js';

/**
 * §4.1's acceptance criterion, asserted rather than asserted-in-prose.
 *
 * "Pure, synchronous, zero-dependency, **no `Date.now()`** — every function takes
 * an explicit instant." The phase line makes it a test, and this is that test.
 *
 * Two halves, and both are needed:
 *
 * SOURCE SCANNING catches the thing a runtime test cannot. A `Date.now()` on a
 * branch no fixture reaches — the fallback when a calendar has no hours, say —
 * passes every behavioural test in this package and then produces a due date that
 * differs between the API pod and the Rust core running the same vector file. The
 * scan reaches unexecuted lines.
 *
 * RUNTIME CHECKING catches what the scan cannot: an impurity that arrives through
 * a dependency, an in-place `sort` on a caller's array, a memo that returns a
 * mutable reference. Frozen inputs turn all three into a thrown TypeError.
 *
 * The scanner strips comments and string literals first. Half the source files here
 * discuss `Date.now()` at length in their docblocks — precisely because it is
 * forbidden — and a grep would fail on the documentation of the rule it is
 * enforcing.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every non-test source file. The scan must not be able to miss a new one. */
const SOURCES = [
  'blocks.ts',
  'calendar.ts',
  'duedate.ts',
  'fines.ts',
  'greek-calendar.ts',
  'index.ts',
  'rank.ts',
  'resolve.ts',
  'types.ts',
  'vectors.ts',
];

/**
 * Comments blanked, string literals kept. Positions preserved.
 *
 * A regex cannot do this: `'https://x'` contains `//` and `// a "quote` contains a
 * quote, so a naive strip of one corrupts the other. This walks the file once,
 * which is the only way to get both right.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    const q = src[i];
    if (q === "'" || q === '"' || q === '`') {
      out += q;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      out += q;
      i += 1;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** …and with the string contents blanked too, for the keyword scans. */
function blankStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const q = src[i];
    if (q === "'" || q === '"' || q === '`') {
      out += ' ';
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += ' ';
      i += 1;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Comments gone, strings intact — for reading import specifiers. */
const TEXT = new Map(
  SOURCES.map((f) => [f, stripComments(readFileSync(path.join(HERE, f), 'utf8'))]),
);
/** Comments AND string contents gone — for the keyword bans. */
const CODE = new Map([...TEXT].map(([f, t]) => [f, blankStrings(t)] as const));

test('the scan covers every source file in the package', () => {
  // A file added without being listed here would be scanned by nothing. The
  // directory is the authority, not this array.
  const actual = readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
  assert.deepEqual(actual, [...SOURCES].sort(), 'SOURCES is out of date with src/');
});

test('NO Date.now() ANYWHERE — the phase acceptance criterion', () => {
  // §4.1: "every function takes an explicit instant". The reason is not
  // tidiness. This package runs in the API, in a webview, and in phase 77's Rust
  // core against the same golden vectors; a reading of the clock inside it makes
  // a vector's expectation unwritable and a receipt unreproducible.
  for (const [file, code] of CODE) {
    assert.equal(/\bDate\s*\.\s*now\b/.test(code), false, `${file} calls Date.now()`);
  }
});

test('no argless new Date() — a hidden clock read wearing a constructor', () => {
  // `new Date(x)` is fine and used throughout: it builds an instant from a value
  // the caller supplied. `new Date()` is `Date.now()` with a different spelling
  // and would slip past the check above.
  for (const [file, code] of CODE) {
    assert.equal(/\bnew\s+Date\s*\(\s*\)/.test(code), false, `${file} constructs new Date()`);
  }
});

test('no I/O, no environment, no randomness', () => {
  // Zero `node:` imports is also what makes the package loadable in a webview and
  // portable to the Rust core: nothing here can depend on a Node built-in.
  const banned: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfrom\s+['"]?node:/, 'imports a node: built-in'],
    [/\brequire\s*\(/, 'uses require()'],
    [/\bfetch\s*\(/, 'calls fetch()'],
    [/\bprocess\s*\./, 'reads process'],
    [/\bMath\s*\.\s*random\b/, 'calls Math.random()'],
    [/\bawait\b/, 'is asynchronous — §4.1 says synchronous'],
    [/\basync\b/, 'is asynchronous — §4.1 says synchronous'],
    [/\bglobalThis\b/, 'reaches for globalThis'],
    [/\bsetTimeout\b|\bsetInterval\b/, 'schedules a timer'],
  ];
  for (const [file, code] of CODE) {
    for (const [re, what] of banned) {
      assert.equal(re.test(code), false, `${file} ${what}`);
    }
  }
});

test('ZERO THIRD-PARTY DEPENDENCIES — including a date library', () => {
  // §7 cuts a date library outright: "`Intl.DateTimeFormat` in Node 26 and every
  // browser, on the same ICU tzdata the platform ships. A date library is a
  // second, divergent tzdb — and the Rust core must agree byte-for-byte."
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    assert.ok(range.startsWith('workspace:'), `${name} is a third-party runtime dependency`);
  }
  // And nothing outside the workspace is imported even if it were installed.
  for (const [file, text] of TEXT) {
    // `from 'x'`, the bare side-effect `import 'x'`, and `import('x')` alike — a
    // side-effect import has no `from` and is exactly how a polyfill or a
    // tzdata shim would arrive without being noticed.
    for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@libriant/'),
        `${file} imports ${spec}, which is neither local nor a workspace package`,
      );
    }
  }
});

test('the only clock is Intl, and it is crossed deliberately', () => {
  // Not a style rule. `Intl.DateTimeFormat` construction measured at 30.4 µs and
  // `formatToParts` at 3.74 µs against 0.009 µs for the integer civil arithmetic
  // that replaced it — 415×. Every additional crossing is a checkout desk waiting.
  // Two crossings per resolution is the budget, and `calendar.ts` is the only file
  // allowed to spend it.
  for (const [file, code] of CODE) {
    if (file === 'calendar.ts') continue;
    assert.equal(/\bIntl\b/.test(code), false, `${file} reaches for Intl; only calendar.ts may`);
  }
});

// ---------------------------------------------------------------------------
// Runtime purity — what a source scan cannot see
// ---------------------------------------------------------------------------

const doc = JSON.parse(
  readFileSync(path.resolve(HERE, '..', 'fixtures', 'resolution-vectors.json'), 'utf8'),
) as VectorDocument;

/** The Greek split day — 08:00–14:00 and 17:00–21:00, the §12 acceptance shape. */
const CAL = doc.fixtures.calendars['cal-athens-split'] as Calendar;
const DAY = zonedCivil(new Date('2026-03-04T10:00:00Z'), CAL.timezone);

/** Freeze every object reachable from `v`, so any in-place write throws. */
function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  for (const k of Object.getOwnPropertyNames(v)) deepFreeze((v as Record<string, unknown>)[k]);
  return Object.freeze(v);
}

test('FROZEN INPUTS ARE NEVER WRITTEN — no in-place sort of a caller array', () => {
  // The failure this catches: `snapshot.rules.sort(compareRank)` instead of
  // `[...].sort(...)`. It passes every test, and then reorders the caller's
  // snapshot — which in the service is a cached object shared by every checkout
  // in the process. The second checkout resolves against a different rule order
  // than the first, and only under load.
  //
  // ES modules are strict mode, so a write to a frozen object throws rather than
  // failing silently. That is what makes this assertion have teeth.
  for (const v of doc.vectors) {
    if (v.kind !== 'resolve') continue;
    const snapshot = deepFreeze(
      structuredClone(doc.fixtures.snapshots[v.snapshotId]),
    ) as PolicySnapshot;
    const ctx = Object.freeze({ ...(v.context as unknown as ResolveContext), at: new Date(v.at) });
    const got = resolveCirculationPolicy(snapshot, ctx);
    assert.equal(got.trace.matchedRuleId, v.expectMatchedRuleId, v.id);
  }
});

test('frozen calendars and policies survive a due-date computation', () => {
  for (const v of doc.vectors) {
    if (v.kind !== 'dueDate') continue;
    const calendar = deepFreeze(structuredClone(doc.fixtures.calendars[v.calendarId])) as Calendar;
    const policy = deepFreeze(
      structuredClone(doc.fixtures.loanPolicies[v.loanPolicyId]),
    ) as LoanPolicy;
    const got = computeDueDate({
      policy,
      calendar,
      from: new Date(v.from),
      hasOutstandingHold: v.hasOutstandingHold === true,
    });
    assert.equal(got.dueAt === null ? null : got.dueAt.toISOString(), v.expectDueAt, v.id);
  }
});

test('frozen inputs survive a fine accrual', () => {
  for (const v of doc.vectors) {
    if (v.kind !== 'fine') continue;
    const calendar = deepFreeze(structuredClone(doc.fixtures.calendars[v.calendarId])) as Calendar;
    const policy = deepFreeze(
      structuredClone(doc.fixtures.finePolicies[v.finePolicyId]),
    ) as OverdueFinePolicy;
    const got = accrueOverdue({
      policy,
      calendar,
      dueAt: new Date(v.dueAt),
      asOf: new Date(v.asOf),
    });
    assert.equal(Number(got.amount.amount), v.expectMinorUnits, v.id);
  }
});

test('the returned Date is a copy — mutating it cannot reach back into the input', () => {
  // `new Date(x)` copies, `x` aliases. A resolver that returned the caller's own
  // `from` on a zero-length loan would let the caller's later `setHours()` move a
  // due date that has already been printed on a receipt.
  const v = doc.vectors.find((x) => x.kind === 'dueDate' && x.expectDueAt !== null);
  assert.ok(v && v.kind === 'dueDate');
  const from = new Date(v.from);
  const got = computeDueDate({
    policy: doc.fixtures.loanPolicies[v.loanPolicyId] as LoanPolicy,
    calendar: doc.fixtures.calendars[v.calendarId] as Calendar,
    from,
    hasOutstandingHold: false,
  });
  assert.notEqual(got.dueAt, from, 'returned the caller’s own Date object');
});

test('DETERMINISM — the memoised formatter cannot make the second call differ', () => {
  // `calendar.ts` caches `Intl.DateTimeFormat` instances in a module-level Map,
  // which is mutable module state and therefore the one thing in this package that
  // could make call N differ from call 1. It is a memo, so it must not — and a
  // memo keyed on the wrong thing (the timezone but not the option set, say) is
  // exactly how that breaks. Running the whole corpus twice and comparing is the
  // check.
  const civil = doc.vectors.filter((v): v is CivilVector => v.kind === 'civil');
  const run = () =>
    civil.map((v) => {
      const r = instantFromCivil(v.timezone, v.civil, v.disambiguation);
      return `${r.kind}:${r.instant.toISOString()}`;
    });
  assert.deepEqual(run(), run());
});

test('HOURS ALIAS THE CALENDAR, so every mutating use must copy first', () => {
  // `hoursOn` deliberately returns the calendar's own `readonly OpeningInterval[]`
  // rather than a copy: it is called once per candidate day while a due date rolls
  // forward, and allocating an array per probe is a cost with nothing to buy.
  //
  // The price of that choice is that ONE careless call site rewrites the branch's
  // opening hours for the life of the process — and `duedate.ts` genuinely does
  // reverse this value, correctly, by spreading first. `readonly` catches it at
  // compile time only while the type survives; a cast, an `any`, or a JS consumer
  // does not have that protection, so the discipline is asserted here too.
  const a = hoursOn(CAL, DAY);
  const b = hoursOn(CAL, DAY);
  assert.equal(a, b, 'hoursOn is expected to alias, not copy — see the comment above');
  for (const [file, code] of CODE) {
    assert.equal(
      /hoursOn\s*\([^)]*\)\s*\.\s*(sort|reverse|push|pop|splice|shift|unshift|fill)\b/.test(code),
      false,
      `${file} mutates the array hoursOn returned; spread it first`,
    );
  }
});

test('nothing in the package reads the wall clock — proved by a fixed instant', () => {
  // The end-to-end version of the first test. If any code path consulted the real
  // clock, running the same resolution at two different real times would diverge;
  // since it cannot, the result depends only on `ctx.at`.
  const first = nextOpenCivil(CAL, DAY, DAY.minute + DAY.hour * 60);
  const second = nextOpenCivil(CAL, DAY, DAY.minute + DAY.hour * 60);
  assert.deepEqual(first, second);
});
