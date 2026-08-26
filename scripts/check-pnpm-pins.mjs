#!/usr/bin/env node
// Assert the version pins baked into the Dockerfiles match the versions the
// rest of the repository declares — the pnpm toolchain, and the Postgres
// client the API image shells out to.
//
// This exists because the mismatch is silent and total. On 2026-08-22 the
// toolchain moved to pnpm 11.22.0 while all three Dockerfiles still prepared
// 9.15.4. Nothing failed at build time — the images built fine. The failure
// landed at RUNTIME, in the one-shot `migrate` container, which sits on an
// `internal: true` network with no egress: corepack tried to fetch the declared
// version, could not reach the registry, and exited 1. `api` and `worker` gate
// on migrate completing, so the entire stack never started, and the visible
// error was a Prisma P3009 that pointed nowhere near the cause.
//
// No CI job builds these images (see the pre-release audit, supply-chain-06), so
// nothing else catches this. A twenty-line string comparison does.
import { readFileSync } from 'node:fs';

const DOCKERFILES = ['apps/api/Dockerfile', 'apps/web/Dockerfile', 'infra/caddy/Dockerfile'];

const declared = JSON.parse(readFileSync('package.json', 'utf8')).packageManager;
const m = /^pnpm@(\d+\.\d+\.\d+)/.exec(declared ?? '');
if (!m) {
  console.error(
    `✗ package.json packageManager is missing or not a pinned pnpm version: ${declared}`,
  );
  process.exit(1);
}
const want = m[1];

let bad = 0;
for (const f of DOCKERFILES) {
  const src = readFileSync(f, 'utf8');
  const pins = [...src.matchAll(/corepack\s+prepare\s+pnpm@(\d+\.\d+\.\d+)/g)].map((x) => x[1]);
  if (pins.length === 0) {
    console.error(`✗ ${f}: no \`corepack prepare pnpm@<version>\` found — did the pin move?`);
    bad++;
    continue;
  }
  for (const got of pins) {
    if (got !== want) {
      console.error(`✗ ${f}: prepares pnpm@${got}, package.json declares pnpm@${want}`);
      bad++;
    }
  }
}

// The api and web images run pnpm as the non-root `node` user, so their corepack
// cache has to be readable by that user or it re-fetches over the network at
// container start. caddy only uses pnpm at build time, as root.
for (const f of ['apps/api/Dockerfile', 'apps/web/Dockerfile']) {
  const src = readFileSync(f, 'utf8');
  if (!/ENV\s+COREPACK_HOME=/.test(src)) {
    console.error(`✗ ${f}: runs pnpm as a non-root user but does not set COREPACK_HOME`);
    bad++;
  }
}

// launch-readiness-14 — the same class of defect, one tool along.
//
// apps/api/src/export/export-processors.ts shells to `pg_dump` for the
// customer-facing SQL export, and apps/api/Dockerfile installs it. That install
// line used to read `apk add postgresql-client`, an Alpine meta-package that
// resolves to whatever major the base image's Alpine release happens to
// default to — so the client floated while the SERVER stayed pinned at
// postgres:16-alpine. A pg_dump newer than the server emits its own settings
// into the header (`SET transaction_timeout = 0;` from 18), and restoring that
// under `psql -v ON_ERROR_STOP=1` stops on the first line and restores nothing.
// The library finds out on the day they are leaving, which is the one day the
// export exists for.
//
// The image asserts its own pg_dump major at build time. This is the half that
// runs without Docker: it catches the pin being loosened, or the SERVER being
// moved to 17 while the client stays at 16, in the seconds before a review
// rather than during a restore.
const PG_CLIENT_DOCKERFILE = 'apps/api/Dockerfile';
// Everywhere the server major is declared. All of them must agree, and the
// client must equal them.
const PG_SERVER_FILES = [
  'infra/compose/docker-compose.prod.yml',
  'infra/compose/docker-compose.dev.yml',
  '.github/workflows/verify.yml',
];

const serverMajors = new Map();
for (const f of PG_SERVER_FILES) {
  for (const m of readFileSync(f, 'utf8').matchAll(/image:\s*postgres:(\d+)[-@\s]/g)) {
    if (!serverMajors.has(m[1])) serverMajors.set(m[1], []);
    serverMajors.get(m[1]).push(f);
  }
}
if (serverMajors.size === 0) {
  console.error(
    `✗ no \`image: postgres:<major>\` found in ${PG_SERVER_FILES.join(', ')} — the server pin ` +
      `moved and this check is now blind. Point it at wherever it lives.`,
  );
  bad++;
} else if (serverMajors.size > 1) {
  for (const [major, files] of serverMajors) {
    console.error(`✗ Postgres server major ${major} declared in ${[...new Set(files)].join(', ')}`);
  }
  console.error(
    `  The stack declares more than one Postgres major. CI would then test a different server ` +
      `than production runs, and the export client can only match one of them.`,
  );
  bad++;
} else {
  const serverMajor = [...serverMajors.keys()][0];
  const df = readFileSync(PG_CLIENT_DOCKERFILE, 'utf8');
  const pinned = [...df.matchAll(/apk add[^\n]*?\bpostgresql(\d+)-client\b/g)].map((m) => m[1]);
  if (/apk add[^\n]*\bpostgresql-client\b/.test(df)) {
    console.error(
      `✗ ${PG_CLIENT_DOCKERFILE}: installs the unversioned \`postgresql-client\` meta-package. ` +
        `Its major is whatever the base image's Alpine release defaults to and it rises on every ` +
        `base bump — pin \`postgresql${serverMajor}-client\` to match the server.`,
    );
    bad++;
  } else if (pinned.length === 0) {
    console.error(
      `✗ ${PG_CLIENT_DOCKERFILE}: no \`postgresql<major>-client\` install found. pg_dump is what ` +
        `apps/api/src/export/export-processors.ts runs for the SQL export; without it the export ` +
        `fails outright.`,
    );
    bad++;
  }
  for (const got of pinned) {
    if (got !== serverMajor) {
      console.error(
        `✗ ${PG_CLIENT_DOCKERFILE}: installs postgresql${got}-client, but the server is pinned at ` +
          `postgres:${serverMajor}. Move both together, or the SQL export produces a dump the ` +
          `server it came from cannot restore.`,
      );
      bad++;
    }
  }
  // The Dockerfile also asserts the major INSIDE the image, because Alpine
  // reaches /usr/bin/pg_dump through postgresql-common's version-dispatching
  // wrapper and the package name alone does not settle which major answers.
  // Deleting that assertion would leave the pin unverified where it matters.
  if (!new RegExp(`\\*' ${serverMajor}\\.'\\*\\)`).test(df)) {
    console.error(
      `✗ ${PG_CLIENT_DOCKERFILE}: the build-time \`pg_dump --version\` assertion for major ` +
        `${serverMajor} is gone. The package name does not prove which binary answers — put it back.`,
    );
    bad++;
  }
}

if (bad) {
  console.error(
    `\n${bad} problem(s). The stack will not start with a mismatched pin — fix before deploying.`,
  );
  process.exit(1);
}
console.log(
  `pnpm pin check passed: package.json and ${DOCKERFILES.length} Dockerfiles all on pnpm@${want}; ` +
    `apps/api ships a postgresql${[...serverMajors.keys()][0]}-client matching the pinned server.`,
);
