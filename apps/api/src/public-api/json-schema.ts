import { getMetadataStorage } from 'class-validator';

/**
 * JSON Schema derived from the `class-validator` decorators already on a DTO.
 *
 * ## Why not @nestjs/swagger
 *
 * It cannot work here. `@nestjs/swagger`'s plugin-free mode reads
 * `design:type` reflection metadata, and `tsx`/esbuild — the transpiler this
 * repository runs in development — does not emit it. That is not a new
 * discovery: it is the same reason `main.ts` abandoned Nest's global
 * `ValidationPipe`, and the reason `auth/validate-dto.ts` exists at all.
 * A spec generator that silently produced empty schemas in dev and full ones in
 * production would be worse than none.
 *
 * So the source of truth is the metadata `class-validator` records for itself —
 * the same metadata `validateDto()` enforces at runtime. The spec and the
 * validation cannot disagree, because they are the same declaration read twice.
 *
 * ## What the metadata actually looks like
 *
 * Not what the decorator is called. In class-validator 0.15 every built-in
 * constraint records `type: 'customValidation'` and puts its identity in
 * `name`; `@IsOptional()` records `type: 'conditionalValidation'`. Measured
 * across all 23 DTO files and 58 classes in this repository, the complete set
 * of names in use is the table below. `@Length(1, 32)` records as `isLength`
 * with `constraints: [1, 32]` — not as `length`.
 *
 * ## Unknown validators THROW
 *
 * A decorator this table does not know is a constraint the published contract
 * would not mention, so a client generated from it would send a request the
 * server rejects. `maxPasswordBytes` (auth/dto/password-bounds.ts) is exactly
 * such a validator: project-defined, meaningful, and unguessable. Refusing is
 * the only honest answer — a spec that quietly understates the contract is the
 * defining flaw of every incumbent ILS API, and it is the thing `check:openapi`
 * exists to prevent.
 */

/** The JSON Schema subset this deriver produces (2020-12, as OpenAPI 3.1 uses). */
export type JsonSchema = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  format?: string;
  enum?: readonly unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
};

/** A class-validator metadata entry, narrowed to the fields this reads. */
type Meta = {
  type: string;
  name?: string;
  constraints?: unknown[];
  each: boolean;
};

/**
 * A DTO class. `never[]` parameters accept any constructor signature while
 * still saying "this is a class, not any callable" — the bare `Function` type
 * would also admit a plain function, which has no validation metadata and would
 * fail one layer deeper with a confusing message.
 */
export type DtoClass = abstract new (...args: never[]) => object;

export type DeriveOptions = {
  /**
   * The class behind each `@ValidateNested()` property.
   *
   * class-validator's metadata does NOT carry it — the nested type comes from
   * `@Type(() => X)`, which is class-transformer's own metadata, reachable only
   * through the unexported deep path `class-transformer/cjs/storage`. Reaching
   * into a package's private build to read a spec is how a dependency bump
   * becomes a silently empty schema, so the nested class is named here instead
   * and the deriver refuses without it.
   */
  nested?: Record<string, DtoClass>;
  /**
   * Validators this deriver has no rule for, and the schema fragment to use.
   * Every entry is a promise about what the server enforces, so each one is a
   * decision somebody made rather than a default.
   */
  customValidators?: Record<string, JsonSchema>;
};

/**
 * One validator name → the schema fragment it contributes.
 *
 * Derived by reading the metadata this repository's DTOs actually produce, not
 * from the decorator names. Add a row when a DTO starts using a new decorator;
 * the deriver will tell you which one, by name and property.
 */
