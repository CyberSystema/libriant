/**
 * CI gate: every slot in assets/manifest.json must resolve to a real file,
 * and every <Asset name="..."> reference in source must exist as a slot.
 *
 * Fail loudly so a missing icon never reaches users.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASSETS_DIR = path.join(REPO, 'assets');
const MANIFEST_FILE = path.join(ASSETS_DIR, 'manifest.json');

type Manifest = {
  slots: Record<string, { file: string; alt?: string }>;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function walk(dir: string, suffixes: string[]): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (suffixes.some((s) => e.name.endsWith(s))) {
        out.push(full);
      }
    }
  }
  return out;
}

async function main() {
  let errors = 0;
  const raw = await fs.readFile(MANIFEST_FILE, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;

  // 1) Every slot file exists.
  for (const [slot, { file }] of Object.entries(manifest.slots)) {
    const full = path.join(ASSETS_DIR, file);
    if (!(await fileExists(full))) {
      console.error(`[manifest] slot "${slot}" → file missing: assets/${file}`);
      errors++;
    }
  }

  // 2) Every <Asset name="..."> reference is listed in the manifest.
  const codeFiles = [
    ...(await walk(path.join(REPO, 'apps'), ['.ts', '.tsx'])),
    ...(await walk(path.join(REPO, 'packages'), ['.ts', '.tsx'])),
  ];
  const referenced = new Set<string>();
  const pattern = /(?:<Asset\s+name=|useAssetUrl\()\s*["'`]([^"'`]+)["'`]/g;
  for (const f of codeFiles) {
    const text = await fs.readFile(f, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      referenced.add(m[1]!);
    }
  }
  const slots = new Set(Object.keys(manifest.slots));
  for (const ref of referenced) {
    if (!slots.has(ref)) {
      console.error(`[code] referenced asset slot "${ref}" is not in assets/manifest.json`);
      errors++;
    }
  }

  if (errors > 0) {
    console.error(`\nAsset check FAILED with ${errors} issue(s).`);
    process.exit(1);
  }
  console.log(
    `Asset check passed: ${slots.size} slots declared, ${referenced.size} referenced in code.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
