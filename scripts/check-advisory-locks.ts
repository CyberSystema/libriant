#!/usr/bin/env tsx
// An advisory lock is taken through `platform/locks.ts`, or it is not taken.
//
// §6 phase 16: "`locks.ts` that SORTS keys by domain rank (patron < bib < item)
// before acquiring, with a CI grep forbidding a bare `pg_advisory_xact_lock`
// outside it."
//
// ## What a bare lock costs, which is not obvious from the call site
//
// A hand-written `pg_advisory_xact_lock(hashtextextended('item:x', 0))` looks
// correct in isolation and IS correct in isolation. What it cannot do is agree
// with the other lock some other transaction is taking at the same moment. Two
// transactions that take the same two locks in opposite orders deadlock, and
// Postgres resolves that by killing one — which reaches a librarian as a save
// that failed with no explanation.
//
// Measured on these tables during phase 16: a checkin that takes `item:` then
// `patron:` — the natural order, because checkin is keyed on a barcode and
// cannot know the patron until it has read the loan — produced 17 `40P01` in
// fifteen seconds against a concurrent checkout, the first at 1,165 ms. Through
// `orderLocks` the same workload produced zero.
//
// So the rule is not "locks are dangerous". It is that the ORDER has to be
// decided in one place, and a call site that spells the lock itself has opted
// out of that place without saying so.
//
// ## Why this reads text, and why ESLint reads the same tree
//
// `eslint.config.mjs` bans the token inside a template literal, which is precise
// and structurally comment-blind — it sees `TemplateElement` and never a
// docblock. It cannot read SQL. This gate reads both, and strips comments
// itself so the eight doc-comment mentions of the token in `apps/api/src` are
// not eight allowlist entries.
//
// That is the same complementary-blindness argument `check:item-status-writer`
// makes for the item-status boundary, and the same conclusion: either mechanism
// alone is a boundary with a door in it.
//
// ## Why it lands now and not in phase 10
//
// `apps/api/src/platform/locks.ts` deferred it, and wrote down why: "a gate
// shipped with 25 allowlist entries pointing at code the phase-20 cutover
// deletes is a gate that checks nothing while looking like coverage." Phase 16
// found nineteen bare call sites and they fall into three groups rather than
// one — nine that phase 20 deletes, nine control-plane locks in a different
// database, and one in the 2.0 tree, which is now a `policy` domain. The tenant
// plane this gate exists to guard therefore has ZERO exemptions on it, which is
// the only state in which a gate is worth having.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Everywhere a lock could be taken against a tenant or the control plane. */
const ROOTS = ['apps/api/src', 'scripts', 'packages/db-tenant/prisma'];

/**
 * The token, in every spelling. `pg_catalog.`-qualified and bare, transaction
 * and session scoped, and the `_shared` and `_try` variants that do not appear
 * in this repository today and would be just as unordered if they did.
 */
