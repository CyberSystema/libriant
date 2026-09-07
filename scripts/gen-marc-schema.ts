/**
 * Regenerate the committed Avram-shaped format definitions from a vendored
 * authority — and, in `--check` mode, prove the committed ones still match it.
 *
 * ## The same shape as `gen-marc8-tables.ts`, for the same reason
 *
 * The plan's rule for this class of artefact is "generated and **committed** —
 * air-gapped builds fetch nothing". So the committed JSON is the source of truth
 * at build time, and this script exists to keep it honest against an upstream
 * file WHEN SOMEBODY HAS ONE. It never fetches.
 *
 * ## No such file exists yet, and that is what `coverage.confidence` is about
 *
 * `packages/marc/src/definitions/marc21-bibliographic.json` was hand-transcribed
 * from memory of MARC 21. It says so in its own `coverage` block, and because it
 * declares `confidence: "transcribed"`, the validator caps every rule it reads
 * out of that file at WARNING — so a row that turns out to be wrong costs a
 * spurious warning and can never refuse a librarian's save.
 *
 * Vendoring an authority and running this script in generate mode is what turns
 * that into `confidence: "generated"`, and with it turns the table rules into
 * errors. That is the whole of what phase 8 owes a later session.
 *
 * ## What "an authority" means here, and the caution attached to it
 *
 * MARC 21 is published by LC as prose and as XSDs, not as a machine-readable
 * field list. Every Avram MARC file in circulation — GBV's `avram-specs`, the
 * `marc-schema` npm package, and others — is a THIRD-PARTY TRANSCRIPTION of that
 * prose. Vendoring one is a large improvement on memory and is still not LC. The
 * `coverage.source` this script writes must name which file it used and its
 * digest, so the next person knows exactly what they are trusting.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from '../packages/marc/src/avram.js';
import { shippedSchema } from '../packages/marc/src/definitions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a hand-fetched Avram MARC 21 file goes. Not committed; not fetched. */
export const SOURCE_PATH = path.join(ROOT, 'vendor/marc/marc21-bibliographic.avram.json');
export const SOURCE_NOTE =
  'An Avram schema for MARC 21 bibliographic. Candidates: GBV avram-specs ' +
  '(format.gbv.de), or the `marc-schema` npm package. Both are third-party ' +
  'transcriptions of LC prose, not an LC release.';

const CHECK = process.argv.includes('--check');

function main(): void {
  const where = path.relative(ROOT, SOURCE_PATH);
  if (!existsSync(SOURCE_PATH)) {
    if (CHECK) {
      console.log(
        `gen-marc-schema --check: skipped — ${where} is not present. The committed definitions ` +
          'are the source of truth and declare confidence "transcribed", which caps every rule ' +
          'they carry at a warning.',
      );
      return;
    }
    console.error(
      `gen-marc-schema: ${where} does not exist, and this script never fetches.\n` +
        `  ${SOURCE_NOTE}\n` +
        '  Put one at that path and run again. Until then the committed definition stands, and\n' +
        '  its own coverage block says what it does and does not describe.',
    );
    process.exit(1);
  }

  const raw = readFileSync(SOURCE_PATH, 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  console.log(`gen-marc-schema: read ${where}\n  sha256 ${digest}`);

  let upstream: { fields?: Record<string, unknown> };
  try {
    upstream = JSON.parse(raw) as { fields?: Record<string, unknown> };
  } catch (err) {
    console.error(`gen-marc-schema: ${where} is not JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  const upstreamTags = Object.keys(upstream.fields ?? {});
  if (upstreamTags.length < 100) {
    console.error(
      `gen-marc-schema: ${where} defines only ${upstreamTags.length} fields. A MARC 21 ` +
        'bibliographic schema has several hundred; this file is not what it claims to be, or ' +
        'this reader does not understand its shape. Refusing rather than shrinking the ' +
        'committed definition.',
    );
    process.exit(1);
  }

  // The committed definition is a SUBSET. Report what the upstream file would
  // add rather than overwriting silently: a generated definition raises errors
  // where a transcribed one raises warnings, and that promotion deserves a diff
  // somebody reads.
  const committed = shippedSchema('marc21/bibliographic');
  const committedTags = Object.keys(committed.fields);
  const missing = committedTags.filter((t) => t !== 'LDR' && !upstreamTags.includes(t));
  const added = upstreamTags.filter((t) => !committedTags.includes(t));

  console.log(`  committed: ${committedTags.length} fields, upstream: ${upstreamTags.length}`);
  console.log(`  upstream would ADD ${added.length} fields`);
  if (missing.length) {
    console.log(
      `  committed defines ${missing.length} field(s) the upstream file does not: ` +
        `${missing.join(', ')} — check these by hand before replacing anything.`,
    );
  }
  for (const problem of validateSchema(committed)) console.log(`  committed problem: ${problem}`);

  console.log(
    '\ngen-marc-schema: this script reports the difference and does not yet WRITE the merged\n' +
      '  definition. Writing it means promoting every table rule from warning to error, which\n' +
      '  needs the field-by-field reconciliation above to have been read by a person first.',
  );
}

main();
