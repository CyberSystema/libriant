#!/usr/bin/env node
// Three supply-chain invariants that nothing else in this repo watches, all
// computed offline from the installed tree.
//
// ## Why this exists
//
// The pre-release audit (supply-chain-12) walked the production dependency
// closure by hand and found a package with NO licence grant at all —
// `buffers@0.1.1`, arriving through `exceljs`, a first-order runtime dependency
// of apps/api behind both the spreadsheet import and the spreadsheet export.
// Not dormant either: `require('exceljs')` on its own loads
// buffers/index.js. Nothing had looked before, and nothing would have looked
// again. Libriant is sold to Greek public libraries; a procurement
// questionnaire asks for the third-party licence position, and "we have never
// checked" is not an answer. So the walk is code now, with the decisions
// written down beside it in
// docs/audit/pre-release-2026-08-23/supply-chain-licences.md.
//
// It also watches the two things that made that walk necessary in the first
// place. `settings: autoInstallPeers: true` (pnpm-lock.yaml:4) means an
// OPTIONAL peer dependency gets resolved and recorded as a real edge, so
// `@prisma/client` — a production dependency — drags the entire Prisma CLI into
// the production closure. Measured on this tree by walking it twice, once
// refusing to traverse @prisma/client's two auto-peer edges: 477 packages /
// 702.9 MiB becomes 349 / 467.3 MiB. That is 128 packages and 235 MiB —
// @prisma/studio-core (42.0), the CLI itself (41.8), effect (25.8), typescript
// (23.2), an embedded WASM Postgres (22.2), @prisma/dev (18.1) and a MySQL
// driver — sitting in the API image with nothing to start them, and it is where
// the one advisory this repo carries lives (supply-chain-09, deepmerge-ts). Turning
// autoInstallPeers off is a whole-workspace re-resolution that changes how nine
// workspaces resolve and surfaces genuinely missing peers; that is not a
// launch-window change. So what this file does instead is hold the line: the
// set of auto-installed peer edges is written down, and a NEW one — a new
// subtree entering the production image without anyone choosing it — fails the
// build.
//
// Deliberately dependency-free and text-based, like the other check:* scripts.
// `pnpm audit` runs in CI for the advisory feed; this covers what an advisory
// feed cannot know.
//
// ## How this runs
//
// `pnpm check:supply-chain`, and — because .github/workflows/verify.yml
// enumerates its static checks one npm script per step and belongs to another
// owner — package.json's `check:pnpm-pins` runs it too, so it executes inside
// the "pnpm pins match…" step verify.yml already has. That step's NAME
// therefore under-describes what it runs, which is worth correcting the next
// time that file is opened; a check nobody runs is worth nothing, and the
// wrong-but-running arrangement beats the right-but-dormant one.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Licences that need no decision: permissive, no source-disclosure obligation,
 * no field-of-use restriction. Everything else has to be named below.
 *
 * The odd spellings are real values published by real packages — SPDX is a
 * convention, not an enforced schema, and normalising them here would hide the
 * fact that a NOTICE generator sees exactly these strings.
 */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT and ISC',
  'MIT-0',
  'MIT/X11',
  'MIT-X11',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
]);

/**
 * Every production-closure package whose licence is not on the permissive list,
 * with the decision that was taken. A package that is here is a package
 * somebody looked at; a package that is NOT here and not permissive fails the
 * gate.
 *
 * Keyed name@version on purpose: a version bump re-opens the question, because
 * upstream can and does relicense.
 *
 * A key MAY carry one `*` in the name, and exactly one kind of entry needs it:
 * a family of platform-specific builds of a single library. The production
 * closure is platform-dependent — an arm64 macOS laptop installs
 * `@img/sharp-libvips-darwin-arm64`, ubuntu-latest installs
 * `@img/sharp-libvips-linux-x64` — so a key naming one architecture fails on
 * every other machine, in BOTH directions at once: the resolved package has no
 * decision, and the recorded decision names nothing installed. Not
 * hypothetical: pointed at a store shaped the way ubuntu-latest resolves this
 * tree, the architecture-keyed version of this file exited 1 with exactly those
 * two errors, which is what CI would have done on its first run. The version
 * stays exact.
 */
