/**
 * CI gate: the published API contract is generated from the code, and the code
 * and the committed document have not drifted apart.
 *
 * WHY THIS IS A BUILD FAILURE AND NOT A REVIEW CHECKLIST. A stale API document
 * is the defining flaw of every incumbent ILS: the spec is a separate artefact
 * that somebody updates, so it describes endpoints that answer differently. The
 * only fix that holds is that there is no separate artefact — `defineEndpoint()`
 * in `apps/api/src/public-api/registry.ts` is simultaneously the validation
 * wiring and the OpenAPI source, and this gate refuses a build where the two
 * disagree (2.0 contract 4.9).
 *
 * ## Two things you must know before editing this file
 *
 * 1. **It MUST run as `tsx --tsconfig apps/api/tsconfig.json`.** There is no
 *    `tsconfig.json` at the repository root — only `tsconfig.base.json` — so a
 *    plain `tsx scripts/check-openapi.ts` finds no `experimentalDecorators` and
 *    transpiles the DTOs with TC39 standard decorators. Importing one then dies
 *    at class-definition time with
 *      `TypeError: Cannot read properties of undefined (reading 'constructor')`
 *      `at class-validator/src/decorator/common/ValidateBy.ts:27`
 *    which reads like a class-validator bug and is a transpiler-configuration
 *    bug. This is the first gate in the repository that imports decorated
 *    classes; `check:permissions` and `check:alerts` import plain modules and
 *    have never hit it.
 * 2. **`import 'reflect-metadata'` must stay the first statement.** Without it
 *    the same import dies at `class-transformer`'s `@Type` decorator with
 *    `Reflect.getMetadata is not a function`.
 *
 * Both are asserted below rather than merely documented, so a future
 * refactoring of the npm script fails loudly instead of quietly deriving empty
 * schemas.
 *
 * A corollary: this file declares NO decorated classes of its own. `tsx` applies
 * that tsconfig only to the files its `include` (`src/**`) covers, so a DTO
 * written here would be transpiled with the wrong decorators and crash. The
 * fixtures — including the ones the deriver must refuse — live in
 * `apps/api/src/public-api/__fixtures__/example.dto.ts`.
 *
 * ## What it checks
 *
 *   1. The decorator toolchain actually produced metadata (anti-vacuity).
 *   2. `docs/api/openapi.v1.json` equals the document the registry renders.
 *   3. `docs/api/openapi.fixture.json` equals the schema the deriver produces
 *      for the fixture DTOs.
 *   4. The derived schema AGREES WITH `validateDto()` — every property the
 *      schema calls required is genuinely rejected when omitted, every optional
 *      one is genuinely accepted, and an unknown key is genuinely refused.
 *      This is the check that is non-vacuous with an empty endpoint registry,
 *      and it is the one that would catch a deriver quietly returning `{}`.
 *   5. The deriver refuses what its documentation says it refuses.
 *
 * Regenerate the two committed documents with `pnpm check:openapi --write`.
 */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getMetadataStorage } from 'class-validator';
import { deriveJsonSchema, type JsonSchema } from '../apps/api/src/public-api/json-schema.js';
import { PUBLIC_ENDPOINTS, renderOpenApiJson } from '../apps/api/src/public-api/registry.js';
import {
  ExampleAuthorDto,
  ExampleRecordDto,
  RefusedConditionalDto,
  RefusedCustomValidatorDto,
} from '../apps/api/src/public-api/__fixtures__/example.dto.js';
import { validateDto } from '../apps/api/src/auth/validate-dto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'docs/api/openapi.v1.json');
const FIXTURE = path.join(ROOT, 'docs/api/openapi.fixture.json');
const WRITE = process.argv.includes('--write');

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

/** The nested classes the deriver cannot recover from metadata. See json-schema.ts. */
const FIXTURE_NESTED = { authors: ExampleAuthorDto };

// -- 1. the toolchain is really running -------------------------------------

if (typeof (Reflect as { getMetadata?: unknown }).getMetadata !== 'function') {
  fail(
    "reflect-metadata is not loaded. `import 'reflect-metadata'` must be the FIRST statement " +
      "of this file — class-transformer's @Type decorator calls Reflect.getMetadata at class " +
      'definition time.',
  );
}
/**
 * Derived first, because `deriveJsonSchema` THROWING on absent metadata is the
 * primary anti-vacuity signal: a stripped-decorator build cannot reach the
 * comparisons below at all.
 */
const fixtureSchema = deriveJsonSchema(ExampleRecordDto, { nested: FIXTURE_NESTED });

{
  // The secondary signal, for PARTIAL stripping: every property the schema
  // knows about came from at least one metadata entry, so the count can never
  // legitimately be lower. Expressed against the schema rather than a magic
  // number so adding a decorator to the fixture does not break it.
  const metas = getMetadataStorage().getTargetValidationMetadatas(
    ExampleRecordDto,
    '',
    true,
    false,
  );
  const properties = Object.keys(fixtureSchema.properties ?? {}).length;
  if (metas.length < properties) {
    fail(
      `ExampleRecordDto produced ${metas.length} class-validator metadata entries for ` +
        `${properties} properties. Decorators are being dropped — run this gate as ` +
        '`tsx --tsconfig apps/api/tsconfig.json`, and see the header.',
    );
  }
}

// -- 2 & 3. the committed documents match what the code renders --------------