const VALIDATORS: Record<string, (c: readonly unknown[]) => JsonSchema> = {
  // --- types --------------------------------------------------------------
  isString: () => ({ type: 'string' }),
  isInt: () => ({ type: 'integer' }),
  isNumber: () => ({ type: 'number' }),
  isBoolean: () => ({ type: 'boolean' }),
  isArray: () => ({ type: 'array' }),
  isObject: () => ({ type: 'object' }),
  // --- string formats -----------------------------------------------------
  isEmail: () => ({ type: 'string', format: 'email' }),
  isUrl: () => ({ type: 'string', format: 'uri' }),
  isUuid: () => ({ type: 'string', format: 'uuid' }),
  // `@IsDateString()` accepts any ISO 8601 string; `date-time` is the closest
  // OpenAPI format and is what every generator maps to a timestamp.
  isDateString: () => ({ type: 'string', format: 'date-time' }),
  // --- string bounds ------------------------------------------------------
  isLength: (c) => ({
    type: 'string',
    ...(typeof c[0] === 'number' ? { minLength: c[0] } : {}),
    ...(typeof c[1] === 'number' ? { maxLength: c[1] } : {}),
  }),
  minLength: (c) => ({ type: 'string', ...(typeof c[0] === 'number' ? { minLength: c[0] } : {}) }),
  maxLength: (c) => ({ type: 'string', ...(typeof c[0] === 'number' ? { maxLength: c[0] } : {}) }),
  // `constraints[0]` is a RegExp object. `.source` is the pattern without the
  // delimiters, which is what JSON Schema wants; flags are dropped because JSON
  // Schema has none — a `/i` pattern therefore publishes as case-SENSITIVE and
  // is stricter than the server, never looser.
  matches: (c) => ({ type: 'string', ...(c[0] instanceof RegExp ? { pattern: c[0].source } : {}) }),
  // --- numeric bounds -----------------------------------------------------
  min: (c) => (typeof c[0] === 'number' ? { minimum: c[0] } : {}),
  max: (c) => (typeof c[0] === 'number' ? { maximum: c[0] } : {}),
  // --- sets and constants -------------------------------------------------
  isIn: (c) => (Array.isArray(c[0]) ? { enum: c[0] as unknown[] } : {}),
  equals: (c) => ({ const: c[0] }),
  // --- arrays -------------------------------------------------------------
  arrayMinSize: (c) => ({ type: 'array', ...(typeof c[0] === 'number' ? { minItems: c[0] } : {}) }),
  arrayMaxSize: (c) => ({ type: 'array', ...(typeof c[0] === 'number' ? { maxItems: c[0] } : {}) }),
};

/** Merge a fragment into a property schema, keeping the tighter bound. */
function merge(into: JsonSchema, add: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...into };
  for (const [k, v] of Object.entries(add) as [keyof JsonSchema, unknown][]) {
    if (v === undefined) continue;
    const prev = out[k];
    if (prev === undefined) {
      (out as Record<string, unknown>)[k] = v;
      continue;
    }
    // Two decorators bounding the same thing: keep the stricter one, so the
    // published contract never claims to accept more than the server does.
    if (k === 'minLength' || k === 'minimum' || k === 'minItems') {
      (out as Record<string, unknown>)[k] = Math.max(prev as number, v as number);
    } else if (k === 'maxLength' || k === 'maximum' || k === 'maxItems') {
      (out as Record<string, unknown>)[k] = Math.min(prev as number, v as number);
    } else if (k === 'type' && prev !== v) {
      // `@IsArray() @IsString({ each: true })` is the legitimate case, and the
      // `each` handling below has already turned the inner one into `items`.
      // Anything else is two decorators disagreeing about the type.
      throw new Error(`conflicting types "${String(prev)}" and "${String(v)}"`);
    }
  }
  return out;
}

/**
 * Derive a JSON Schema object for a DTO class.
 *
 * Throws — never guesses — on a validator it does not know, on a
 * `@ValidateNested()` whose class was not supplied, and on a property carrying
 * no recognised type at all.
 */