const LICENCE_DECISIONS = {
  // NO GRANT AT ALL, and the only one in the tree. package.json has no
  // `license`, the tarball ships no LICENSE file, and the README has no licence
  // section — checked all three. Default copyright therefore applies and
  // Libriant has no written permission to copy or redistribute it. It is
  // unmaintained (last published 2012) and arrives four levels down from a
  // first-order runtime dependency:
  //   exceljs@4.4.0 -> unzipper@0.10.14 -> binary@0.3.0 -> buffers@0.1.1
  // (app-builder-lib pulls unzipper@0.12.5, which does NOT depend on binary —
  // both copies of unzipper are in the tree, so the shallow trace is wrong.)
  //
  // NOT a decision this file can take. OWNER DECISION REQUIRED — see
  // docs/audit/pre-release-2026-08-23/supply-chain-licences.md: keep and accept
  // in writing, replace the exceljs import path, or seek a grant. Recorded here
  // so it is answerable, not so it is settled.
  'buffers@0.1.1':
    'NO LICENCE — owner decision pending (see docs/audit/…/supply-chain-licences.md)',

  // Licence present but not machine-readable: package.json declares no
  // `license`, while the tarball ships a full MIT LICENSE ("(The MIT License)
  // Copyright (c) 2012 Netease, Inc. and other pomelo contributors"). The audit
  // counted this as a second package with no grant; it is not — the grant
  // exists, only the metadata is missing. It still needs a line here because
  // `pnpm licenses list` and every other manifest-driven notice generator will
  // silently omit it from a NOTICE file.
  //   mysql2@3.15.3 -> seq-queue@0.0.5, and mysql2 is only here because the
  //   Prisma CLI is (see AUTO_PEER_EDGES) — it leaves with it.
  'seq-queue@0.0.5': 'MIT, in a shipped LICENSE file only — must be listed in NOTICE by hand',

  // Weak, file-level copyleft. Reached only through @prisma/studio-core, i.e.
  // only because the Prisma CLI is in the closure; nothing imports it and it
  // leaves with the CLI. Unmodified and not distributed, so EPL-2.0 asks
  // nothing of Libriant today.
  'elkjs@0.11.1': 'EPL-2.0 — unmodified, not distributed, arrives with the Prisma CLI',

  // Dual-licensed. Libriant elects MIT. Recorded because an election that is
  // not written down is not an election, and the GPL arm of this one would be
  // a source-disclosure obligation on a closed product.
  //   exceljs@4.4.0 -> jszip@3.10.1
  'jszip@3.10.1': 'dual (MIT OR GPL-3.0-or-later) — Libriant elects MIT',

  // LGPL-3.0 native libvips, via next -> sharp. No source obligation for SaaS:
  // it is never conveyed to a user, only run on our own servers. It WOULD carry
  // one if it were ever bundled into a distributed binary — apps/desktop's
  // `dependencies` are electron-log and electron-updater only, so it is not,
  // and that is the condition to re-check before adding anything to them.
  //
  // Wildcarded across the -darwin-arm64/-linux-x64/-linuxmusl-x64/… family:
  // they are one library, one licence, one decision, and which of them is on
  // disk is decided by the machine running this check rather than by anything
  // Libriant chose.
  '@img/sharp-libvips-*@1.3.2':
    'LGPL-3.0-or-later — server-side only, not conveyed; re-check if ever bundled into apps/desktop',

  // The browser-support database, not code. CC-BY-4.0 asks for attribution and
  // nothing else — and there is nowhere to put it yet: this repository has no
  // LICENSE, NOTICE or attribution file at all, which the licences doc records
  // as still owed. Same gap covers the MIT/Apache/BSD majority.
  'caniuse-lite@1.0.30001809': 'CC-BY-4.0 — data, attribution only (NOTICE file still owed)',

  // MIT plus the zlib licence for the vendored zlib port. Both permissive; the
  // combined string is simply not on the permissive list as written.
  'pako@1.0.11': '(MIT AND Zlib) — both permissive',
};

/**
 * Optional peer dependencies that pnpm auto-installed, written as
 * `<dependent>><peer>`. Each of these is an edge that exists because
 * `autoInstallPeers: true` chose it, not because a manifest asked for it.
 *
 * The gate is equality, both directions: a new edge means a subtree entered the
 * production closure that nobody chose, and a vanished edge means this list is
 * describing a tree that no longer exists.
 */
