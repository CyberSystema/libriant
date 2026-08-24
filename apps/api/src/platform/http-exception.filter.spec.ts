import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpExceptionFilter } from './http-exception.filter.js';

/**
 * The envelope has to draw one distinction correctly: a 500 is a bug we did
 * not anticipate, and a 503 is a refusal we wrote on purpose.
 *
 * Getting it wrong is not cosmetic. Every 503 this API raises names something
 * the reader can act on — which dependency is down, whether anything was
 * charged, that billing is simply not configured on this host. Flattening
 * those into "something went wrong on our end" deletes the answer AND mints a
 * support code for an incident that never happened, which teaches everyone to
 * treat real support codes as noise.
 */
function makeHost(url = '/webhooks/stripe') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json };
  const req = { method: 'POST', originalUrl: url };
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    // The 5xx path logs a full diagnostic record; keep the suite output clean
    // without asserting on it (log-redaction.spec.ts owns what it may contain).
    vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('passes a deliberate 503 through with its own message and no support code', () => {
    const { host, status, json } = makeHost();

    filter.catch(
      new ServiceUnavailableException(
        'Billing is not configured on this server — Stripe webhooks are not accepted.',
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(503);
    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.message).toBe(
      'Billing is not configured on this server — Stripe webhooks are not accepted.',
    );
    expect(body).not.toHaveProperty('supportCode');
  });

  it('preserves a 503 body carrying structured diagnostics (/readyz)', () => {
    const { host, json } = makeHost('/readyz');

    // /readyz throws its dependency report as the exception body. The audit's
    // whole complaint was that an operator could not tell WHICH dependency was
    // down; that answer only survives if the body is passed through intact.
    filter.catch(
      new ServiceUnavailableException({
        status: 'degraded',
        checks: { postgres: 'ok', redis: 'unreachable' },
      }),
      host,
    );

    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.checks).toEqual({ postgres: 'ok', redis: 'unreachable' });
    expect(body).not.toHaveProperty('supportCode');
  });

  it('still re-skins a 500 and withholds its message from the client', () => {
    const { host, status, json } = makeHost();

    filter.catch(new InternalServerErrorException('connection string rejected'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toHaveProperty('supportCode');
    // The message was written for us, not for the user, and may name internals.
    expect(JSON.stringify(body)).not.toContain('connection string rejected');
  });

  it('re-skins a non-HttpException throw as a 500 with a support code', () => {
    const { host, status, json } = makeHost();

    filter.catch(new Error('ECONNREFUSED 127.0.0.1:5432'), host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toHaveProperty('supportCode');
    expect(JSON.stringify(body)).not.toContain('5432');
  });

  it('passes a 4xx through verbatim', () => {
    const { host, status, json } = makeHost();

    filter.catch(new BadRequestException('Missing stripe-signature header.'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect((json.mock.calls[0]![0] as Record<string, unknown>).message).toBe(
      'Missing stripe-signature header.',
    );
  });

  it('does not log a query-string credential when a 503 is refused', () => {
    const { host } = makeHost('/_files/signed?token=eyJhbGciOiJIUzI1NiJ9.SECRET.sig');
    const warn = vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);

    filter.catch(new ServiceUnavailableException('Storage is unavailable.'), host);

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('/_files/signed');
    // scrubUrl keeps the parameter NAMES (an operator needs those) and drops
    // the values — the signed-download token is a live, replayable credential.
    expect(logged).not.toContain('SECRET');
  });
});
