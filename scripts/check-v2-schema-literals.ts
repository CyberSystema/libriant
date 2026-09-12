/**
 * No application code names the 2.0 schema (2.0 phase 20f).
 *
 * ## What this is protecting
 *
 * `tenant-upgrade-v2.ts` promotes `lbr2` to `public` one database at a time,
 * while a deploy reaches every tenant at once. Phase 20f made that survivable:
 * the 2.0 client is bound per tenant from `tenant_schema_state.schemaMajor`, and
 * its session carries `search_path=<schema>,public` so hand-written SQL finds
 * its tables in either population WITHOUT naming a schema.
 *
 * A single re-introduced `lbr2.` undoes it for the statement it is in — and only
 * for the libraries that have been cut over, which is the half nobody runs
 * locally. It would pass every test in this repository, because every test
 * database is unpromoted.
 *
 * So the rule is mechanical: application code does not name the schema. The
 * places that legitimately still do are listed below, each with its reason.
 *
 * ## What is deliberately NOT scanned
 *
 * `packages/db-tenant/prisma/migrations-v2` and `prisma/upgrade` — the first is
 * history and the second RUNS in the pre-promotion window, where `lbr2` is the
 * only correct name. Rewriting either would be a bug, not a fix.
 *
 * Integration specs are not scanned either. They connect with their own `pg`
 * client, which carries no search path, and they assert against a schema by
 * name on purpose; `test/integration/v2-schema.ts` is the constant they should
 * use when the name matters.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['apps/api/src', 'packages/db-tenant/src'];
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'generated']);

/**
 * Files that may name the schema, and why.
 *
 * `v2.ts` is where the name is DEFINED, and `client.ts` is where it is handed to
 * the adapter. Everything else reaches it through them.
 */
const ALLOWED: Record<string, string> = {
  'packages/db-tenant/src/v2.ts': 'defines V2_SCHEMA and v2SchemaFor',
  'packages/db-tenant/src/client.ts': 'binds the adapter and the session to it',
};

/** `lbr2.` qualifying an identifier — NOT `lbr2_`, which prefixes function names. */
const QUALIFIED = /\blbr2\.(?=[A-Za-z_$"]|\$\{)/;

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('--') || t.startsWith('/*');
}

const files: string[] = [];
for (const r of ROOTS) {
  const start = path.join(ROOT, r);
  try {
    statSync(start);
  } catch {
    continue;
  }
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(p);
    }
  })(start);
}

const problems: string[] = [];
let scanned = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (rel in ALLOWED) continue;
  if (rel.endsWith('.spec.ts')) continue;
  scanned += 1;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (isComment(line) || !QUALIFIED.test(line)) return;
      problems.push(
        `    ${rel}:${i + 1}: names the 2.0 schema.\n` +
          `      Drop the \`lbr2.\` — the 2.0 session carries \`search_path\`, so an unqualified\n` +
          `      name is right for a library whose tables are in \`lbr2\` AND one whose have been\n` +
          `      promoted to \`public\`. Qualifying it breaks the second, which no local test has.`,
      );
    });
}

if (problems.length > 0) {
  console.error(`✗ v2 schema literals: ${problems.length} problem(s)\n`);
  console.error(problems.join('\n'));
  console.error(
    '\nThe schema a tenant keeps its 2.0 tables in is a per-tenant fact (phase 20f).\n' +
      'Code that hard-codes it works only for libraries nobody has cut over yet.\n',
  );
  process.exit(1);
}
console.log(
  `v2 schema literal check passed: ${scanned} file(s) scanned; no application code names the ` +
    `2.0 schema (${Object.keys(ALLOWED).length} allowed by name).`,
);