const LOCK_CALL = /\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\s*\(/;

/**
 * Where a bare lock is accepted, and why. THREE GROUPS, and the difference
 * between them is the reason this gate is worth having at all.
 *
 * A key that stops matching any file FAILS. That is what makes group one
 * self-cleaning: phase 20 deleting `apps/api/src/loans` forces the entry out in
 * the same commit, rather than leaving a gate that describes a tree that no
 * longer exists.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  // --- Group one: phase 20 deletes these. -----------------------------------
  'apps/api/src/loans':
    'PHASE 20 DELETES IT. §6 phase 20: "delete apps/api/src/{catalog,loans,reservations,fines,' +
    'members}". Migrating a lock in a file that is on a delete list is work that gets deleted, ' +
    'and the 2.0 circulation engine that replaces it is in apps/api/src/circulation and is clean.',
  'apps/api/src/reservations':
    'PHASE 20 DELETES IT. Holds 2.0 (phase 17) replaces it against a different table.',
  'apps/api/src/members':
    'PHASE 20 DELETES IT. Patrons 2.0 (phase 14) already replaces it and takes its locks through ' +
    'acquireLocks.',
  'apps/api/src/jobs/reservation-expiry.job.ts':
    'PHASE 20 DELETES IT, with `reservations`. It sweeps 1.0 reservation pickups and has no 2.0 ' +
    'equivalent until phase 17 writes the hold-expiry job.',

  // --- Group two: the CONTROL PLANE, a different database entirely. ---------
  //
  // These cannot contend with a tenant lock because they are not in the same
  // database, which is why `policy`, `patron`, `bib` and `item` are the whole of
  // LOCK_DOMAIN_RANK and `billing` is not. Ranking two locks that can never meet
  // would be inventing an ordering to reassure a reader.
  'apps/api/src/billing':
    'CONTROL-PLANE LOCK, on `billing:<tenantId>` in the control database. It cannot contend with ' +
    'a tenant lock because it is not in the same database, so it has no rank to sort against.',
  'apps/api/src/import':
    'CONTROL-PLANE LOCK, on `import-staging:<tenantId>`. Same argument as billing. The engine ' +
    'ALSO takes tenant `book:` locks, which phase 20 rewrites when the 1.0 catalogue goes.',
  'apps/api/src/customization/quota.service.ts':
    'CONTROL-PLANE LOCK, on `quota:<tenant>:<feature>:<context>`. Its key is a composite that ' +
    '`{domain, id}` cannot express, and the trailing colon of an empty context is load-bearing — ' +
    'import-engine.ts documents the bug a caller reproduces by rebuilding that key by hand.',
  'apps/api/src/staff':
    'CONTROL-PLANE LOCK, serialising staff-seat counting against the plan limit.',

  // --- Group three: this file, and the one that owns the idiom. -------------
  'apps/api/src/platform/locks.ts':
    'IS the helper. It is the one place the token may be written, and the ordering every other ' +
    'caller depends on is decided here.',
  // NOT this gate, and the difference from `check:item-status-writer` is worth a
  // sentence. THAT gate had to exempt itself, because it matches on raw text and
  // its own docblock quotes the statement it hunts. This one blanks comments
  // before it looks, so its eleven mentions of the token are invisible to it —
  // which is the same property that saves the eight doc-comment mentions under
  // apps/api/src from becoming eight allowlist entries. The break test is what
  // proved it, in both directions.
  'packages/db-tenant/prisma/migrations/20260826085000_repair_orphan_ready_holds':
    'AN APPLIED MIGRATION. It takes a `book:<id>` lock inside a `DO $$` repair loop, and a ' +
    'migration cannot call TypeScript. It is also immutable: Prisma checksums a migration, so ' +
    'editing an applied one breaks every database that ran it.',
};
const allowedUsed = new Set<string>();

/** True if `rel` is, or is inside, an allowed path. */
function allowanceFor(rel: string): string | null {
  for (const [prefix, reason] of Object.entries(ALLOWED)) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) {
      allowedUsed.add(prefix);
      return reason;
    }
  }
  return null;
}

/**
 * Blank out comments and string bodies, keeping the file's length and line
 * breaks so a match still reports a usable line number.
 *
 * WHY IT HAS TO BE A CHARACTER WALK. There are eight doc-comment mentions of the
 * token under `apps/api/src` — in `books.controller.ts`, `books.service.ts`,
 * `import.service.ts`, `import-engine.ts`, two billing specs and twice in
 * `locks.ts` itself — every one of them explaining why a lock is or is not
 * taken. A line-based `startsWith('*')` test would miss a mention on the same
 * line as code, and treating the eight as allowlist entries would mean this gate
 * punished the files that documented themselves best.
 *
 * String bodies are blanked for the opposite reason: a raw statement lives in a
 * template literal, and blanking those would blank the very thing being looked
 * for. So strings are blanked and TEMPLATE literals are not — which is exactly
 * the split that makes the ESLint half of this boundary work, from the other
 * side.
 *
 * The character walk is the shape `packages/circ-policy/src/purity.test.ts`
 * already uses to prove that package takes no clock read.
 */
