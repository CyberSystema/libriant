#!/usr/bin/env tsx
// `items.status` and `items.current_branch_id` have exactly one writer.
//
// §6 phase 15 of the 2.0 program states the criterion and its two mechanisms in
// one line: "`items.status` is writable through exactly one service (ESLint
// boundary rule + a grep gate). Every transition writes history." This is the
// grep half, and it exists because the other half provably cannot see the whole
// surface.
//
// ## What ESLint covers, and the door it leaves open
//
// `eslint.config.mjs` bans `<x>.item.update({ data: { status } })` and its
// siblings by matching the member path, so `tx.item.update` is caught and
// `tx.loan.update` is not. That rule is precise and it is blind to exactly one
// thing: RAW SQL. `tx.$executeRaw`UPDATE lbr2.items SET status = …`` is a
// template literal with no structure an AST selector can reach, and this
// repository writes raw SQL deliberately and often — `patron_blocks` mints ids
// in it, `is_shelf_available` can only be read in it, and the holdings upsert
// two directories away is raw because a Prisma unique violation aborts the whole
// interactive transaction.
//
// So the two gates are complementary rather than redundant, and either one alone
// is a boundary with a door in it.
//
// ## Why the boundary is worth a gate at all
//
// A status write that goes around `ItemStatusService` succeeds, returns 200, and
// leaves `item_status_history` without the row. Nothing fails. The symptom
// arrives weeks later, when a librarian holding a copy marked `missing` asks
// what happened to it and the history says nothing — and by then the write path
// that did it is indistinguishable from the ones that behaved.
//
// ## Why it lands now rather than in phase 16
//
// It lands against a tree with ZERO existing 2.0 item writers. Measured: 16 in
// 1.0, all on `book_copies` in `public`, a different model on a different client,
// which phase 20 deletes. A gate that arrives after phase 16, 17 and 23 have
// written the idiom ships with an allowlist naming them and checks nothing while
// looking like coverage — the argument `apps/api/src/platform/locks.ts` makes for
// the advisory-lock grep, in the direction where it is still free.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Where a 2.0 status write could plausibly be written.
 *
 * The API and the worker. `apps/web` cannot reach a database at all, and
 * `packages/db-tenant` holds the datamodel rather than callers.
 */
const ROOTS = ['apps/api/src', 'apps/worker/src', 'scripts'];

/**
 * The one file that may write the two columns, and the one that may establish
 * them on create.
 *
 * Same shape as the ESLint exemption and for the same reasons — see the block
 * on `ITEM_STATE_WRITES` in `eslint.config.mjs`. Two entries rather than one
 * because `items.current_branch_id` is NOT NULL with no default, so a copy
 * cannot be created without naming where it is.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'apps/api/src/items/item-status.service.ts':
    'IS the single writer. Every transition it makes writes `item_status_history` in the same ' +
    'transaction, which is the other half of the phase-15 criterion.',
  'apps/api/src/items/items.service.ts':
    'Creates copies, and `items.current_branch_id` is NOT NULL with no default — a copy cannot ' +
    'be created without naming where it is. It may not MOVE either column afterwards; ESLint ' +
    'enforces that half with a narrower selector set on this one file.',
  'scripts/check-item-status-writer.ts':
    'This gate. Its own documentation quotes the statement it looks for, so scanning itself ' +
    'reports itself — found by the break test, and exempted here rather than by weakening the ' +
    'pattern or by silently dropping the docblock example that makes the rule legible.',
};
const allowedUsed = new Set<string>();

/**
 * A raw statement that writes one of the two columns.
 *
 * Deliberately loose on whitespace and case, and deliberately anchored on
 * `items` rather than on any table: `UPDATE lbr2.items` and `UPDATE items` both
 * match, `UPDATE loans SET status` does not, and neither does a SELECT that
 * merely reads the column.
 *
 * `[\s\S]*?` rather than `.*?` so a statement broken across lines — which every
 * readable one in this repository is — still matches.
 *
 * `[a-z0-9_]` and not `[a-z_]` in the schema qualifier, which is not pedantry:
 * the schema is literally named `lbr2`, so the first version of this pattern
 * matched `UPDATE items` and missed `UPDATE lbr2.items` — the only form this
 * codebase ever writes. The break test is what found it, which is the argument
 * for having one.
 */
