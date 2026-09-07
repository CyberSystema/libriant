/**
 * Regenerate `packages/marc/src/marc8-tables.ts` from LC's `codetables.xml`,
 * and — the mode CI runs — prove the committed tables still match it.
 *
 * ## Why this is a developer tool and not a build step
 *
 * The 2.0 plan's rule for this class of artefact is "generated and **committed**
 * — air-gapped builds fetch nothing". So the committed table is the source of
 * truth at build time, and this script exists to keep it honest against the
 * upstream file WHEN SOMEBODY HAS THAT FILE. It never fetches. A generator that
 * reached the network would also be the first thing an air-gapped install and
 * `check:supply-chain` both objected to.
 *
 * ## The file is not in this repository, and that is the point of --check
 *
 * `codetables.xml` is about a megabyte of LC's public-domain data. Nobody has
 * put a copy at {@link SOURCE_PATH} yet, so:
 *
 *   - `pnpm marc8:tables` (generate) FAILS LOUDLY, naming the path, the URL to
 *     fetch it from by hand, and what to do next.
 *   - `pnpm marc8:tables --check` (what CI would run) SKIPS with exit 0 and one
 *     printed line saying why, and does real work the moment the file appears.
 *
 * A --check mode that failed on a missing optional input would block every build
 * for a file most developers have no reason to hold; one that silently passed
 * would be indistinguishable from a check that works. Printing the skip is the
 * difference.
 *
 * ## What is committed today, and what closes the gap
 *
 * Two of the twelve graphic sets: Basic Latin and Extended Latin (ANSEL). The
 * other ten are hand-listed as known-but-unsupported and raise a typed anomaly
 * rather than a guess. Dropping LC's file at {@link SOURCE_PATH} and running
 * this script in generate mode is the whole of what it takes to close that —
 * see `packages/marc/src/marc8-tables.ts` for why guessing them would have been
 * worse than refusing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_TABLES } from '../packages/marc/src/marc8-tables.js';
import { MARC8_SET_NAME } from '../packages/marc/src/marc8-sets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a hand-fetched copy of LC's file goes. Not committed; not fetched. */
export const SOURCE_PATH = path.join(ROOT, 'vendor/marc/codetables.xml');
export const SOURCE_URL = 'https://www.loc.gov/marc/specifications/codetables.xml';
const TABLES_PATH = path.join(ROOT, 'packages/marc/src/marc8-tables.ts');

const CHECK = process.argv.includes('--check');

type Entry = { marc: number; ucs: string; combining: boolean };
type Parsed = { set: string; name: string; entries: Entry[] };

/**
 * Read the code tables out of LC's XML.
 *
 * Deliberately defensive rather than schema-driven: this parser has never been
 * run against the real file, so it reports what it FOUND — set count, entry
 * count per set — and refuses a result that is implausibly small, instead of
 * quietly emitting a table with three rows in it.
 */
