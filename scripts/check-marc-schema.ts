/**
 * CI gate: the committed format definitions are well-formed, honest about their
 * own coverage, unedited since they were last recorded, and consistent with the
 * templates that bind them.
 *
 * ## Why a definition needs a gate at all
 *
 * A validator driven by data has a failure mode a validator written in code does
 * not: a misspelled key is not a syntax error, it is a rule that silently stops
 * applying. Nothing typechecks a JSON file, nothing runs it, and the symptom —
 * fewer complaints — looks exactly like progress.
 *
 * So this checks five things:
 *
 *   1. **Shape.** Every definition loads and passes `validateSchema`.
 *   2. **Honesty.** `coverage.fieldCount` matches the real count (enforced by
 *      `validateSchema`), and `coverage.confidence` is stated.
 *   3. **Not hand-edited.** Each definition's SHA-256 matches the digest
 *      recorded beside it. Editing a definition is fine; editing one without
 *      re-recording the digest is what this refuses, because a definition is
 *      supposed to be generated and a hand edit is a decision somebody should
 *      have to make twice.
 *   4. **Templates bind only defined tags.** A template offering a field the
 *      validator knows nothing about is a form inviting a cataloguer to fill in
 *      something nothing will ever check.
 *   5. **No false positives on the corpus.** Every one of the 5,000 generated
 *      records validates with zero ERRORS.
 *
 * ## What check 5 replaces, and why it is worth anything
 *
 * The phase's criterion is "zero false positives on LC-published-valid records",
 * and there are no LC records here. The corpus is not a substitute for them —
 * but it is not circular either, and that is the point: it was written for phase
 * 7 to test byte-level round-tripping, months before this definition existed,
 * and its tags were chosen to exercise a serializer rather than to satisfy a
 * validator. A definition that complained about it would be complaining about
 * ordinary MARC.
 *
 * Regenerate the digests with `pnpm check:marc-schema --write`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, type AvramSchema } from '../packages/marc/src/avram.js';
import { generateCorpus } from '../packages/marc/src/__fixtures__/corpus.js';
import { readIso2709Record } from '../packages/marc/src/iso2709.js';
import { shippedSchema, SHIPPED_PROFILES } from '../packages/marc/src/definitions.js';
import { SHIPPED_TEMPLATES, checkTemplate } from '../packages/marc/src/templates.js';
import { RULE_PACKS, schemaForRecord } from '../packages/marc/src/rules.js';
import { describeIssue } from '../packages/marc/src/issues.js';
import { validate } from '../packages/marc/src/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFINITIONS = path.join(ROOT, 'packages/marc/src/definitions');
const DIGESTS = path.join(DEFINITIONS, 'digests.json');
const WRITE = process.argv.includes('--write');

const FILES: Readonly<Record<string, string>> = {
  'marc21/bibliographic': 'marc21-bibliographic.json',
};

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

// -- 1 & 2. shape and honesty ------------------------------------------------
//
// Loaded ONCE, here, into a map every later check reads. `shippedSchema` throws
// on a malformed definition, and a later check calling it again would crash the
// gate with a stack trace instead of the failure list — which is what a gate is
// for.

const LOADED = new Map<string, AvramSchema>();

for (const profile of SHIPPED_PROFILES) {
  let schema: AvramSchema;
  try {
    schema = shippedSchema(profile);
  } catch (err) {
    fail(`${profile} does not load: ${(err as Error).message}`);
    continue;
  }
  LOADED.set(profile, schema);
  for (const problem of validateSchema(schema)) fail(`${profile}: ${problem}`);
  if (!schema.coverage.limits.trim()) {
    fail(
      `${profile}: coverage.limits is empty. A partial definition that does not say what it ` +
        'omits is the dangerous kind — a reader takes a clean result for a valid record.',
    );
  }
}

// -- 3. not hand-edited ------------------------------------------------------

const digests: Record<string, string> = {};
for (const [profile, file] of Object.entries(FILES)) {
  const full = path.join(DEFINITIONS, file);
  if (!existsSync(full)) {
    fail(`${file} is missing.`);
    continue;
  }
  digests[file] = createHash('sha256').update(readFileSync(full)).digest('hex');
  void profile;
}

if (WRITE) {
  writeFileSync(DIGESTS, `${JSON.stringify(digests, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, DIGESTS)}`);
} else if (!existsSync(DIGESTS)) {
  fail(`${path.relative(ROOT, DIGESTS)} is missing. Run \`pnpm check:marc-schema --write\`.`);
} else {
  const recorded = JSON.parse(readFileSync(DIGESTS, 'utf8')) as Record<string, string>;
  for (const [file, digest] of Object.entries(digests)) {
    if (recorded[file] === digest) continue;
    fail(
      `${file} has changed since its digest was recorded.\n` +
        `    recorded ${recorded[file] ?? '(none)'}\n` +
        `    actual   ${digest}\n` +
        '    A format definition is meant to be GENERATED. If this edit was deliberate, run\n' +
        '    `pnpm check:marc-schema --write` and commit the digest with it — the point is that\n' +
        '    a hand edit to a validation rule is a decision somebody makes twice.',
    );
  }
  for (const file of Object.keys(recorded)) {
    if (!digests[file]) fail(`${file} has a recorded digest and no file.`);
  }
}

// -- 4. templates ------------------------------------------------------------

if (!SHIPPED_TEMPLATES.length)
  fail('No templates are shipped; the template check would be vacuous.');
for (const template of SHIPPED_TEMPLATES) {
  const schema = LOADED.get(template.profile);
  if (!schema) {
    fail(`template "${template.id}" is for ${template.profile}, which did not load.`);
    continue;
  }
  for (const problem of checkTemplate(template, schema)) fail(problem);
}

// -- 5. no false positives on the corpus -------------------------------------

const bibliographic = LOADED.get('marc21/bibliographic');
if (!bibliographic) {
  fail('marc21/bibliographic did not load, so the corpus check could not run at all.');
} else {
  const schema = bibliographic;
  const corpus = generateCorpus(5000);
  const offenders = new Map<string, number>();
  let checked = 0;
  const unchecked = new Set<string>();
  for (const entry of corpus) {
    const record = readIso2709Record(entry.bytes).record;
    const report = validate(record, schemaForRecord(schema, record));
    checked += 1;
    for (const tag of report.uncheckedTags) unchecked.add(tag);
    // Zero ISSUES, not zero errors. "Zero errors" is close to vacuous while the
    // definition declares `confidence: "transcribed"`, because no table rule CAN
    // produce an error — so the assertion that would actually catch a wrong
    // indicator list or a wrong repeatability row has to count warnings too.
    for (const issue of report.issues) {
      offenders.set(describeIssue(issue), (offenders.get(describeIssue(issue)) ?? 0) + 1);
    }
  }
  if (checked !== 5000) fail(`the corpus produced ${checked} records, not 5000.`);
  if (offenders.size) {
    fail(
      `the shipped definition complains about the generated corpus, which is ordinary MARC:\n` +
        [...offenders].map(([text, n]) => `    ${n}x ${text}`).join('\n'),
    );
  }
  console.log(
    `check:marc-schema: ${checked} corpus records, 0 issues of any severity; ` +
      `tags never checked: ${[...unchecked].sort().join(', ') || 'none'}`,
  );
}

// -- rule packs --------------------------------------------------------------

{
  // Packs COMPOSE and are not required to partition Leader/18 — RDA and ISBD are
  // orthogonal, and a record coded 'i' is both. What must hold instead is that
  // every value a pack selects on is a Leader/18 code the definition defines,
  // so a pack cannot key on a byte that can never appear.
  const ldr18 = new Set(
    Object.keys(bibliographic?.fields.LDR?.positions?.['18']?.codes ?? {}).map((c) =>
      c === '#' || c === '_' ? ' ' : c,
    ),
  );
  for (const pack of RULE_PACKS) {
    if (!pack.note.trim()) fail(`rule pack "${pack.id}" has no note saying what it is for.`);
    for (const form of pack.descriptiveForm) {
      if (ldr18.size && !ldr18.has(form)) {
        fail(
          `rule pack "${pack.id}" selects on Leader/18 = ${JSON.stringify(form)}, which the ` +
            'definition does not list as a legal value. It could never be selected.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\ncheck:marc-schema — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(
  `check:marc-schema ok — ${SHIPPED_PROFILES.length} definition(s), ` +
    `${SHIPPED_TEMPLATES.length} template(s), ${RULE_PACKS.length} rule pack(s).`,
);