function blankNonCode(source: string, sql: boolean): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const blankTo = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (sql && c === '-' && next === '-') {
      const end = source.indexOf('\n', i);
      blankTo(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && next === '/' && !sql) {
      const end = source.indexOf('\n', i);
      blankTo(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blankTo(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let k = i + 1;
      while (k < n && source[k] !== quote) {
        if (source[k] === '\\' && !sql) k += 1;
        k += 1;
      }
      // The QUOTES survive so a blanked string is still a string; only the body
      // goes. In SQL a doubled quote is an escape and this walk ends the literal
      // early — harmless here, because it can only blank MORE than needed and
      // this gate is looking for an unblanked token.
      blankTo(i + 1, k);
      i = Math.min(k + 1, n);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/**
 * Below this, assume the gate is broken rather than satisfied. A renamed root or
 * a bad extension filter produces "0 files scanned, 0 violations", which reads
 * exactly like success.
 */
const MIN_FILES = 300;
/**
 * And below THIS, assume the token no longer means what the gate thinks. Every
 * allowlist entry is supposed to describe a real call site; if the total count
 * of accepted call sites collapses, either the tree moved or the pattern stopped
 * matching, and both look like a green run.
 */
const MIN_ACCEPTED_CALLS = 12;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|sql)$/.test(entry)) out.push(full);
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(path.join(ROOT, root), files);

if (files.length < MIN_FILES) {
  fail(
    `only ${files.length} file(s) scanned, expected at least ${MIN_FILES}. A renamed root or a ` +
      'bad extension filter produces zero violations over zero files and reports success.',
  );
}

let scanned = 0;
let acceptedCalls = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const raw = readFileSync(file, 'utf8');
  scanned += 1;
  if (!LOCK_CALL.test(raw)) continue;

  const code = blankNonCode(raw, file.endsWith('.sql'));
  const hits: number[] = [];
  const scan = new RegExp(LOCK_CALL.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = scan.exec(code)) !== null) hits.push(m.index);
  if (hits.length === 0) continue; // Every mention was a comment. Good.

  const allowance = allowanceFor(rel);
  if (allowance !== null) {
    acceptedCalls += hits.length;
    continue;
  }

  for (const at of hits) {
    const line = code.slice(0, at).split('\n').length;
    fail(
      `${rel}:${line} takes an advisory lock by hand.\n      ` +
        'Use `acquireLocks(tx, [lockKey(domain, id)])` from apps/api/src/platform/locks.ts, which ' +
        'SORTS by domain rank before acquiring.\n      ' +
        'Two transactions taking the same two locks in opposite orders deadlock, and Postgres ' +
        'resolves that by killing one — measured here at 17 × 40P01 in fifteen seconds, the ' +
        'first at 1,165 ms.\n      ' +
        'If the key genuinely has no rank — a control-plane lock in a different database — add ' +
        'the file to ALLOWED in this script with that reason.',
    );
  }
}

if (acceptedCalls < MIN_ACCEPTED_CALLS) {
  fail(
    `only ${acceptedCalls} accepted call site(s) found, expected at least ${MIN_ACCEPTED_CALLS}. ` +
      'The allowlist is supposed to describe real code; a collapse in the count means either the ' +
      'tree moved or the pattern stopped matching, and both look like a green run.',
  );
}

for (const [prefix, reason] of Object.entries(ALLOWED)) {
  if (!allowedUsed.has(prefix)) {
    fail(
      `the allowance for ${prefix} matches no bare lock any more.\n      ` +
        `Its reason was: ${reason}\n      ` +
        'Delete the entry. This is the self-cleaning half of the gate: when phase 20 deletes ' +
        'apps/api/src/loans, this failure is what makes the same commit delete its entry.',
    );
  }
}

if (problems.length) {
  console.error(`✗ advisory locks: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

console.log(
  `advisory locks ok — ${scanned} file(s) scanned across ${ROOTS.length} tree(s), comments and ` +
    `string bodies blanked; every bare lock is one of ${acceptedCalls} call site(s) in ` +
    `${Object.keys(ALLOWED).length} recorded allowance(s), and every allowance still matches. ` +
    'The 2.0 tenant plane has none. The AST half of this boundary is in eslint.config.mjs.',
);
