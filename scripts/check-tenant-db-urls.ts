#!/usr/bin/env tsx
// A tenant database is opened with that tenant's OWN credential, or the build
// fails.
//
// THE FAILURE THIS PREVENTS. `tenants.db_url` is the Postgres SUPERUSER string
// with the database name swapped in. Until phase 4 it was also what every
// request connected with, so the separation between two libraries was which
// string the application happened to pick — and the pre-release audit
// demonstrated the consequence by connecting to library B's database with the
// string held for library A and reading its members (tenant-isolation-02), and
// then found the same string cached in plaintext in a passwordless Redis
// (tenant-isolation-03).
//
// The fix is two urls with different powers:
//
//   ADMIN   `tenants.db_url` — superuser. CREATE DATABASE, prisma migrate
//           deploy, pg_dump, VACUUM, relocate. Never on a request path.
//   RUNTIME composed in-process by `runtimeDbUrl()` from the sealed password in
//           `tenant_db_credentials`. Refused by Postgres against any other
//           tenant's database. Everything else.
//
// Nothing in the type system separates them — both are `string` — so the only
// thing standing between the two is which one a call site reaches for. That is
// exactly the kind of distinction that survives review once and erodes
// afterwards, which is why it is a gate.
//
// THREE RULES.
//   1. `dbUrl: true` in a Prisma select is the read of the superuser column.
//      Allowed only in the files listed below, each with a reason.
//   2. `makeTenantPrismaClient({ databaseUrl: … })` must be handed
//      `runtimeDbUrl(...)` — or, under scripts/ only, `composeRuntimeUrl(...)`,
//      which is the primitive `runtimeDbUrl` itself calls and the one a script
//      can reach. Same allowlist discipline.
//   3. `encryptedPwd` — the sealed password itself — may only appear where it
//      is written or opened. A convenience `select` that pulls it into a
//      response object is how a secret reaches a JSON body.
//
// TESTS ARE OUT OF SCOPE, deliberately. An integration spec sets up fixtures by
// writing tenant tables directly and sometimes needs DDL, which the runtime
// role does not have and should not. What covers the runtime credential is
// `test/integration/tenant-db-credentials.spec.ts`, which connects AS the
// tenant role and asserts Postgres refuses it against another tenant.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', '.turbo', 'out']);

/** Files allowed to read `tenants.db_url` — the ADMIN url — and why. */
const ADMIN_URL_READERS: Record<string, string> = {
  'apps/api/src/tenancy/tenant-db-url.ts':
    'defines both selects and is the only place the two urls are told apart',
  'apps/api/src/tenancy/tenant-resolver.service.ts':
    'joins the sealed credential onto the row and composes the runtime url from it',
  'scripts/tenant-migrate.ts': 'prisma migrate deploy needs the superuser',
  'scripts/tenant-online.ts': 'CREATE INDEX CONCURRENTLY needs the superuser',
  'scripts/tenant-relocate.ts': 'pg_dump / pg_restore / DROP DATABASE need the superuser',
  'scripts/tenant-rotate-db-creds.ts': 'issues the CREATE ROLE / GRANT ddl for a tenant',
};

/** Files allowed to open a tenant client on something other than `runtimeDbUrl()`. */
const ADMIN_CLIENT_OPENERS: Record<string, string> = {
  'apps/api/src/tenancy/tenant-prisma.service.ts':
    'receives the already-composed runtime url on the context',
  'apps/api/src/provisioning/tenant-provisioning.service.ts':
    'seeds a database whose roles it is in the middle of creating',
  'packages/db-tenant/prisma/seed-defaults.ts': 'operator seed, run against an explicit url',
  'packages/db-tenant/scripts/smoke-test.ts': 'creates and drops its own throwaway database',
  'packages/db-tenant/src/client.ts': 'the factory itself',
  'scripts/tenant-migrate.ts': 'reads _prisma_migrations, which the runtime role cannot see',
  'scripts/tenant-online.ts': 'runs the online migration track as the superuser',
  'scripts/seed-v1-fixture.ts': 'builds a 1.0 fixture database from scratch',
  'scripts/tenant-seed-v2-defaults.ts':
    'the lbr2 twin of seed-defaults.ts — operator seed, run against an explicit url, on a ' +
    'database that may have no per-tenant role yet (CI makes libriant_demo with createdb)',
};

/** Files allowed to touch the sealed password column. */
const SEALED_HANDLERS = new Set([
  'packages/db-control/src/tenant-db-credentials.ts',
  'apps/api/src/tenancy/tenant-db-url.ts',
  'apps/api/src/tenancy/tenant-resolver.service.ts',
  'apps/api/src/auth/signup.service.ts',
  'scripts/tenant-create.ts',
  'scripts/tenant-relocate.ts',
  'scripts/tenant-rotate-db-creds.ts',
]);

/** The scanner names every pattern it looks for, so it always matches itself. */
const SELF = 'scripts/check-tenant-db-urls.ts';

function isTestFile(rel: string): boolean {
  return (
    rel.includes('/test/') ||
    rel.includes('/__tests__/') ||
    rel.includes('/__fixtures__/') ||
    rel.endsWith('.spec.ts') ||
    rel.endsWith('.spec.tsx') ||
    rel.endsWith('.probe.ts')
  );
}

