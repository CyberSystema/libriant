/**
 * What the HTTP access log is allowed to say about a request (reliability-03).
 *
 * pino-http serialises the response with pino-std-serializers, whose `res`
 * serializer returns `{statusCode, headers}` — the whole header bag. The redact
 * list only covered `req.headers.*`, so every `Set-Cookie` went to stdout
 * verbatim: login, signup, admin login, impersonation redemption and every
 * sliding-session refresh. stdout is Docker's json-file log (50 MB x 5 per
 * container), which made it a rolling store of live session JWTs — remember-me
 * TTL is 30 days. The audit lifted a token straight out of the API's own log
 * file and replayed it into `/auth/me` for a 200. Host shell, a log shipper, a
 * backup or a support bundle was enough to take over any account that signed in
 * during the retention window, with no credential and no MFA.
 *
 * The first fix described itself as an allowlist while only the RESPONSE side
 * was one. The request side stayed a two-entry denylist (`authorization`,
 * `cookie`), so `x-api-key`, `x-amz-security-token`, `proxy-authorization`,
 * `x-csrf-token` and anything a future integration invents still reached stdout
 * in full. A denylist of credential headers cannot be completed — there is no
 * list of every header a client might put a secret in — so both directions are
 * allowlists now:
 *
 *   1. `serializeRes` emits no response headers at all.
 *   2. `logRedactCensor` censors EVERY request header except the small set
 *      named below, which are the ones an access log is actually read for.
 *   3. The request URL keeps its path and its query-parameter NAMES, and loses
 *      every query VALUE — `/_files/signed?token=<jwt>` is a bearer credential
 *      in a URL, and it is logged on every image the UI renders.
 *
 * Wiring lives in app.module.ts (`LoggerModule.forRoot`), and
 * test/integration/log-wiring.spec.ts asserts these exports are the ones it
 * passes — the unit spec alone could not tell you the app still used them.
 */

/** Replacement text written in place of a redacted value. */
export const LOG_REDACT_TEXT = '[redacted]';

/**
 * Request headers the access log may keep in full.
 *
 * Chosen because none of them can carry a credential and all of them are load
 * bearing when reading a log: routing (`host`), client identification
 * (`user-agent`), body framing (`content-type`, `content-length`), negotiation
 * (`accept`, `accept-language`), request correlation, and the forwarded client
 * IP the auth rate limits are keyed on (authn-authz-01) — without which an
 * abuse investigation has nothing to group by.
 *
 * `referer` is deliberately NOT here: it is a URL, and a page reached from a
 * signed download link puts that token in it. It is handled as a URL below
 * instead of being dropped, because the referring page is genuinely useful.
 */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'origin',
  'x-request-id',
  'x-correlation-id',
  'x-real-ip',
  'x-forwarded-for',
  'cf-connecting-ip',
  'cf-ray',
]);

/** Headers whose value is a URL, so it is scrubbed rather than censored. */
const URL_VALUED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['referer', 'referrer']);

/**
 * Query parameters whose VALUES are safe in a log line.
 *
 * Deliberately tiny, and deliberately an allowlist rather than a denylist of
 * the secret-bearing names. A denylist has to be updated the day someone adds a
 * new parameter carrying something private, and the failure is silent — which
 * is how `?token=` reached stdout on every signed-download request in the first
 * place. Here the default is silence, and a parameter has to be argued into
 * this set before its value can be printed.
 *
 * `q` is NOT here on purpose: a catalogue search is usually a book title, and
 * sometimes a patron's name.
 */
const ALLOWED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'limit',
  'page',
  'after',
  'before',
  'status',
  'format',
  'scope',
  'locale',
]);

/**
 * Keep a URL's shape, drop its secrets.
 *
 * The path stays (that is the whole point of an access log) and the query
 * parameter NAMES stay — knowing that `token` was present is diagnostic, and a
 * parameter name is not itself a secret. Every VALUE goes, because there is no
 * way to know which of them is a credential: `/_files/signed?token=<jwt>` is a
 * signed bearer URL that the browser requests for every cover image on the
 * page, and reliability-03 is precisely about credentials living in the log.
 *
 * Exported because http-exception.filter.ts logs the URL of every 5xx and must
 * scrub it the same way; two implementations would drift, and the one that
 * drifted would be the one nobody was looking at.
 */
