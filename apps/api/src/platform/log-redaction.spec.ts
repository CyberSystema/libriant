import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { stdSerializers } from 'pino-http';
import {
  LOG_REDACT_CENSOR,
  LOG_REDACT_TEXT,
  logRedactPaths,
  scrubUrl,
  serializeRes,
} from './log-redaction.js';

/**
 * reliability-03. The bug was not "a path was missing from the redact list" —
 * it was that the response serializer emitted the whole header bag, so a live
 * session JWT reached stdout. These tests drive the REAL pino config through
 * pino-http's own serializer wrapping and assert on the emitted line, which is
 * the only thing an attacker with log access ever sees.
 *
 * What these tests CANNOT tell you is whether app.module.ts still passes this
 * config to LoggerModule.forRoot — building a pino instance from the exports
 * proves the exports work, not that the application uses them. Deleting the
 * serializer from app.module.ts used to break nothing in CI. That half is
 * pinned by test/integration/log-wiring.spec.ts, which reads the params out of
 * the real module metadata.
 */

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.LIVE-SESSION-JWT.sig';

/** A ServerResponse-alike, the way pino-http hands one to the serializer. */
function fakeRes() {
  return {
    headersSent: true,
    statusCode: 200,
    getHeaders: () => ({
      'content-type': 'application/json',
      'content-length': '42',
      'set-cookie': [`libriant_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`],
    }),
  };
}

function fakeReq(over: { url?: string; headers?: Record<string, unknown> } = {}) {
  return {
    id: 1,
    method: 'POST',
    url: over.url ?? '/auth/login',
    headers: {
      host: 'demo.libriant.com',
      cookie: `libriant_session=${TOKEN}`,
      authorization: `Bearer ${TOKEN}`,
      ...over.headers,
    },
    socket: { remoteAddress: '203.0.113.7', remotePort: 44321 },
  };
}

/** Log one request/response pair through the app's pino options. */
function logOneRequest(
  serializers: NonNullable<pino.LoggerOptions['serializers']>,
  req: unknown = fakeReq(),
): string {
  const lines: string[] = [];
  const logger = pino(
    {
      redact: { paths: logRedactPaths, censor: LOG_REDACT_CENSOR },
      serializers,
    },
    { write: (msg: string) => void lines.push(msg) },
  );
  logger.info({ req, res: fakeRes() }, 'request completed');
  return lines.join('');
}

/** The serializer pair pino-http actually installs, wrapped the same way. */
const appSerializers = {
  req: stdSerializers.req,
  // pino-http registers a custom `res` serializer through
  // `wrapResponseSerializer` (pino-http/logger.js), so it is handed the
  // std-serialised object rather than the raw ServerResponse. Wrap it the same
  // way here — assuming the wrong argument shape is exactly how this leaks
  // again.
  res: pino.stdSerializers.wrapResponseSerializer(serializeRes as never),
};

describe('log redaction (reliability-03)', () => {
  it('never emits a session cookie in the access log', () => {
    const line = logOneRequest(appSerializers);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('libriant_session');
    // ...and the line is still useful.
    expect(JSON.parse(line).res).toEqual({ statusCode: 200, contentLength: '42' });
    expect(JSON.parse(line).req.headers.cookie).toBe(LOG_REDACT_TEXT);
    expect(JSON.parse(line).req.headers.authorization).toBe(LOG_REDACT_TEXT);
    expect(JSON.parse(line).req.headers.host).toBe('demo.libriant.com');
  });

  it('still censors Set-Cookie if the header bag is ever logged again', () => {
    // Layer 1 on its own: the stock serializer emits `res.headers`, and the
    // redact paths must catch it. This is the config the API shipped with,
    // minus the missing path.
    const line = logOneRequest({ req: stdSerializers.req, res: stdSerializers.res });
    expect(line).toContain(`"set-cookie":"${LOG_REDACT_TEXT}"`);
    expect(line).not.toContain(TOKEN);
  });

  it('proves the old config leaked — the stock serializer hands over Set-Cookie', () => {
    const serialised = stdSerializers.res(fakeRes() as never) as unknown as {
      headers: Record<string, unknown>;
    };
    expect(JSON.stringify(serialised.headers['set-cookie'])).toContain(TOKEN);
  });

  it('drops every response header, not just the ones we thought of', () => {
    expect(serializeRes(stdSerializers.res(fakeRes() as never) as never)).not.toHaveProperty(
      'headers',
    );
  });

  it('survives a res object that is not a real response', () => {
    expect(serializeRes(undefined)).toEqual({ statusCode: null });
    expect(serializeRes({ statusCode: 204, headers: '' })).toEqual({ statusCode: 204 });
    expect(serializeRes({} as never)).toEqual({ statusCode: null });
  });
});