const files: string[] = [];
for (const r of ROOTS) {
  const start = path.join(ROOT, r);
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(p);
    }
  })(start);
}

const problems: string[] = [];
let adminReads = 0;
let runtimeOpens = 0;
let scanned = 0;

/** Strip line and block comments so prose about `dbUrl: true` is not a finding. */
function stripComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let l = line;
    if (inBlock) {
      const end = l.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      l = l.slice(end + 2);
      inBlock = false;
    }
    // Naive but sufficient: these files carry no `//` or `/*` inside a string
    // literal, and a false NEGATIVE here would only under-report.
    const block = l.indexOf('/*');
    const line2 = l.indexOf('//');
    if (block !== -1 && (line2 === -1 || block < line2)) {
      const end = l.indexOf('*/', block + 2);
      if (end === -1) {
        out.push(l.slice(0, block));
        inBlock = true;
        continue;
      }
      l = l.slice(0, block) + l.slice(end + 2);
    }
    const c = l.indexOf('//');
    out.push(c === -1 ? l : l.slice(0, c));
  }
  return out;
}

for (const file of files.sort()) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel === SELF || isTestFile(rel)) continue;
  scanned += 1;
  const lines = stripComments(readFileSync(file, 'utf8'));

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    // --- Rule 1: reading the admin column ---------------------------------
    if (/\bdbUrl:\s*true\b/.test(line)) {
      if (rel in ADMIN_URL_READERS) adminReads += 1;
      else {
        problems.push(
          `${at}: selects \`dbUrl\` (the SUPERUSER url) from the control plane.\n` +
            `      Use TENANT_RUNTIME_SELECT or TENANT_CONTEXT_SELECT from ` +
            `apps/api/src/tenancy/tenant-db-url.ts, then runtimeDbUrl()/tenantContextFrom().\n` +
            `      If this call site genuinely needs the superuser (migrations, pg_dump, ` +
            `VACUUM), add it to ADMIN_URL_READERS in this script with the reason.`,
        );
      }
    }

    // --- Rule 2: opening a tenant client ----------------------------------
    const m = /\bdatabaseUrl:\s*([^,}\n]+)/.exec(line);
    if (m) {
      const value = m[1]!.trim();
      // `composeRuntimeUrl(...)` counts too, but ONLY under scripts/. It is the
      // `@libriant/db-control` primitive `runtimeDbUrl` itself calls, and it is
      // what a script has to use — scripts cannot reach `runtimeDbUrl`, which
      // resolves the sealing key through the API's `loadEnv()`. Filing a
      // correct call onto the admin allowlist would record it as an exception
      // to the rule it obeys.
      //
      // Scoped, because it is weaker than `runtimeDbUrl`: it composes whatever
      // role and password it is handed, so `composeRuntimeUrl({ adminUrl,
      // roleName: 'libriant', password: … })` would pass. Under apps/api there
      // is never a reason to reach past `runtimeDbUrl`, so that door stays
      // shut; under scripts/ the residual risk is a reviewer's to catch, and
      // it is one line rather than a whole file on an allowlist.
      const composed =
        /^composeRuntimeUrl\(/.test(value) &&
        (rel.startsWith('scripts/') || rel.includes('/scripts/'));
      if (/^runtimeDbUrl\(/.test(value) || composed) runtimeOpens += 1;
      else if (!(rel in ADMIN_CLIENT_OPENERS)) {
        problems.push(
          `${at}: opens a tenant database with \`${value}\` rather than runtimeDbUrl(...)` +
            `${rel.startsWith('scripts/') ? ' or composeRuntimeUrl(...)' : ''}.\n` +
            `      That connects as the Postgres superuser, which is tenant-isolation-02.\n` +
            `      If this path genuinely needs the superuser, add it to ADMIN_CLIENT_OPENERS ` +
            `in this script with the reason.`,
        );
      }
    }

    // --- Rule 3: the sealed password --------------------------------------
    if (/\bencryptedPwd\b/.test(line) && !SEALED_HANDLERS.has(rel)) {
      problems.push(
        `${at}: references \`encryptedPwd\`, the sealed tenant database password.\n` +
          `      It may only be written at provisioning/rotation or opened in ` +
          `runtimeDbUrl(). Anywhere else it is a secret one \`select\` away from a response body.`,
      );
    }
  });
}

if (problems.length) {
  console.error(`✗ tenant db urls: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}\n`);
  console.error(
    'A tenant database opened with the superuser url has no database-level isolation from\n' +
      'any other library on the cluster. The audit proved that by reading one library from\n' +
      "another's connection string; the per-tenant role is what makes it not reproduce.",
  );
  process.exit(1);
}

console.log(
  `tenant db url check passed: ${scanned} source file(s); ` +
    `${adminReads} reasoned read(s) of the superuser url across ` +
    `${Object.keys(ADMIN_URL_READERS).length} allowlisted file(s); ` +
    `${runtimeOpens} tenant client(s) opened through runtimeDbUrl()/composeRuntimeUrl(); ` +
    `the sealed password appears only where it is written or opened.`,
);