export function scrubUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  const query = url.slice(q + 1);
  if (query === '') return `${path}?`;
  const scrubbed = query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const eq = pair.indexOf('=');
      // A bare flag (`?debug`) has no value to leak; keep it as-is.
      return eq === -1 ? pair : `${pair.slice(0, eq)}=${LOG_REDACT_TEXT}`;
    })
    .join('&');
  return `${path}?${scrubbed}`;
}

/**
 * fast-redact paths, applied to the *serialised* log object — i.e. after the
 * req/res serializers have run, which is why these are `req.headers.*` and not
 * `request.raw.headers.*`.
 *
 * `req.headers[*]` is a wildcard so that the censor below sees EVERY request
 * header and can apply an allowlist; naming individual headers here is what
 * made the request side a denylist. `res.headers[...]` is kept even though
 * `serializeRes` drops the header bag: if anyone ever restores response headers
 * to the log, Set-Cookie must still be censored.
 */
// Mutable `string[]` on purpose: pino's `redact.paths` is typed as `string[]`,
// and a `readonly` tuple here would fail to typecheck at the call site in
// app.module.ts — a file this module is not allowed to change.
export const logRedactPaths: string[] = [
  'req.headers[*]',
  'req.url',
  // `req.query` is serialized by pino-http as its OWN field, separate from
  // `req.url`. Scrubbing the url alone therefore closed half the hole: every
  // cover image the UI renders goes through `/_files/signed?token=<jwt>`, and
  // the token came straight back out in `req.query.token` on every one of those
  // requests. The value is replaced, the KEY survives — an operator still sees
  // that a token was present, exactly as the Caddy access log now behaves.
  'req.query[*]',
  'res.headers["set-cookie"]',
];

/**
 * pino's `censor`, as a FUNCTION rather than a constant string.
 *
 * That is what makes the allowlist expressible at all: fast-redact has no way
 * to say "every header except these", but it does hand the censor the full path
 * of each matched value, so the decision can be made per header here.
 *
 * Anything unrecognised is censored. New header, new query parameter, new
 * integration — the default is silence, and a header has to be added to
 * ALLOWED_REQUEST_HEADERS on purpose before it can reach stdout.
 */
export const logRedactCensor = (value: unknown, path: readonly string[]): unknown => {
  const key = String(path[path.length - 1] ?? '').toLowerCase();
  if (path[0] === 'req' && path[1] === 'url') return scrubUrl(value);
  if (path[0] === 'req' && path[1] === 'headers') {
    if (ALLOWED_REQUEST_HEADERS.has(key)) return value;
    if (URL_VALUED_REQUEST_HEADERS.has(key)) return scrubUrl(value);
  }
  if (path[0] === 'req' && path[1] === 'query') {
    if (ALLOWED_QUERY_PARAMS.has(key)) return value;
  }
  return LOG_REDACT_TEXT;
};

/**
 * The value app.module.ts passes as pino's `censor`.
 *
 * Kept under the original export NAME even though it is no longer a string:
 * the wiring in app.module.ts is `censor: LOG_REDACT_CENSOR`, so upgrading the
 * censor here upgrades the running application without that file changing. If
 * you need the replacement text (in a test assertion, say), use
 * `LOG_REDACT_TEXT`.
 */
export const LOG_REDACT_CENSOR = logRedactCensor;

/** The shape our serializer is handed — see `serializeRes`. */
type StdSerializedRes = {
  statusCode?: number | null;
  headers?: unknown;
};

export type LoggedRes = {
  statusCode: number | null;
  contentLength?: string | number;
};

/**
 * Response serializer for pino-http.
 *
 * NOTE the argument: pino-http wraps a custom `res` serializer in
 * `wrapResponseSerializer`, so this is called with the object
 * pino-std-serializers already produced (`{statusCode, headers, raw}`), NOT
 * with the raw `ServerResponse`. We keep the status and the body size — the two
 * fields anyone actually greps an access log for — and drop everything else.
 */
export function serializeRes(res: StdSerializedRes | null | undefined): LoggedRes {
  // `headers` is `''` on the serializer's prototype and a plain object once a
  // real response is serialised; a manual `logger.log({ res: ... })` can make
  // it anything. A serializer must never throw, so narrow before indexing.
  const headers =
    res && typeof res.headers === 'object' && res.headers !== null
      ? (res.headers as Record<string, unknown>)
      : undefined;
  const contentLength = headers?.['content-length'];
  return {
    statusCode: res?.statusCode ?? null,
    ...(typeof contentLength === 'string' || typeof contentLength === 'number'
      ? { contentLength }
      : {}),
  };
}