const AUTO_PEER_EDGES = {
  // The expensive one, and the reason supply-chain-04 exists. @prisma/client is
  // a production dependency; `prisma` is its OPTIONAL peer; pnpm resolves it
  // and records it as an optionalDependency of the client, so it survives even
  // `pnpm install --prod`. Measured cost of this edge plus the typescript one:
  // +131 packages, +243 MiB in the API image (446/428.0 MiB -> 315/185.0 MiB
  // with both cut). Cannot be removed without re-resolving the lockfile.
  '@prisma/client>prisma': 'the Prisma CLI subtree — supply-chain-04',
  '@prisma/client>typescript': 'type-only; harmless, but part of the same edge',
  'prisma>typescript': 'same, one level down',
  'valibot>typescript': 'type-only',
  // Genuinely wanted: apps/api declares all three itself, so the edge is
  // redundant rather than additive.
  '@nestjs/core>@nestjs/platform-express': 'apps/api declares it directly too',
  '@nestjs/common>class-validator': 'apps/api declares it directly too',
  '@nestjs/common>class-transformer': 'apps/api declares it directly too',
  // BullMQ's optional backends. ioredis is a real apps/api dependency; `pg` is
  // not, and rides in on this edge alone.
  'bullmq>ioredis': 'apps/api declares ioredis directly too',
  'bullmq>pg': 'BullMQ optional Postgres backend — unused, arrives on this edge',
  // Type packages for the web tree.
  'stripe>@types/node': 'types only',
  '@radix-ui/*>@types/react': 'types only',
  '@radix-ui/*>@types/react-dom': 'types only',
  'bare-stream>bare-events': 'Bare runtime shim, unused under Node',
};

/**
 * The one advisory this repo knowingly runs with, and the two facts that make
 * that acceptable. verify.yml gates `pnpm audit --prod` at `--audit-level=
 * critical` rather than `high` for exactly this package; that downgrade is only
 * defensible while both facts hold, and a comment cannot notice when they stop.
 *
 * GHSA-ggr8-5vv4-36mx / CVE-2026-40345, CWE-674: stack exhaustion merging
 * recursive object graphs. Reachability, checked rather than assumed:
 * deepmerge-ts is a dependency of @prisma/config, which is a dependency of the
 * Prisma CLI. The CLI merges prisma.config layers — repo-owned files, under
 * `prisma generate` at image build and `prisma migrate deploy` in the compose
 * migrate one-shot. No request handler loads @prisma/config; the API's runtime
 * entrypoint is tsx over apps/api/src/main.ts. An attacker would have to
 * control the config file, at which point they already control the build.
 */
const ADVISORY_EXCEPTIONS = [
  {
    name: 'deepmerge-ts',
    // Patched in 8.0.0. If the tree reaches 8, the exception is stale and
    // verify.yml's gate should go back to `high`.
    patchedAtMajor: 8,
    // The reachability argument, as an assertion. If deepmerge-ts ever appears
    // under a parent that is not the Prisma CLI, "dev-only, config files only"
    // has stopped being true and somebody has to look again.
    reachableOnlyVia: ['@prisma/config'],
    advisory: 'GHSA-ggr8-5vv4-36mx (CVE-2026-40345)',
  },
];

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

const APP = process.cwd();
const STORE = path.join(APP, 'node_modules', '.pnpm');

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Workspace directories, from pnpm-workspace.yaml's globs. Read rather than
 * hardcoded: a tenth workspace added next month is a tenth production closure,
 * and a hardcoded list would not see it.
 */