const RAW_WRITE =
  /update\s+(?:[a-z0-9_]+\.)?items\b[\s\S]{0,400}?\bset\b[\s\S]{0,400}?\b(status|current_branch_id)\s*=/i;

/**
 * An INSERT that names the columns. A copy created outside `ItemsService` has no
 * creation history row, which is the same defect from the other end.
 */
const RAW_INSERT =
  /insert\s+into\s+(?:[a-z0-9_]+\.)?items\s*\([\s\S]{0,400}?\b(status|current_branch_id)\b/i;

/** The Prisma shape, as a text fallback for a file ESLint does not lint. */
const PRISMA_WRITE = /\.item\.(?:update|updateMany|updateManyAndReturn|upsert)\s*\(/;

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

/**
 * Below this, assume the gate is broken rather than satisfied.
 *
 * A renamed directory, a bad glob or a failed checkout all produce "0 files
 * scanned, 0 violations" — the most convincing-looking vacuous result there is.
 */
const MIN_FILES = 200;

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
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(path.join(ROOT, root), files);

if (files.length < MIN_FILES) {
  fail(
    `only ${files.length} file(s) scanned, expected at least ${MIN_FILES}. A renamed directory ` +
      'or a bad glob produces zero violations over zero files and reports success. This floor ' +
      'is what stops that.',
  );
}

let scanned = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const source = readFileSync(file, 'utf8');
  scanned += 1;

  const allowance = ALLOWED[rel];
  if (allowance !== undefined) {
    allowedUsed.add(rel);
    continue;
  }

  const raw = RAW_WRITE.exec(source);
  if (raw !== null) {
    fail(
      `${rel} writes items.${raw[1]} in raw SQL.\n      ` +
        'Only ItemStatusService may. Inject it and call transition(), or applyWithin(tx, …) ' +
        'inside a transaction you own, so the move reaches item_status_history with its reason, ' +
        'its cause and who made it.\n      ' +
        'This is the half of the phase-15 boundary ESLint cannot see: a template literal has no ' +
        'structure an AST selector can match.',
    );
  }

  const insert = RAW_INSERT.exec(source);
  if (insert !== null) {
    fail(
      `${rel} creates an items row naming ${insert[1]} in raw SQL.\n      ` +
        'A copy created outside ItemsService has no creation row in item_status_history, which ' +
        'is the same defect from the other end: its history starts mid-story.',
    );
  }

  if (PRISMA_WRITE.test(source)) {
    // Not automatically a violation — `item.update({ data: { barcode } })` is
    // ordinary and correct — so this only reports when the same file also names
    // one of the two columns as a written key. ESLint decides the precise cases;
    // this catches a file ESLint is not configured to lint at all.
    if (/\b(status|currentBranchId)\s*:/.test(source)) {
      fail(
        `${rel} calls .item.update()/.upsert() and names \`status\` or \`currentBranchId\` as an ` +
          'object key.\n      If that is a `where` clause, this gate cannot tell — move the ' +
          'write to ItemStatusService, or if it genuinely is only a read, restructure it so the ' +
          'two are not in one file.\n      ' +
          'ESLint has the precise selector for files it lints; this catches the ones it does ' +
          'not (scripts, the worker).',
      );
    }
  }
}

for (const [file, reason] of Object.entries(ALLOWED)) {
  if (!allowedUsed.has(file)) {
    fail(
      `the allowance for ${file} matches no file — it was renamed or removed.\n      ` +
        `Its reason was: ${reason}\n      ` +
        'Delete the entry or point it at the new path. An exception list that has stopped ' +
        'describing the tree is one nobody can trust.',
    );
  }
}

if (problems.length) {
  console.error(`✗ item status writer: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    • ${p}\n`);
  process.exit(1);
}

console.log(
  `item status writer ok — ${scanned} file(s) scanned across ${ROOTS.length} tree(s); ` +
    'no raw SQL writes items.status or items.current_branch_id, and no unlinted file writes ' +
    `them through Prisma. ${Object.keys(ALLOWED).length} recorded allowance(s), every one still ` +
    'matching. The AST half of this boundary is in eslint.config.mjs.',
);