export function parseCodeTables(xml: string): Parsed[] {
  const out: Parsed[] = [];
  const tableRe = /<codeTable\b([^>]*)>([\s\S]*?)<\/codeTable>/g;
  const attr = (text: string, name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(text)?.[1];

  for (const table of xml.matchAll(tableRe)) {
    const head = table[1] ?? '';
    const body = table[2] ?? '';
    const set = attr(head, 'ISOcode') ?? attr(head, 'isoCode') ?? '';
    const name = attr(head, 'name') ?? MARC8_SET_NAME[set] ?? set;
    const entries: Entry[] = [];
    for (const code of body.matchAll(/<code>([\s\S]*?)<\/code>/g)) {
      const inner = code[1] ?? '';
      const marcHex = /<marc>\s*([0-9A-Fa-f]+)\s*<\/marc>/.exec(inner)?.[1];
      if (!marcHex) continue;
      const ucsRaw = /<ucs>\s*([^<]*)<\/ucs>/.exec(inner)?.[1]?.trim() ?? '';
      // `<ucs>` is a possibly-multi-valued list of hex code points, and it is
      // legitimately EMPTY for a character with no Unicode equivalent. An empty
      // string is a real, lossy mapping; a number could not express it.
      const ucs = ucsRaw
        ? ucsRaw
            .split(/\s+/)
            .map((h) => String.fromCodePoint(Number.parseInt(h, 16)))
            .join('')
        : '';
      const combining = /<isCombining>\s*[Tt]rue\s*<\/isCombining>/.test(inner);
      entries.push({ marc: Number.parseInt(marcHex, 16), ucs, combining });
    }
    if (set && entries.length) out.push({ set, name, entries });
  }
  return out;
}

function fail(message: string): never {
  console.error(`gen-marc8-tables: ${message}`);
  process.exit(1);
}

function main(): void {
  if (!existsSync(SOURCE_PATH)) {
    const where = path.relative(ROOT, SOURCE_PATH);
    if (CHECK) {
      console.log(
        `gen-marc8-tables --check: skipped — ${where} is not present. ` +
          `The committed tables in packages/marc/src/marc8-tables.ts are the source of truth; ` +
          `drop LC's codetables.xml there to have this step verify them.`,
      );
      return;
    }
    fail(
      `${where} does not exist, and this script never fetches.\n` +
        `  Download it by hand from ${SOURCE_URL}, put it at that path, and run again.\n` +
        '  Until then the committed tables are the source of truth, and they cover only\n' +
        '  Basic Latin and Extended Latin (ANSEL). Every other graphic set raises\n' +
        '  marc8-unsupported-charset rather than guessing — see the header of\n' +
        '  packages/marc/src/marc8-tables.ts for why that is the safer half of the trade.',
    );
  }

  const xml = readFileSync(SOURCE_PATH, 'utf8');
  const sha = createHash('sha256').update(xml).digest('hex');
  const parsed = parseCodeTables(xml);
  console.log(
    `gen-marc8-tables: read ${parsed.length} code tables from ${path.relative(ROOT, SOURCE_PATH)}`,
  );
  console.log(`  sha256 ${sha}`);
  for (const t of parsed) console.log(`  ${t.set} ${t.name}: ${t.entries.length} entries`);

  if (parsed.length < 8) {
    fail(
      `only ${parsed.length} code tables were recognised. This parser has never been run ` +
        'against the real file; check the element names in parseCodeTables against it rather ' +
        'than trusting this output.',
    );
  }

  // The shrink guard: a table must never lose entries silently. This is the
  // check that catches a parser that half-worked.
  const problems: string[] = [];
  for (const committed of SUPPORTED_TABLES) {
    const upstream = parsed.find((t) => t.set === committed.set);
    if (!upstream) {
      problems.push(`${committed.set} (${committed.name}) is committed but absent upstream`);
      continue;
    }
    if (upstream.entries.length < committed.map.size) {
      problems.push(
        `${committed.set}: upstream has ${upstream.entries.length} entries, the committed ` +
          `table has ${committed.map.size}. Refusing to shrink a table.`,
      );
      continue;
    }
    for (const [byte, text] of committed.map) {
      const match = upstream.entries.find((e) => e.marc === byte);
      if (!match) {
        problems.push(`${committed.set}: 0x${byte.toString(16)} is committed but absent upstream`);
      } else if (match.ucs !== text) {
        problems.push(
          `${committed.set}: 0x${byte.toString(16)} is ${JSON.stringify(text)} here and ` +
            `${JSON.stringify(match.ucs)} upstream`,
        );
      }
    }
    for (const byte of committed.combining) {
      const match = upstream.entries.find((e) => e.marc === byte);
      if (match && !match.combining) {
        problems.push(`${committed.set}: 0x${byte.toString(16)} is combining here, not upstream`);
      }
    }
  }

  if (problems.length) {
    console.error(`\ngen-marc8-tables: ${problems.length} disagreement(s) with LC:\n`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error(
      `\nThe committed tables were hand-authored without this file. Every line above is a ` +
        `transcription error to fix in ${path.relative(ROOT, TABLES_PATH)}.`,
    );
    process.exit(1);
  }

  console.log(
    `\ngen-marc8-tables: every committed entry agrees with LC. ` +
      `${parsed.length - SUPPORTED_TABLES.length} further table(s) are available upstream and ` +
      'not yet committed — see the header of marc8-tables.ts.',
  );
}

main();
