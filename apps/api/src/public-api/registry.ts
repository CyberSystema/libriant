import { PERMISSION_KEYS } from '@libriant/shared/permissions';
import {
  deriveJsonSchema,
  type DeriveOptions,
  type DtoClass,
  type JsonSchema,
} from './json-schema.js';

/**
 * The public REST API's single declaration site.
 *
 * ## The problem this exists to make impossible
 *
 * A stale API document is the defining flaw of every incumbent ILS. Koha's,
 * Alma's and Sierra's published specs all describe endpoints that answer
 * differently from the prose, because the spec is a separate artefact somebody
 * updates. The fix is not a review checklist. It is that there IS no separate
 * artefact: `defineEndpoint()` is simultaneously the route's validation wiring
 * and the OpenAPI source, the document is generated from it, the generated
 * document is committed, and `check:openapi` fails the build when the two
 * diverge (contract 4.9).
 *
 * ## Why not @nestjs/swagger
 *
 * See the header of `./json-schema.ts`: `tsx`/esbuild emits no
 * `design:paramtypes`, which is the same reason `main.ts` has no global
 * `ValidationPipe` and `validateDto()` exists. A generator that produced full
 * schemas in production and empty ones in development would be worse than none.
 *
 * ## Phase 6 ships this EMPTY
 *
 * There are no public routes yet — they arrive in M6 (phases 52-53). What ships
 * now is the mechanism and the gate, because the gate is worthless if it is
 * added after sixty endpoints already disagree with it. `check:openapi` is kept
 * honest in the meantime by fixture DTOs that exercise the deriver against the
 * real validator; see `scripts/check-openapi.ts`.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type EndpointResponse = {
  /** One sentence, ending in a full stop. Rendered verbatim in the docs. */
  readonly description: string;
  /** Omit for an empty body (204). */
  readonly schema?: JsonSchema;
};

export type EndpointDefinition = {
  /**
   * Stable identifier. It becomes the method name in every generated client, so
   * renaming one is a breaking change to somebody's integration — it is the one
   * field here that may never be edited for style.
   */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI path with `{}` parameters, e.g. `/v1/bibs/{bibId}`. */
  readonly path: string;
  /** One sentence, ending in a full stop. */
  readonly summary: string;
  /** At least one. Groups the operation in the docs and in generated clients. */
  readonly tags: readonly string[];
  /**
   * The permission key the route requires, or `null` for a genuinely public
   * one. Not decorative: OAuth scopes are a projection of permission keys
   * (contract 4.5), so this is where a token's scope list comes from.
   */
  readonly permission: string | null;
  /**
   * Whether the endpoint requires an `Idempotency-Key` header.
   *
   * Mandatory on every write in the public API — a client that retries a
   * checkout because a socket died must not lend the book twice. Stated per
   * endpoint rather than derived from the method so that the rare
   * write-that-is-naturally-idempotent is a decision somebody wrote down.
   */
  readonly idempotent: boolean;
  /** The request body DTO, if any, plus whatever the deriver needs to read it. */
  readonly body?: { readonly dto: DtoClass } & DeriveOptions;
  /** Keyed by status code. Must contain at least one 2xx. */
  readonly responses: Readonly<Record<number, EndpointResponse>>;
};

/**
 * Declare one endpoint.
 *
 * `const D` so the literal types survive: `PUBLIC_ENDPOINTS[number]['operationId']`
 * is a union of the actual ids, which is what lets a later phase type the
 * generated client without a second list. Same device as `defineMetric`
 * (`observability/metrics.registry.ts`).
 */
export function defineEndpoint<const D extends EndpointDefinition>(d: D): D {
  return d;
}

/**
 * Every public endpoint. Empty until M6 — see the header.
 *
 * `satisfies` rather than a type annotation so the entries keep their literal
 * types while still being checked.
 */
export const PUBLIC_ENDPOINTS = [] as const satisfies readonly EndpointDefinition[];

export type OperationId = (typeof PUBLIC_ENDPOINTS)[number] extends never
  ? never
  : (typeof PUBLIC_ENDPOINTS)[number]['operationId'];

const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;
const PATH_PARAM = /\{([^}]*)\}/g;

/**
 * Reject a malformed declaration at MODULE LOAD, not at request time.
 *
 * The same choice `metrics.registry.ts` makes, for the same reason: a registry
 * that validates lazily is a registry whose invariants hold only for the
 * entries someone happened to exercise.
 */