export function deriveJsonSchema(dto: DtoClass, opts: DeriveOptions = {}): JsonSchema {
  const storage = getMetadataStorage();
  // `''` schema name, `always: true`, `strictGroups: false` — the same
  // arguments class-validator's own `validate()` uses for an ungrouped run,
  // which is how `validateDto()` calls it. Anything else would describe a
  // different contract from the one enforced.
  const metas = storage.getTargetValidationMetadatas(dto, '', true, false) as unknown as Meta[];
  if (!metas.length) {
    throw new Error(
      `${dto.name} carries no class-validator metadata. Either it is not a DTO, or its ` +
        'decorators were stripped — which is what happens when a build drops `reflect-metadata`.',
    );
  }
  const byProperty = storage.groupByPropertyName(metas as never) as Record<string, Meta[]>;

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [property, list] of Object.entries(byProperty)) {
    let schema: JsonSchema = {};
    let optional = false;
    let sawType = false;
    let eachOf: JsonSchema | null = null;

    for (const m of list) {
      if (m.type === 'conditionalValidation') {
        // `conditionalValidation` is TWO decorators wearing one type.
        // `@IsOptional()` records name `'isOptional'`; `@ValidateIf(fn)` records
        // the same type with `name: undefined` and the predicate in
        // `constraints[0]`. Measured on `system-mode.dto.ts`, whose `startsAt`
        // carries both: `startsAt=undefined startsAt="isOptional"`.
        //
        // Treating a bare `@ValidateIf` as "optional" would publish a required
        // field as optional — a generated client omits it and the server 400s,
        // which is precisely the drift this file exists to make impossible. And
        // "validated only when this arbitrary predicate holds" is not a thing
        // JSON Schema can say, so the honest answer is to refuse.
        if (m.name === 'isOptional') {
          optional = true;
          continue;
        }
        throw new Error(
          `${dto.name}.${property} uses @ValidateIf(), whose condition JSON Schema cannot ` +
            'express. Pair it with @IsOptional() if the field is genuinely optional, or model ' +
            'the two cases as two endpoints.',
        );
      }
      if (m.type === 'nestedValidation') {
        const cls = opts.nested?.[property];
        if (!cls) {
          throw new Error(
            `${dto.name}.${property} is @ValidateNested() but no class was given for it. ` +
              "class-validator's metadata does not carry the nested type — pass it as " +
              `nested: { ${property}: TheDto }.`,
          );
        }
        const inner = deriveJsonSchema(cls, opts);
        if (m.each) eachOf = merge(eachOf ?? {}, inner);
        else schema = merge(schema, inner);
        sawType = true;
        continue;
      }
      const name = m.name;
      const rule = name ? (VALIDATORS[name] ?? undefined) : undefined;
      const custom = name ? opts.customValidators?.[name] : undefined;
      // `?? []` is load-bearing, not defensive. `ValidationMetadata` types
      // `constraints` as `any[]`, but the constructor only assigns it when the
      // decorator passed one: measured on `CreateBookDto`, 15 of 40 metadata
      // entries have `constraints === undefined` (every bare `@IsString()`).
      const fragment = custom ?? rule?.(m.constraints ?? []);
      if (!fragment) {
        throw new Error(
          `${dto.name}.${property} uses the validator "${name ?? m.type}", which this deriver ` +
            'has no rule for. A constraint the published contract does not mention is a request ' +
            'a generated client will send and the server will reject. Add it to VALIDATORS in ' +
            'public-api/json-schema.ts, or declare it in `customValidators` at the endpoint.',
        );
      }
      // `in`, not truthiness: `@Equals(false)` and `@Equals(0)` produce a
      // perfectly good `const` that is falsy, and a truthiness test would
      // report a valid DTO as having no type at all.
      if ('type' in fragment || 'enum' in fragment || 'const' in fragment) sawType = true;
      // `{ each: true }` describes the ITEMS, not the property.
      if (m.each) eachOf = merge(eachOf ?? {}, fragment);
      else schema = merge(schema, fragment);
    }

    if (eachOf) schema = merge({ type: 'array' }, { ...schema, items: eachOf });
    if (!sawType) {
      throw new Error(
        `${dto.name}.${property} has validators but none that establishes a type. ` +
          'A schema without a type accepts anything, which is not what the server does.',
      );
    }
    properties[property] = schema;
    if (!optional) required.push(property);
  }

  return {
    type: 'object',
    properties,
    // `validateDto()` runs with `forbidNonWhitelisted: true`, so an unknown
    // property is a 400. Saying so is the difference between a client that
    // sends a stray field and one that does not.
    additionalProperties: false,
    ...(required.length ? { required: required.sort() } : {}),
  };
}
