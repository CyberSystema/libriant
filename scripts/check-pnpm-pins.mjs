#!/usr/bin/env node
// Assert every Dockerfile's `corepack prepare pnpm@X` matches package.json's
// `packageManager`.
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
  console.error(`✗ package.json packageManager is missing or not a pinned pnpm version: ${declared}`);
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

if (bad) {
  console.error(`\n${bad} problem(s). The stack will not start with a mismatched pin — fix before deploying.`);
  process.exit(1);
}
console.log(`pnpm pin check passed: package.json and ${DOCKERFILES.length} Dockerfiles all on pnpm@${want}`);
