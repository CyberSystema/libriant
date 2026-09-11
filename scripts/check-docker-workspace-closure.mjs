#!/usr/bin/env node
// Assert every Dockerfile copies the whole workspace closure of the app it
// builds — the manifests, the sources, and the prune roots.
//
// WHY THIS EXISTS. apps/api/Dockerfile maintains three hand-written lists of
// workspace packages: the package.json COPYs in `deps`, the source COPYs in
// `build`, and the `--root` flags on the prune step. On 2026-09-07 phase 10
// added `@libriant/marc` to apps/api's dependencies and to none of those three
// lists. The API image could not boot for the next nine phases — every
// container exited immediately with
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@libriant/marc'
//       imported from /app/apps/api/src/bib/bib-write.service.ts
//
// and phase 12 quietly added a second one, @libriant/circ-policy, which nobody
// ever saw because the ES module loader stops at the first failure.
//
// IT IS SILENT BY CONSTRUCTION, which is the part worth understanding. The
// Dockerfile comment above those COPYs correctly notes that omitting a
// workspace member is safe under `--frozen-lockfile`, because pnpm only
// validates the projects it finds on disk. That is true — and it is exactly
// what makes omitting a REAL dependency undetectable: pnpm does not error, it
// simply never creates node_modules/@libriant/<name>, the install succeeds, the
// image BUILDS, and the failure waits until something tries to import it at
// runtime. The same property that makes pruning apps/desktop safe makes
// dropping @libriant/marc invisible.
//
// Nothing else could catch it. typecheck, lint, the unit suite, the integration
// suite and the smoke suite all run against the full workspace on disk, where
// every package resolves. Only booting the built image can tell the difference,
// and that happens in one CI job that had been red so long it read as scenery.
//
// So: derive the list instead of trusting it. This runs in milliseconds, needs
// no Docker, and fails in the seconds before a review rather than during a
// deploy.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SCOPE = '@libriant/';

// Dockerfiles that build no workspace package. Each needs a reason, because an
// empty allowlist entry is how this gate would be talked out of its job.
const NO_WORKSPACE = new Map([
  [
    'infra/caddy/Dockerfile',
    // It DOES build a workspace package — a `site` stage compiles apps/site —
    // but the failure mode this gate exists for cannot occur there. The final
    // stage is `FROM caddy:2-alpine` and carries one thing out of the builder,
    // `apps/site/dist`, so the shipped image resolves no workspace package at
    // runtime and has no Node to resolve it with. A missing manifest in that
    // build stage fails the site build LOUDLY, at image build time, instead of
    // producing a green image that dies on boot. Loud is already covered.
    'builds apps/site in a discarded stage; the shipped image is Caddy plus apps/site/dist, ' +
      'so a missing manifest fails the build rather than the boot',
  ],
]);

let bad = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  bad++;
};

// ---------------------------------------------------------------------------
// The workspace, read from disk.
// ---------------------------------------------------------------------------
const dirOf = new Map(); // '@libriant/marc' -> 'packages/marc'
for (const base of ['apps', 'packages']) {
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base)) {
    const manifest = path.join(base, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    if (typeof name === 'string' && name.startsWith(SCOPE)) dirOf.set(name, path.join(base, entry));
  }
}
if (dirOf.size === 0) {
  fail('no workspace packages found under apps/ or packages/ — this gate is blind, point it at the right roots');
  process.exit(1);
}

/**
 * The transitive closure of workspace packages a package needs AT RUNTIME.
 *
 * `dependencies` only. devDependencies do not ship — the production image
 * prunes them (scripts/docker-prune-dev-modules.mjs) — so a workspace package
 * that is only a devDependency must NOT be required in the image. No app in
 * this repo has a workspace devDependency today; if one appears, this comment
 * is where to decide what it means rather than discovering it in production.
 */
function runtimeClosure(rootName) {
  const seen = new Set();
  const stack = [rootName];
  while (stack.length > 0) {
    const dir = dirOf.get(stack.pop());
    if (dir === undefined) continue;
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith(SCOPE) || seen.has(dep)) continue;
      seen.add(dep);
      stack.push(dep);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The Dockerfile, read as INSTRUCTIONS.
// ---------------------------------------------------------------------------
/**
 * Comments stripped and line continuations joined.
 *
 * Stripping comments is not tidiness, and check-pnpm-pins.mjs learned it the
 * hard way: a checker that matches prose reports a pin as present in a file
 * that no longer runs it. Here it matters more than usual, because the comment
 * this gate's own fix added to apps/api/Dockerfile NAMES the packages it is
 * checking for. Matching prose would make the gate satisfied by the description
 * of the bug.
 */
function instructions(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}

/** Every source path named by a COPY that reads from the build context. */
function copySources(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const m = /^\s*COPY\s+(.*)$/i.exec(line);
    if (m === null) continue;
    const parts = m[1].trim().split(/\s+/);
    // `COPY --from=build /app /app` copies from an earlier STAGE, not from the
    // build context, so it says nothing about what entered the image from the
    // repository. Skip it, and skip every other flag.
    if (parts.some((p) => /^--from=/.test(p))) continue;
    const paths = parts.filter((p) => !p.startsWith('--'));
    // The last path is the destination.
    out.push(...paths.slice(0, -1));
  }
  return out.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''));
}

