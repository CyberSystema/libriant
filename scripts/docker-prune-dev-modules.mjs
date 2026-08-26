#!/usr/bin/env node
/**
 * supply-chain-03 — delete every package the production image installed but
 * cannot reach at runtime.
 *
 * ## The problem this solves, and why the obvious fixes do not
 *
 * `pnpm install --frozen-lockfile` in apps/api/Dockerfile installs the WHOLE
 * dependency tree of every workspace manifest copied into the deps stage —
 * devDependencies included. The runtime stage then does `COPY --from=build /app
 * /app`, so eslint, vitest, turbo, prettier, typescript-eslint, supertest and
 * every `@types/*` package ship to production, on a container that holds
 * CONTROL_DATABASE_URL and every tenant credential. A previous attempt trimmed
 * the COPY list (which removed the Next.js tree — a real 300 MB win) and was
 * correctly refused as incomplete: the install line was untouched, so all three
 * remaining manifests still contributed their dev trees.
 *
 * The two obvious fixes are both wrong here:
 *
 *   - `pnpm install --prod` / `pnpm prune --prod` deletes the container's own
 *     entrypoint. `tsx` is a devDependency of apps/api and the CMD is
 *     `./apps/api/node_modules/.bin/tsx apps/api/src/main.ts`; `prisma` is a
 *     devDependency of packages/db-control and the compose `migrate` one-shot
 *     runs `prisma migrate deploy` before api and worker are allowed to start.
 *     A prod install bricks the stack, exactly the way the pnpm version pin did
 *     (see scripts/check-pnpm-pins.mjs).
 *   - Promoting tsx/prisma to `dependencies` edits package.json, which changes
 *     pnpm-lock.yaml, which `--frozen-lockfile` then rejects.
 *
 * So this prunes by REACHABILITY instead of by dependency type: keep exactly
 * what the running processes can resolve, delete the rest.
 *
 * ## How reachability is computed
 *
 * pnpm's layout makes this exact and dependency-free — no YAML parser, no
 * lockfile reading, no network. Every installed package lives at
 * `node_modules/.pnpm/<dir>/node_modules/<name>`, and the SIBLINGS in that
 * `<dir>/node_modules/` are precisely the packages that copy can resolve
 * (including auto-installed peers, which is why walking package.json
 * `dependencies` alone would under-count and delete something live).
 *
 * Roots are the `dependencies` + `optionalDependencies` of each `--root`
 * workspace manifest, plus each `--keep <name>` resolved from wherever it is
 * declared. Workspace manifests are read from package.json rather than walked
 * as siblings BECAUSE their `node_modules/` also contains their
 * devDependencies — walking those would defeat the whole exercise.
 *
 * ## Verification
 *
 * `--dry-run` prints the counts and byte totals without touching anything, so
 * the before/after numbers in the remediation report come from this exact code.
 * The keep set was additionally checked against a live module-resolution trace
 * of three real processes — a NODE_ENV=production API serving a signup, the
 * BullMQ worker, and `prisma migrate deploy` — and the intersection of "loaded
 * at runtime" with "deleted here" was empty. Re-run that check if you change
 * the roots; a static reachability argument is only as good as its roots.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const roots = [];
const keep = [];
const requireBins = [];
let appDir = process.cwd();
let dryRun = false;
let withDev = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i]);
  else if (args[i] === '--keep') keep.push(args[++i]);
  // A path that MUST still resolve after the prune. The failure this guards
  // against is an image that builds clean and cannot start, so the assertion
  // belongs at build time, in the layer that did the deleting.
  else if (args[i] === '--require-bin') requireBins.push(args[++i]);
  else if (args[i] === '--app') appDir = path.resolve(args[++i]);
  else if (args[i] === '--dry-run') dryRun = true;
  // Measurement only: seed the walk from devDependencies too, i.e. reproduce
  // what the image installs TODAY. Refuses to delete, because the "before"
  // picture is not a prune plan.
  else if (args[i] === '--with-dev') {
    withDev = true;
    dryRun = true;
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
}
if (roots.length === 0) {
  console.error('at least one --root <workspace-dir> is required');
  process.exit(2);
}

const STORE = path.join(appDir, 'node_modules', '.pnpm');
if (!existsSync(STORE)) {
  console.error(`no pnpm store at ${STORE} — is this an installed workspace?`);
  process.exit(2);
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Real path of a package dir, or null if the symlink dangles / is absent. */
function resolvePkg(dir, name) {
  const p = path.join(dir, 'node_modules', ...name.split('/'));
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Every package directory inside one `.pnpm/<dir>/node_modules/`. */
function siblingsOf(containerDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(containerDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.bin' || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      let inner;
      try {
        inner = readdirSync(path.join(containerDir, e.name), { withFileTypes: true });
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

// ---- 1. seed the queue from the workspace manifests ------------------------
const queue = [];
const seen = new Set();
function push(realDir) {
  if (!realDir || seen.has(realDir)) return;
  seen.add(realDir);
  queue.push(realDir);
}

for (const root of roots) {
  const dir = path.join(appDir, root);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) {
    console.error(
      `✗ no package.json at ${dir} — check the --root list against the Dockerfile COPYs`,
    );
    process.exit(2);
  }
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...(withDev ? Object.keys(pkg.devDependencies ?? {}) : []),
  ];
  for (const name of names) push(resolvePkg(dir, name));
  // Runtime tooling that is declared as a devDependency but is genuinely
  // executed by a container: without this the image loses its entrypoint.
  for (const name of keep) {
    const r = resolvePkg(dir, name);
    if (r) push(r);
  }
}
for (const name of keep) {
  if (![...seen].some((d) => d.endsWith(path.join('node_modules', ...name.split('/'))))) {
    console.error(
      `✗ --keep ${name} resolved from none of the roots. It is declared somewhere the image does ` +
        `not copy, or the name is wrong; refusing to prune rather than delete a live entrypoint.`,
    );
    process.exit(2);
  }
}

// ---- 2. walk to a fixed point ---------------------------------------------
const keptStoreDirs = new Set();
while (queue.length) {
  const real = queue.pop();
  // …/.pnpm/<dir>/node_modules/<name>  →  <dir> and the container
  const rel = path.relative(STORE, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // a workspace link, not a store package
  const storeDir = rel.split(path.sep)[0];
  keptStoreDirs.add(storeDir);
  const container = path.join(STORE, storeDir, 'node_modules');
  for (const name of siblingsOf(container)) {
    try {
      push(realpathSync(path.join(container, ...name.split('/'))));
    } catch {
      /* dangling — nothing to keep */
    }
  }
}

// ---- 3. measure, then delete ----------------------------------------------
function bytesOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* raced away */
        }
      }
    }
  }
  return total;
}

