#!/usr/bin/env node
// Gate the public legal documents.
//
// Two separate things are checked here, and only one of them is allowed to fail
// the build.
//
// FAILS — an author-facing note reaching a visitor. These documents open with a
// blockquote addressed to whoever is drafting them ("Replace every
// `[PLACEHOLDER]` and have it reviewed before you rely on it"). The web app
// renders each file with `marked.parse()`, so until 2026-08-24 that instruction
// was published verbatim on /legal/dpa and every other legal page — a contract
// whose first line told the reader it was unfinished and unreviewed.
// `apps/web/lib/legal.ts` now strips a LEADING blockquote before rendering, so
// the convention is: the note is the first block in the file, or it ships. This
// check enforces exactly that, and it is why anything author-facing found below
// the first block is an error.
//
// REPORTS — unfilled `[BRACKET TOKEN]` values in the body. These are the
// provider's registered details, and no engineer can invent them; they are
// blocked on the company being registered (finding privacy-legal-01). Failing
// the build on them would only mean the build is permanently red for a reason
// nobody in the repository can fix. Instead this prints the exact remaining
// list, so `pnpm check:legal` is the answer to "what is still missing before
// the legal pages can go live".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'locales';
const LOCALES = readdirSync(ROOT).filter((l) => {
  try {
    return readdirSync(join(ROOT, l)).includes('legal');
  } catch {
    return false;
  }
});

// Phrases that only ever address the person writing the document.
const AUTHOR_PHRASES = [
  /replace every/i,
  /fill in every/i,
  /before publishing/i,
  /before you publish/i,
  /verify each/i,
  /pending review by qualified legal counsel/i,
  /αντικαταστήστε κάθε/i,
  /συμπληρώστε κάθε/i,
  /πριν από τη δημοσίευση/i,
  /εκκρεμεί η εξέταση από εξειδικευμένο νομικό σύμβουλο/i,
];

// Placeholders are backticked by convention — `[COMPANY LEGAL NAME]` — which is
// exactly what separates them from an ordinary markdown link label such as
// [Privacy Policy](/legal/privacy). Requiring the backticks is what keeps this
// check from crying wolf on every cross-reference in the documents.
const TOKEN = /`\[[^\]\n]{2,}\]`/g;

/** Mirrors stripAuthorNote() in apps/web/lib/legal.ts — the leading blockquote. */
function splitNote(raw) {
  const lines = raw.split('\n');
  if (!lines[0]?.startsWith('>')) return { note: '', body: raw };
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  const note = lines.slice(0, i).join('\n');
  while (i < lines.length && lines[i].trim() === '') i++;
  return { note, body: lines.slice(i).join('\n') };
}

let errors = 0;
const unfilled = [];

for (const locale of LOCALES) {
  const dir = join(ROOT, locale, 'legal');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const rel = join(dir, file);
    const { body } = splitNote(readFileSync(rel, 'utf8'));

    // Anything author-facing that survives the strip WILL be published.
    body.split('\n').forEach((line, n) => {
      for (const re of AUTHOR_PHRASES) {
        if (re.test(line)) {
          console.error(
            `✗ ${rel}:${n + 1}: author-facing text outside the leading note — this renders to visitors`,
          );
          console.error(`    ${line.trim().slice(0, 120)}`);
          errors++;
          break;
        }
      }
    });

    for (const m of body.match(TOKEN) ?? []) {
      unfilled.push({ file: rel, token: m.replace(/`/g, '') });
    }
  }
}

if (unfilled.length) {
  const byToken = new Map();
  for (const u of unfilled) {
    if (!byToken.has(u.token)) byToken.set(u.token, new Set());
    byToken.get(u.token).add(u.file);
  }
  console.log(
    `\nNOT PUBLISHABLE YET — ${byToken.size} unfilled value(s) across ${new Set(unfilled.map((u) => u.file)).size} document(s).`,
  );
  console.log(
    "These are the provider's registered details; they need the company to exist (privacy-legal-01).\n",
  );
  for (const [token, files] of [...byToken].sort()) {
    console.log(`  ${token.padEnd(38)} ${files.size} doc(s)`);
  }
  console.log(
    '\nThe legal pages must not go live until this list is empty and counsel has reviewed them.',
  );
}

if (errors) {
  console.error(
    `\n${errors} author-facing line(s) would be published. Move them into the leading blockquote or delete them.`,
  );
  process.exit(1);
}
console.log(
  `\nlegal doc check passed: no author-facing text escapes into the rendered pages (${LOCALES.length} locales).`,
);