/** Every `--root <dir>` handed to the dev-module pruner. */
function pruneRoots(src) {
  if (!/docker-prune-dev-modules\.mjs/.test(src)) return null; // no prune step
  return [...src.matchAll(/--root\s+(\S+)/g)].map((m) => m[1].replace(/^\.\//, '').replace(/\/+$/, ''));
}

// ---------------------------------------------------------------------------
// Every Dockerfile in the repository, so a new one cannot be silently unchecked.
// ---------------------------------------------------------------------------
const dockerfiles = [];
for (const base of ['apps', 'packages']) {
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base)) {
    const f = path.join(base, entry, 'Dockerfile');
    if (existsSync(f)) dockerfiles.push(f);
  }
}
for (const f of NO_WORKSPACE.keys()) {
  if (existsSync(f)) dockerfiles.push(f);
  else fail(`${f} is allowlisted as building no workspace package, but the file is gone — drop the entry`);
}
dockerfiles.sort();

let checked = 0;
for (const file of dockerfiles) {
  if (NO_WORKSPACE.has(file)) continue;

  const dir = path.dirname(file);
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) {
    fail(
      `${file}: no package.json beside it, so this gate cannot tell what it builds. Either it ` +
        `builds a workspace package (give it one) or it does not (add it to NO_WORKSPACE with a reason).`,
    );
    continue;
  }
  const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
  const closure = runtimeClosure(name);
  const src = instructions(file);
  const sources = copySources(src);
  const roots = pruneRoots(src);
  checked++;

  for (const dep of [...closure].sort()) {
    const depDir = dirOf.get(dep);
    if (depDir === undefined) {
      fail(`${file}: ${name} depends on ${dep}, which is not a workspace package on disk`);
      continue;
    }
    if (!sources.includes(path.join(depDir, 'package.json'))) {
      fail(
        `${file}: ${name} depends on ${dep} but never copies ${depDir}/package.json. pnpm will ` +
          `not error — it silently skips the project and the container dies at startup with ` +
          `ERR_MODULE_NOT_FOUND. Add: COPY ${depDir}/package.json ${depDir}/package.json`,
      );
    }
    if (!sources.includes(depDir)) {
      fail(
        `${file}: ${name} depends on ${dep} but never copies ${depDir}. A manifest without its ` +
          `source is a dangling symlink. Add: COPY ${depDir} ${depDir}`,
      );
    }
    if (roots !== null && !roots.includes(depDir)) {
      fail(
        `${file}: ${name} depends on ${dep} but ${depDir} is not a --root of the dev-module ` +
          `prune. Its devDependencies would ship to production. Add: --root ${depDir}`,
      );
    }
  }

  // The other direction. supply-chain-03 removed apps/web from the API image
  // because a copied manifest is a whole dependency tree installed into a
  // container holding CONTROL_DATABASE_URL and every tenant credential. A gate
  // that only checked for MISSING entries would let that grow back.
  for (const source of new Set(sources)) {
    const owner = [...dirOf].find(([, d]) => d === source);
    if (owner === undefined) continue;
    const [ownerName] = owner;
    if (ownerName === name || closure.has(ownerName)) continue;
    fail(
      `${file}: copies ${source} (${ownerName}), which is not in ${name}'s runtime closure. ` +
        `That installs its whole dependency tree into this image for nothing — remove it, or ` +
        `declare the dependency if it is real.`,
    );
  }
}

if (bad > 0) {
  console.error(
    `\n${bad} problem(s). A missing workspace COPY builds a perfectly good image that cannot ` +
      `start — it is not caught by typecheck, tests or the smoke suite, only by booting the ` +
      `container. Fix before deploying.`,
  );
  process.exit(1);
}
console.log(
  `docker workspace closure check passed: ${checked} Dockerfile(s) copy the full runtime closure ` +
    `of what they build, and nothing they do not need.`,
);