const all = readdirSync(STORE).filter((d) => d !== 'node_modules' && d !== 'lock.yaml');
const doomed = all.filter((d) => !keptStoreDirs.has(d));

let keptBytes = 0;
let doomedBytes = 0;
for (const d of all) {
  const b = bytesOf(path.join(STORE, d));
  if (keptStoreDirs.has(d)) keptBytes += b;
  else doomedBytes += b;
}

const mib = (b) => (b / 1024 / 1024).toFixed(0);
const label = withDev
  ? 'BASELINE (dev+prod, i.e. what the image installs today)'
  : 'prune-dev-modules';
console.log(
  `${label}: reachable ${keptStoreDirs.size} package dir(s), ${withDev ? 'not pruning' : `removing ${doomed.length}`}`,
);
if (withDev) {
  console.log(`                   reachable bytes: ${mib(keptBytes)} MiB`);
  process.exit(0);
}
console.log(`                   reachable bytes: ${mib(keptBytes)} MiB`);
// The number this script exists to produce. It was computed and never printed,
// which cost the CI lint gate an error — and, more to the point, meant the
// script measured the saving and then threw it away. supply-chain-03 is a claim
// about image size; a claim needs a figure.
console.log(
  `                   removable bytes: ${mib(doomedBytes)} MiB across ${doomed.length} package dir(s)`,
);
if (dryRun) {
  console.log('                   --dry-run: nothing was deleted');
  console.log(doomed.sort().join('\n'));
  process.exit(0);
}

for (const d of doomed) rmSync(path.join(STORE, d), { recursive: true, force: true });

// ---- 4. sweep the symlinks that now point at nothing -----------------------
// Left behind, `apps/api/node_modules/vitest` is a dangling symlink and
// `docker image inspect` still shows the name. More importantly a dangling
// `.bin` entry makes `sh -c 'eslint …'` fail with a confusing ENOENT instead of
// a clean "not found".
let unlinked = 0;
function sweep(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      try {
        statSync(p); // follows the link; throws when the target is gone
      } catch {
        try {
          unlinkSync(p);
          unlinked++;
        } catch {
          /* ignore */
        }
      }
    } else if (e.isDirectory() && (e.name.startsWith('@') || e.name === '.bin')) {
      sweep(p);
    }
  }
}
for (const root of roots) sweep(path.join(appDir, root, 'node_modules'));
sweep(path.join(appDir, 'node_modules'));
for (const d of keptStoreDirs) sweep(path.join(STORE, d, 'node_modules'));
// pnpm's hoisted fallback dir. Not deleted (it is pure symlinks), but half of
// them now point at nothing, and it IS on the resolution path for packages
// inside the store.
sweep(path.join(STORE, 'node_modules'));

console.log(`                   swept ${unlinked} dangling symlink(s)`);

// ---- 5. refuse to succeed if the entrypoints are gone ----------------------
// The failure mode this whole file is guarding against is an image that builds
// clean and cannot start. Assert the two binaries the compose services invoke
// still resolve, in the image, at build time — the only place it is cheap.
let broken = 0;
for (const rel of requireBins) {
  const p = path.join(appDir, rel);
  try {
    lstatSync(p);
    realpathSync(p); // resolves the symlink chain; throws if the target went away
  } catch {
    console.error(`✗ ${rel} does not resolve after the prune — the image would not start.`);
    broken++;
  }
}
if (broken) {
  console.error('Refusing to produce an image that cannot start.');
  process.exit(1);
}
console.log(
  `                   entrypoints intact: ${requireBins.length ? requireBins.join(', ') : '(none asserted — pass --require-bin)'}`,
);