function compareOrWrite(file: string, actual: string, label: string): void {
  if (WRITE) {
    writeFileSync(file, actual);
    console.log(`wrote ${path.relative(ROOT, file)}`);
    return;
  }
  let committed: string;
  try {
    committed = readFileSync(file, 'utf8');
  } catch {
    fail(`${path.relative(ROOT, file)} is missing. Run \`pnpm check:openapi --write\`.`);
    return;
  }
  if (committed !== actual) {
    fail(
      `${path.relative(ROOT, file)} is out of date — ${label} changed and the committed ` +
        'document did not. Run `pnpm check:openapi --write` and commit the result. A published ' +
        'contract that does not describe the server is the failure this gate exists to prevent.',
    );
  }
}

compareOrWrite(SPEC, renderOpenApiJson(), 'the endpoint registry');

compareOrWrite(FIXTURE, `${JSON.stringify(fixtureSchema, null, 2)}\n`, 'a fixture DTO');

// -- 4. the schema and the validator are the same declaration ---------------

/**
 * A minimal value that satisfies a derived property schema.
 *
 * Deliberately minimal — the point is to produce something `validateDto()`
 * accepts, so that the ONLY reason a probe fails is the property that was
 * removed on purpose.
 */
function sampleFor(schema: JsonSchema, where: string): unknown {
  if ('const' in schema) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'string': {
      if (schema.format === 'email') return 'librarian@example.gr';
      if (schema.format === 'date-time') return '2026-09-07T10:00:00.000Z';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      const min = Math.max(schema.minLength ?? 1, 1);
      return 'x'.repeat(min);
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    case 'array': {
      const item = schema.items
        ? sampleFor(schema.items, `${where}[]`)
        : (() => {
            throw new Error(`${where}: array without items — the deriver should not emit that.`);
          })();
      return Array.from({ length: Math.max(schema.minItems ?? 1, 1) }, () => item);
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        if (schema.required?.includes(k)) out[k] = sampleFor(v, `${where}.${k}`);
      }
      return out;
    }
    default:
      throw new Error(`${where}: no sample for schema ${JSON.stringify(schema)}`);
  }
}

async function accepts(cls: Parameters<typeof validateDto>[0], payload: unknown): Promise<boolean> {
  try {
    await validateDto(cls, payload);
    return true;
  } catch {
    return false;
  }
}

async function checkAgreement(
  cls: Parameters<typeof validateDto>[0],
  schema: JsonSchema,
  name: string,
): Promise<void> {
  const full = sampleFor(schema, name) as Record<string, unknown>;
  // Optional properties are absent from `sampleFor`, so add them here: the
  // baseline must exercise every property the schema declares.
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (!(k in full)) full[k] = sampleFor(v, `${name}.${k}`);
  }
  if (!(await accepts(cls, full))) {
    fail(
      `${name}: a payload built from the derived schema was REJECTED by validateDto(). The ` +
        'published contract describes requests the server refuses.',
    );
    return;
  }

  const required = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties ?? {})) {
    const without = { ...full };
    delete without[key];
    const ok = await accepts(cls, without);
    if (required.has(key) && ok) {
      fail(
        `${name}.${key}: the schema says required, but validateDto() accepts a payload without ` +
          'it. A generated client would treat it as mandatory for no reason.',
      );
    }
    if (!required.has(key) && !ok) {
      fail(
        `${name}.${key}: the schema says optional, but validateDto() REJECTS a payload without ` +
          'it. A generated client would omit it and get a 400 — this is the @ValidateIf trap.',
      );
    }
  }

  // `additionalProperties: false` is a promise about `forbidNonWhitelisted`.
  if (schema.additionalProperties === false) {
    if (await accepts(cls, { ...full, unexpectedField: 'x' })) {
      fail(
        `${name}: the schema says additionalProperties: false, but validateDto() accepted an ` +
          'unknown property. Either forbidNonWhitelisted was turned off in validate-dto.ts, or ' +
          'the deriver is promising a strictness the server does not enforce.',
      );
    }
  }
}

// -- 5. the deriver refuses what it says it refuses --------------------------

function refuses(label: string, run: () => unknown, expect: RegExp): void {
  try {
    run();
  } catch (err) {
    const message = (err as Error).message;
    if (!expect.test(message)) {
      fail(`${label}: threw, but not for the stated reason — ${message}`);
    }
    return;
  }
  fail(
    `${label}: the deriver ACCEPTED this. Its refusals are what keep the published contract ` +
      'from understating what the server enforces; a silent pass is the whole failure mode.',
  );
}

function checkRefusals(): void {
  refuses(
    '@ValidateNested() with no nested class',
    () => deriveJsonSchema(ExampleRecordDto),
    /no class was given/,
  );
  refuses(
    '@ValidateIf() without @IsOptional()',
    () => deriveJsonSchema(RefusedConditionalDto),
    /ValidateIf/,
  );
  refuses(
    'an unmapped custom validator',
    () => deriveJsonSchema(RefusedCustomValidatorDto),
    /maxPasswordBytes/,
  );
  // …and the declared escape hatch works.
  const escaped = deriveJsonSchema(RefusedCustomValidatorDto, {
    customValidators: { maxPasswordBytes: { type: 'string', maxLength: 72 } },
  });
  if (escaped.properties?.password?.maxLength !== 72) {
    fail('customValidators did not apply the declared fragment.');
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await checkAgreement(ExampleRecordDto, fixtureSchema, 'ExampleRecordDto');
  await checkAgreement(ExampleAuthorDto, deriveJsonSchema(ExampleAuthorDto), 'ExampleAuthorDto');
  checkRefusals();

  if (failures.length) {
    console.error(`check:openapi — ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  • ${f}\n`);
    process.exit(1);
  }
  console.log(
    `check:openapi ok — ${PUBLIC_ENDPOINTS.length} public endpoint(s), ` +
      'fixture schema and validator agree.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