describe('request headers are an allowlist, not a denylist', () => {
  // The first fix's own doc comment claimed an allowlist design while the
  // request side named exactly two headers. Every credential-bearing header
  // nobody happened to think of still went to stdout in full.
  it.each([
    ['x-api-key', 'sk_live_deadbeefdeadbeef'],
    ['proxy-authorization', `Basic ${TOKEN}`],
    ['x-amz-security-token', TOKEN],
    ['x-csrf-token', 'csrf-abc123'],
    ['x-forwarded-authorization', `Bearer ${TOKEN}`],
    ['some-header-invented-next-year', 'a-secret-nobody-listed'],
  ])('censors %s without it ever being named', (header, value) => {
    const line = logOneRequest(appSerializers, fakeReq({ headers: { [header]: value } }));
    expect(line).not.toContain(value);
    expect(JSON.parse(line).req.headers[header]).toBe(LOG_REDACT_TEXT);
  });

  it('keeps the handful of headers a log is actually read for', () => {
    const line = logOneRequest(
      appSerializers,
      fakeReq({
        headers: {
          'user-agent': 'Mozilla/5.0 (probe)',
          'content-type': 'application/json',
          'x-real-ip': '198.51.100.9',
        },
      }),
    );
    const { headers } = JSON.parse(line).req;
    expect(headers.host).toBe('demo.libriant.com');
    expect(headers['user-agent']).toBe('Mozilla/5.0 (probe)');
    expect(headers['content-type']).toBe('application/json');
    // Kept on purpose: every auth rate limit is keyed on this value
    // (authn-authz-01), so abuse investigation has nothing to group by without
    // it — and it is not a credential.
    expect(headers['x-real-ip']).toBe('198.51.100.9');
  });

  it('scrubs a Referer that carries a signed-download token', () => {
    const line = logOneRequest(
      appSerializers,
      fakeReq({ headers: { referer: `https://demo.libriant.com/_files/signed?token=${TOKEN}` } }),
    );
    expect(line).not.toContain(TOKEN);
    expect(JSON.parse(line).req.headers.referer).toBe(
      `https://demo.libriant.com/_files/signed?token=${LOG_REDACT_TEXT}`,
    );
  });
});

describe('scrubUrl (query values are credentials)', () => {
  it('keeps the path and the parameter names, drops the values', () => {
    expect(scrubUrl(`/_files/signed?token=${TOKEN}`)).toBe(
      `/_files/signed?token=${LOG_REDACT_TEXT}`,
    );
    expect(scrubUrl('/t/demo/books?q=dune&page=2')).toBe(
      `/t/demo/books?q=${LOG_REDACT_TEXT}&page=${LOG_REDACT_TEXT}`,
    );
  });

  it('leaves a URL with no query alone', () => {
    expect(scrubUrl('/auth/login')).toBe('/auth/login');
  });

  it('handles the awkward shapes without throwing', () => {
    expect(scrubUrl('/x?')).toBe('/x?');
    expect(scrubUrl('/x?flag')).toBe('/x?flag');
    expect(scrubUrl('/x?a=1&&b=2')).toBe(`/x?a=${LOG_REDACT_TEXT}&&b=${LOG_REDACT_TEXT}`);
    expect(scrubUrl(undefined)).toBe('');
    expect(scrubUrl(42)).toBe('');
  });

  it('scrubs the access log line for a signed download', () => {
    const line = logOneRequest(appSerializers, fakeReq({ url: `/_files/signed?token=${TOKEN}` }));
    expect(line).not.toContain(TOKEN);
    expect(JSON.parse(line).req.url).toBe(`/_files/signed?token=${LOG_REDACT_TEXT}`);
  });
});