function workspaceDirs() {
  const src = readFileSync(path.join(APP, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...src.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1]);
  const dirs = ['.'];
  for (const g of globs) {
    const [base, star] = g.split('/');
    if (star !== '*') continue; // only `dir/*` is used here
    for (const e of readdirSync(path.join(APP, base), { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(path.join(APP, base, e.name, 'package.json'))) {
        dirs.push(`${base}/${e.name}`);
      }
    }
  }
  return dirs;
}

/**
 * Every package directory inside one `.pnpm/<dir>/node_modules/`.
 *
 * pnpm's layout makes reachability exact without reading the lockfile: the
 * siblings of a package in its store directory are precisely what that copy can
 * resolve — auto-installed peers included, which is the point. Same technique
 * as scripts/docker-prune-dev-modules.mjs, which prunes the production image on
 * it.
 */
function siblingsOf(container) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(container, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      let inner;
      try {
        inner = readdirSync(path.join(container, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const j of inner) out.push(`${e.name}/${j.name}`);
    } else {
      out.push(e.name);
    }
  }
  return out;
}

/**
 * The production closure: seeded from every workspace's `dependencies` +
 * `optionalDependencies` (NEVER devDependencies — eslint's licence is not a
 * procurement question), then walked to a fixed point.
 *
 * Returns the set of package directories, the auto-installed optional peer
 * edges found on the way, and the parents of each package.
 */
function productionClosure() {
  const seen = new Set();
  const queue = [];
  const parents = new Map();
  const autoPeerEdges = new Map();

  const push = (real, from) => {
    if (!real) return;
    if (!parents.has(real)) parents.set(real, new Set());
    if (from) parents.get(real).add(from);
    if (seen.has(real)) return;
    seen.add(real);
    queue.push(real);
  };
  const resolve = (dir, name) => {
    try {
      return realpathSync(path.join(dir, 'node_modules', ...name.split('/')));
    } catch {
      return null;
    }
  };

  for (const ws of workspaceDirs()) {
    const dir = path.join(APP, ws);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    for (const name of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]) {
      push(resolve(dir, name), `workspace:${ws}`);
    }
  }

  while (queue.length) {
    const real = queue.pop();
    const rel = path.relative(STORE, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // a workspace link
    const container = path.join(STORE, rel.split(path.sep)[0], 'node_modules');
    const pkg = readJson(path.join(real, 'package.json')) ?? {};
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    for (const name of siblingsOf(container)) {
      // pnpm puts a package inside its own store container alongside its
      // dependencies. Left in, every package is recorded as its own parent and
      // the reachability assertions below always "pass".
      if (name === pkg.name) continue;
      // An auto-installed optional peer: present as a resolvable sibling,
      // declared as an OPTIONAL peer, and asked for by no manifest field.
      if (
        !declared.has(name) &&
        pkg.peerDependencies &&
        name in pkg.peerDependencies &&
        pkg.peerDependenciesMeta?.[name]?.optional === true
      ) {
        // @radix-ui publishes a dozen packages with identical peer sets;
        // listing each would be a ledger about Radix's packaging, not about
        // Libriant's supply chain.
        const from = pkg.name?.startsWith('@radix-ui/') ? '@radix-ui/*' : pkg.name;
        autoPeerEdges.set(`${from}>${name}`, (autoPeerEdges.get(`${from}>${name}`) ?? 0) + 1);
      }
      try {
        push(realpathSync(path.join(container, ...name.split('/'))), pkg.name);
      } catch {
        /* dangling optional — nothing there to account for */
      }
    }
  }
  return { seen, parents, autoPeerEdges };
}

/**
 * The LICENCE_DECISIONS key covering `name@version`, or null if nobody has
 * ruled on it. `*` in a key stands for a run of characters inside the package
 * name only — it must not swallow the `@version`, or a decision taken about
 * 1.3.2 would silently keep covering 2.0.0.
 */
function decisionKeyFor(id) {
  if (id in LICENCE_DECISIONS) return id;
  for (const key of Object.keys(LICENCE_DECISIONS)) {
    if (!key.includes('*')) continue;
    const pattern = key
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^@]*');
    if (new RegExp(`^${pattern}$`).test(id)) return key;
  }
  return null;
}

/** SPDX-ish licence string from a manifest, in the several shapes npm allows. */
function declaredLicence(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object') return pkg.license.type ?? null;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  if (pkg.licenses && typeof pkg.licenses === 'object') return pkg.licenses.type ?? null;
  return null;
}

/**
 * A licence FILE shipped in the tarball, which is a real grant even when the
 * manifest forgot to declare one. Checking this is what separates seq-queue
 * (MIT, undeclared) from buffers (no grant anywhere) — the audit called both
 * ungranted, and only one of them is.
 */
