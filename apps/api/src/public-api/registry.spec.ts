import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  buildOpenApiDocument,
  defineEndpoint,
  validateEndpoints,
  type EndpointDefinition,
} from './registry.js';
import { deriveJsonSchema } from './json-schema.js';
import {
  ExampleAuthorDto,
  ExampleRecordDto,
  RefusedConditionalDto,
  RefusedCustomValidatorDto,
} from './__fixtures__/example.dto.js';

/**
 * `PUBLIC_ENDPOINTS` is empty until M6, so nothing in the running system
 * exercises `validateEndpoints` or the document builder. These specs are the
 * only thing standing between those rules and their first real use — and the
 * point of writing them in phase 6 rather than phase 52 is that by then sixty
 * endpoints will already have been written against whatever the code happens
 * to do.
 */

const base: EndpointDefinition = defineEndpoint({
  operationId: 'listBibs',
  method: 'get',
  path: '/v1/bibs',
  summary: 'List bibliographic records.',
  tags: ['Catalogue'],
  permission: 'cat.bib.read',
  idempotent: false,
  responses: { 200: { description: 'A page of records.' } },
});

const withOverride = (o: Partial<EndpointDefinition>): EndpointDefinition[] => [{ ...base, ...o }];

describe('validateEndpoints', () => {
  it('accepts a well-formed declaration', () => {
    expect(() => validateEndpoints([base])).not.toThrow();
  });

  it.each([
    ['a non-camelCase operationId', { operationId: 'list_bibs' }, /lowerCamelCase/],
    ['an unversioned path', { path: '/bibs' }, /must start with "\/v1\/"/],
    ['a trailing slash', { path: '/v1/bibs/' }, /must not end in a slash/],
    ['a summary that is not a sentence', { summary: 'List bibs' }, /full stop/],
    ['no tags', { tags: [] }, /at least one tag/],
    ['a permission key that does not exist', { permission: 'cat.bib.invent' }, /permission model/],
    [
      'a write with no idempotency requirement',
      { method: 'post' as const, idempotent: false },
      /Idempotency-Key/,
    ],
    ['a GET carrying a body', { body: { dto: ExampleAuthorDto } }, /GET must not declare a body/],
    ['no 2xx response', { responses: { 404: { description: 'Gone.' } } }, /2xx response/],
    [
      'a response description that is not a sentence',
      { responses: { 200: { description: 'ok' } } },
      /full stop/,
    ],
  ])('rejects %s', (_label, override, expected) => {
    expect(() => validateEndpoints(withOverride(override))).toThrow(expected);
  });

  it('rejects a duplicate operationId — it is a generated client method name', () => {
    expect(() => validateEndpoints([base, { ...base, path: '/v1/other' }])).toThrow(
      /Duplicate operationId/,
    );
  });

  it('rejects the same method and path twice', () => {
    expect(() => validateEndpoints([base, { ...base, operationId: 'listBibsAgain' }])).toThrow(
      /Duplicate route/,
    );
  });
});

describe('buildOpenApiDocument', () => {
  it('is deterministic — the same registry renders byte-identically', () => {
    expect(JSON.stringify(buildOpenApiDocument([base]))).toEqual(
      JSON.stringify(buildOpenApiDocument([base])),
    );
  });

  it('demands an Idempotency-Key header on an idempotent operation', () => {
    const doc = buildOpenApiDocument(
      withOverride({ method: 'post', operationId: 'createBib', idempotent: true }),
    );
    const op = (doc.paths as Record<string, Record<string, { parameters?: unknown[] }>>)['/v1/bibs']
      ?.post;
    expect(op?.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    );
  });

  it('turns a path parameter into a declared parameter', () => {
    const doc = buildOpenApiDocument(
      withOverride({ path: '/v1/bibs/{bibId}', operationId: 'getBib' }),
    );
    const op = (doc.paths as Record<string, Record<string, { parameters?: { name: string }[] }>>)[
      '/v1/bibs/{bibId}'
    ]?.get;
    expect(op?.parameters?.map((p) => p.name)).toContain('bibId');
  });

  it('derives the request body schema from the DTO itself', () => {
    const doc = buildOpenApiDocument(
      withOverride({
        method: 'post',
        operationId: 'createAuthor',
        idempotent: true,
        body: { dto: ExampleAuthorDto },
      }),
    );
    const schema = (
      doc.paths as Record<
        string,
        Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>
      >
    )['/v1/bibs']?.post?.requestBody?.content['application/json']?.schema;
    expect(schema).toEqual(deriveJsonSchema(ExampleAuthorDto));
  });
});

describe('deriveJsonSchema', () => {
  const schema = deriveJsonSchema(ExampleRecordDto, { nested: { authors: ExampleAuthorDto } });

  it('marks exactly the non-@IsOptional properties required', () => {
    expect(schema.required).toEqual([
      'acquiredAt',
      'authors',
      'circulates',
      'contactEmail',
      'draft',
      'publicationYear',
      'schema',
      'subjects',
      'title',
    ]);
    expect(schema.properties?.subtitle).toBeDefined();
  });

  it('keeps a falsy @Equals value — the const is the type', () => {
    // A truthiness test here used to make the whole DTO throw.
    expect(schema.properties?.draft).toEqual({ const: false });
  });

  it('folds every constraint on one property together', () => {
    expect(schema.properties?.title).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 500,
      pattern: '^[^\\n]+$',
    });
    expect(schema.properties?.publicationYear).toEqual({
      type: 'integer',
      minimum: 1450,
      maximum: 2200,
    });
  });

  it('puts an { each: true } constraint on the ITEMS, not the array', () => {
    expect(schema.properties?.subjects).toEqual({
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string' },
    });
  });

  it('inlines a nested DTO, with its own required list', () => {
    expect(schema.properties?.authors?.items?.required).toEqual(['name']);
    expect(schema.properties?.authors?.items?.additionalProperties).toBe(false);
  });

  it('says additionalProperties: false, because validateDto forbids them', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    [
      '@ValidateNested with no class supplied',
      () => deriveJsonSchema(ExampleRecordDto),
      /no class was given/,
    ],
    [
      '@ValidateIf without @IsOptional',
      () => deriveJsonSchema(RefusedConditionalDto),
      /ValidateIf/,
    ],
    [
      'a validator with no mapping',
      () => deriveJsonSchema(RefusedCustomValidatorDto),
      /maxPasswordBytes/,
    ],
  ])('refuses %s rather than guessing', (_label, run, expected) => {
    expect(run).toThrow(expected);
  });

  it('accepts an unmapped validator once it is declared at the endpoint', () => {
    const declared = deriveJsonSchema(RefusedCustomValidatorDto, {
      customValidators: { maxPasswordBytes: { type: 'string', maxLength: 72 } },
    });
    expect(declared.properties?.password).toEqual({ type: 'string', maxLength: 72 });
  });

  it('refuses a class with no validation metadata at all', () => {
    class Bare {}
    expect(() => deriveJsonSchema(Bare)).toThrow(/no class-validator metadata/);
  });
});
