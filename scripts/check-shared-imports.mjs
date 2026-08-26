#!/usr/bin/env node
// `import … from '@libriant/shared'` typechecks and then breaks `next build`.
//
// The package ships TypeScript source (`main: ./src/index.ts`) and its barrel
// re-exports with explicit `.js` specifiers, which is what Node ESM needs and
// what Turbopack cannot resolve. tsc is happy — it rewrites `.js` to `.ts` —
// so the mistake survives `pnpm typecheck` and surfaces as six
// `Module not found: Can't resolve './billing.js'` errors several minutes into
// a production build. I made exactly this mistake adding SEARCH_MIN_CHARS.
//
// Every web import must therefore use a subpath (`@libriant/shared/search`),
// which resolves to a single leaf module with no re-exports. This asserts that,
// and that the subpath a file asks for is actually exported.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PKG = 'packages/shared/package.json';
const ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/lib'];

const exportsMap = JSON.parse(readFileSync(PKG, 'utf8')).exports ?? {};
const subpaths = new Set(
  Object.keys(exportsMap)
    .filter((k) => k !== '.')
    .map((k) => k.replace(/^\.\//, '')),
);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const IMPORT = /from\s+'@libriant\/shared(\/[^']*)?'/g;

let bad = 0;
for (const file of ROOTS.flatMap((r) => walk(r))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT)) {
    const sub = m[1]?.slice(1);
    if (!sub) {
      console.error(`✗ ${file}`);
      console.error("    imports the '@libriant/shared' barrel, which Turbopack cannot resolve.");
      console.error(`    Use a subpath instead — available: ${[...subpaths].join(', ')}`);
      console.error('    (add one to the package\'s "exports" if the value you need has no home).');
      bad++;
    } else if (!subpaths.has(sub)) {
      console.error(`✗ ${file}`);
      console.error(`    imports '@libriant/shared/${sub}', which ${PKG} does not export.`);
      bad++;
    }
  }
}

if (bad) {
  console.error(`\n${bad} bad import(s). These pass \`pnpm typecheck\` and fail \`next build\`.`);
  process.exit(1);
}
console.log('shared-import check passed: every web import of @libriant/shared uses an exported subpath.');
