import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock env so the driver constructs with just an API key — loadEnv() otherwise
// validates the whole environment (secrets, DB url, …) which a unit test shouldn't need.
vi.mock('../../config/env.js', () => ({ loadEnv: () => ({ resendApiKey: 're_test_key' }) }));

import { ResendEmailDriver } from './resend-driver.js';

const INPUT = {
  to: 'patron@example.com',
  from: 'Libriant <no-reply@lib.example>',
  replyTo: 'support@lib.example',
  subject: 'Your hold is ready',
  bodyMarkdown: 'Hi there,\n\nPick it up: https://lib.example/holds',
};

function stubFetch(impl: (...args: unknown[]) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ResendEmailDriver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the Resend API with bearer auth + mapped fields and returns the message id', async () => {
    const fetchMock = stubFetch(
      async () => new Response(JSON.stringify({ id: 'msg_abc123' }), { status: 200 }),
    );

    const res = await new ResendEmailDriver().send(INPUT);

    expect(res.providerId).toBe('msg_abc123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      from: INPUT.from,
      to: INPUT.to,
      subject: INPUT.subject,
      text: INPUT.bodyMarkdown,
      reply_to: INPUT.replyTo, // REST API snake_case
    });
    // HTML is rendered via the shared markdown→HTML helper (auto-links the URL).
    expect(body.html).toContain('<a href="https://lib.example/holds">');
  });

  it('omits reply_to when there is none', async () => {
    const fetchMock = stubFetch(
      async () => new Response(JSON.stringify({ id: 'm' }), { status: 200 }),
    );
    await new ResendEmailDriver().send({ ...INPUT, replyTo: null });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect('reply_to' in body).toBe(false);
  });

  it('throws (so the outbox retries) on a non-2xx response, surfacing the status not the key', async () => {
    stubFetch(async () => new Response('The lib.example domain is not verified', { status: 403 }));
    const err = await new ResendEmailDriver()
      .send(INPUT)
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Resend send failed \(403\)/);
    expect((err as Error).message).not.toContain('re_test_key');
  });

  it('wraps a network/timeout error for the retry', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    await expect(new ResendEmailDriver().send(INPUT)).rejects.toThrow(
      /Resend request failed: network down/,
    );
  });
});