const LICENCE_FILES = /^(LICEN[CS]E|COPYING|LICEN[CS]E[-.].*)$/i;
function hasLicenceFile(dir) {
  try {
    return readdirSync(dir).some((n) => LICENCE_FILES.test(n));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

export function run() {
  if (!existsSync(STORE)) {
    console.error(`✗ no pnpm store at ${STORE} — run \`pnpm install\` first`);
    return 1;
  }
  const { seen, parents, autoPeerEdges } = productionClosure();
  let bad = 0;

  // ---- 1. licences --------------------------------------------------------
  const unaccounted = [];
  const usedDecisions = new Set();
  for (const dir of seen) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg?.name) continue;
    if (pkg.name.startsWith('@libriant/')) continue; // our own, private, not third-party
    const id = `${pkg.name}@${pkg.version}`;
    const licence = declaredLicence(pkg);
    if (licence && PERMISSIVE.has(licence)) continue;
    const decided = decisionKeyFor(id);
    if (decided) {
      usedDecisions.add(decided);
      continue;
    }
    unaccounted.push({
      id,
      licence: licence ?? (hasLicenceFile(dir) ? '(undeclared; LICENSE file present)' : '(NONE)'),
      via: [...(parents.get(dir) ?? [])].sort().join(', '),
    });
  }
  for (const u of unaccounted.sort((a, b) => a.id.localeCompare(b.id))) {
    console.error(`✗ ${u.id} — licence ${u.licence}, reached via ${u.via}`);
    bad++;
  }
  if (unaccounted.length) {
    console.error(
      `\n  ${unaccounted.length} production dependency/ies carry a licence nobody has ruled on.\n` +
        `  Read the licence, then either add it to PERMISSIVE (if it is permissive and simply\n` +
        `  spelled unusually) or record the decision in LICENCE_DECISIONS with the reason.\n` +
        `  Do NOT guess a licence that is not written down: a package with no grant needs an\n` +
        `  owner decision — keep and accept, replace, or ask upstream — not an entry invented here.`,
    );
  }
  for (const id of Object.keys(LICENCE_DECISIONS)) {
    if (!usedDecisions.has(id)) {
      console.error(
        `✗ LICENCE_DECISIONS has an entry for ${id}, which is no longer in the production ` +
          `closure (or moved version). Delete the line — a decision record about a dependency ` +
          `that is not there reads as coverage and is not.`,
      );
      bad++;
    }
  }

  // ---- 2. auto-installed optional peers -----------------------------------
  for (const edge of autoPeerEdges.keys()) {
    if (!(edge in AUTO_PEER_EDGES)) {
      console.error(
        `✗ new auto-installed optional peer edge \`${edge}\` — a subtree entered the production ` +
          `closure because autoInstallPeers resolved an OPTIONAL peer, not because any manifest ` +
          `asked for it. Confirm what it drags in, then record it in AUTO_PEER_EDGES.`,
      );
      bad++;
    }
  }
  for (const edge of Object.keys(AUTO_PEER_EDGES)) {
    if (!autoPeerEdges.has(edge)) {
      console.error(`✗ AUTO_PEER_EDGES lists \`${edge}\`, which is gone. Delete the line.`);
      bad++;
    }
  }

  // ---- 3. the advisory this repo knowingly carries ------------------------
  for (const exc of ADVISORY_EXCEPTIONS) {
    const dirs = [...seen].filter(
      (d) => (readJson(path.join(d, 'package.json'))?.name ?? '') === exc.name,
    );
    if (dirs.length === 0) {
      console.error(
        `✗ ${exc.name} is no longer in the production closure, so the ${exc.advisory} exception ` +
          `is stale. Delete it here AND raise verify.yml's \`pnpm audit --prod\` gate from ` +
          `--audit-level=critical back to high.`,
      );
      bad++;
      continue;
    }
    for (const d of dirs) {
      const pkg = readJson(path.join(d, 'package.json'));
      const major = Number.parseInt(pkg.version, 10);
      if (Number.isFinite(major) && major >= exc.patchedAtMajor) {
        console.error(
          `✗ ${exc.name}@${pkg.version} is at or past the patched major ` +
            `(${exc.patchedAtMajor}), so ${exc.advisory} no longer applies. Delete this ` +
            `exception AND raise verify.yml's \`pnpm audit --prod\` gate back to ` +
            `--audit-level=high — that downgrade exists only for this advisory.`,
        );
        bad++;
      }
      const via = [...(parents.get(d) ?? [])];
      const unexpected = via.filter((p) => !exc.reachableOnlyVia.includes(p));
      if (unexpected.length) {
        console.error(
          `✗ ${exc.name}@${pkg.version} is now reachable via ${unexpected.join(', ')}, not only ` +
            `${exc.reachableOnlyVia.join(', ')}. The reachability argument that downgraded ` +
            `${exc.advisory} to non-blocking assumed dev-time config parsing only — re-assess ` +
            `it before touching this list.`,
        );
        bad++;
      }
    }
  }

  if (bad) {
    console.error(`\n${bad} supply-chain problem(s).`);
    return 1;
  }
  console.log(
    `supply-chain check passed: ${seen.size} packages in the production closure, ` +
      `${Object.keys(LICENCE_DECISIONS).length} recorded licence decisions, ` +
      `${autoPeerEdges.size} auto-installed peer edges, ` +
      `${ADVISORY_EXCEPTIONS.length} accepted advisory.`,
  );
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exit(run());