export function validateEndpoints(endpoints: readonly EndpointDefinition[]): void {
  const seenIds = new Set<string>();
  const seenRoutes = new Set<string>();
  for (const e of endpoints) {
    const where = `${e.method.toUpperCase()} ${e.path}`;
    if (!OPERATION_ID.test(e.operationId)) {
      throw new Error(`${where}: operationId "${e.operationId}" must be lowerCamelCase.`);
    }
    if (seenIds.has(e.operationId)) {
      throw new Error(
        `Duplicate operationId "${e.operationId}". It is the method name in every generated ` +
          'client, so it must be unique across the whole API.',
      );
    }
    seenIds.add(e.operationId);

    const route = `${e.method} ${e.path}`;
    if (seenRoutes.has(route)) throw new Error(`Duplicate route ${where}.`);
    seenRoutes.add(route);

    if (!e.path.startsWith('/v1/')) {
      throw new Error(`${where}: every public path is versioned — it must start with "/v1/".`);
    }
    if (e.path.endsWith('/')) throw new Error(`${where}: path must not end in a slash.`);
    for (const m of e.path.matchAll(PATH_PARAM)) {
      if (!OPERATION_ID.test(m[1] ?? '')) {
        throw new Error(`${where}: path parameter "{${m[1]}}" must be lowerCamelCase.`);
      }
    }
    if (!e.summary.trim() || !/[.!?]$/.test(e.summary.trim())) {
      throw new Error(`${where}: summary must be a sentence ending in a full stop.`);
    }
    if (!e.tags.length) throw new Error(`${where}: at least one tag is required.`);
    if (e.permission !== null && !PERMISSION_KEYS.includes(e.permission)) {
      throw new Error(
        `${where}: permission "${e.permission}" is not in the permission model ` +
          '(packages/shared/src/permissions.ts). OAuth scopes project from those keys, so a ' +
          'made-up one would be a scope no token can ever hold.',
      );
    }
    if (e.method !== 'get' && !e.idempotent) {
      throw new Error(
        `${where}: a public write must require an Idempotency-Key. Set idempotent: true, or ` +
          'state in a comment why retrying this call twice is safe.',
      );
    }
    if (e.method === 'get' && e.body) throw new Error(`${where}: a GET must not declare a body.`);
    const codes = Object.keys(e.responses).map(Number);
    if (!codes.some((c) => c >= 200 && c < 300)) {
      throw new Error(`${where}: at least one 2xx response must be declared.`);
    }
    for (const [code, r] of Object.entries(e.responses)) {
      if (!/[.!?]$/.test(r.description.trim())) {
        throw new Error(`${where}: response ${code} description must end in a full stop.`);
      }
    }
  }
}

validateEndpoints(PUBLIC_ENDPOINTS);

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const OPENAPI_VERSION = '3.1.0';
/** The API's contract version — bumped on a breaking change, never on an addition. */
export const API_VERSION = '1.0.0';

type Json = Record<string, unknown>;

/** Recursively sort object keys so the committed document has a stable diff. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const k of Object.keys(value as Json).sort()) out[k] = canonical((value as Json)[k]);
    return out;
  }
  return value;
}

/**
 * Render the registry as an OpenAPI 3.1 document.
 *
 * Deterministic by construction — keys sorted, paths sorted, no timestamps and
 * no host detection. A generator whose output moved between runs would make
 * `check:openapi` fail for reasons nobody could act on, and the gate would be
 * switched off within a month.
 */
export function buildOpenApiDocument(
  endpoints: readonly EndpointDefinition[] = PUBLIC_ENDPOINTS,
): Json {
  validateEndpoints(endpoints);
  const paths: Json = {};
  const tags = new Set<string>();

  for (const e of [...endpoints].sort((a, b) => a.path.localeCompare(b.path))) {
    e.tags.forEach((t) => tags.add(t));
    const operation: Json = {
      operationId: e.operationId,
      summary: e.summary,
      tags: [...e.tags],
      responses: Object.fromEntries(
        Object.entries(e.responses).map(([code, r]) => [
          code,
          r.schema
            ? { description: r.description, content: { 'application/json': { schema: r.schema } } }
            : { description: r.description },
        ]),
      ),
    };

    const parameters: Json[] = [...e.path.matchAll(PATH_PARAM)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (e.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          'A stable key for this action. Replaying it returns the first result instead of ' +
          'acting twice.',
        schema: { type: 'string', minLength: 8, maxLength: 255 },
      });
    }
    if (parameters.length) operation.parameters = parameters;

    if (e.body) {
      const { dto, ...deriveOptions } = e.body;
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: deriveJsonSchema(dto, deriveOptions) } },
      };
    }
    // `permission: null` still means "authenticated": the public API has no
    // anonymous surface. An unauthenticated catalogue lives on the OPAC origin.
    operation.security = [{ bearerAuth: e.permission ? [e.permission] : [] }];

    const existing = (paths[e.path] as Json | undefined) ?? {};
    existing[e.method] = operation;
    paths[e.path] = existing;
  }

  return canonical({
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Libriant API',
      version: API_VERSION,
      description:
        'The public REST API for a Libriant library. Every operation is scoped to one ' +
        'tenant by the credential presented; there is no cross-library endpoint.',
      license: { name: 'Proprietary', identifier: 'LicenseRef-Libriant' },
    },
    servers: [{ url: 'https://app.libriant.com/api', description: 'Libriant cloud.' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'oauth2',
          description:
            'OAuth 2.0 bearer token. Scopes are permission keys — see the permission model.',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://app.libriant.com/api/v1/oauth/token',
              scopes: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, k])),
            },
          },
        },
      },
    },
  }) as Json;
}

/** The document as it is committed to `docs/api/openapi.v1.json`. */
export function renderOpenApiJson(endpoints?: readonly EndpointDefinition[]): string {
  return `${JSON.stringify(buildOpenApiDocument(endpoints), null, 2)}\n`;
}
