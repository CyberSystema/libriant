import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, NTFY_TOPIC_MIN_LEN } from '../config/env.js';
import {
  NOTIFY_LEVELS,
  NOTIFY_REDACTIONS,
  NotifyService,
  redactForNotification,
  type NotifyLevel,
} from './notify.service.js';

/**
 * Two things are under test here and they are not the same thing.
 *
 * The first is BEHAVIOUR: that a send is bounded, that its failure cannot
 * reach the caller, that a topic never appears in a URL, and that the
 * redaction pass survives hostile input.
 *
 * The second is AGREEMENT. There are two implementations of one contract —
 * this service, and scripts/_lib/notify.sh — because the callers live in
 * different worlds: the host scripts run outside Docker and the API runs
 * inside a container that does not ship scripts/. Nothing at runtime can make
 * them read one file, so the drift is caught here instead, by parsing the
 * shell library off disk. If somebody adds a level, moves a priority or
 * changes a length cap in one of the two, this suite goes red rather than the
 * operator's phone quietly going quiet.
 */
const SHELL_LIB = readFileSync(
  new URL('../../../../scripts/_lib/notify.sh', import.meta.url),
  'utf8',
);

/** A topic that is obviously a fixture and still clears the length floor. */
const TEST_TOPIC = 'FIXTURE_not_a_real_topic_0000000';

const SAVED = { ...process.env };

/**
 * A minimal environment: NODE_ENV deleted so loadEnv() takes its development
 * quickstart path and this suite does not have to carry a full production
 * secret set to ask a question about notifications.
 */
function envWith(overrides: Record<string, string | undefined> = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) process.env[k] = v;
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, SAVED);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the priority table is ONE table', () => {
  it('has the same levels, priorities and tags as scripts/_lib/notify.sh', () => {
    const block = /_NTFY_LEVELS='([^']*)'/.exec(SHELL_LIB)?.[1];
    expect(block, '_NTFY_LEVELS not found in scripts/_lib/notify.sh').toBeTypeOf('string');

    const fromShell = Object.fromEntries(
      String(block)
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((line) => {
          const [name, priority, tag] = line.split(':');
          return [name, { priority: Number(priority), tag }];
        }),
    );

    expect(fromShell).toEqual(
      Object.fromEntries(
        Object.entries(NOTIFY_LEVELS).map(([k, v]) => [k, { priority: v.priority, tag: v.tag }]),
      ),
    );
  });

  it('reserves ntfy priority 5 for `error` alone — it is the one that can override do-not-disturb', () => {
    const atFive = Object.entries(NOTIFY_LEVELS).filter(([, v]) => v.priority === 5);
    expect(atFive.map(([k]) => k)).toEqual(['error']);
  });

  it('agrees with the shell library on the topic floor and the length caps', () => {
    const shellNum = (name: string): number => {
      const m = new RegExp(`^${name}=(\\d+)`, 'm').exec(SHELL_LIB);
      expect(m, `${name} not found in scripts/_lib/notify.sh`).not.toBeNull();
      return Number(m![1]);
    };
    expect(shellNum('_NOTIFY_TOPIC_MIN_LEN')).toBe(NTFY_TOPIC_MIN_LEN);
    // Mirrors MAX_TITLE / MAX_BODY, which are module-private on purpose; the
    // observable form is what a long title actually gets clipped to.
    expect(shellNum('_NOTIFY_MAX_TITLE')).toBe(100);
    expect(shellNum('_NOTIFY_MAX_BODY')).toBe(900);
  });

  it('falls back to the same level in both implementations when a caller typos one', async () => {
    expect(/^_NTFY_FALLBACK_LEVEL=(\w+)/m.exec(SHELL_LIB)?.[1]).toBe('warn');
    // …and the TypeScript side's private FALLBACK_LEVEL, observed rather than
    // imported: an unknown level is neither demoted into the history nor
    // promoted to the priority that can override do-not-disturb.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    envWith({ NTFY_TOPIC: TEST_TOPIC });
    await new NotifyService().send({ level: 'nonsense' as NotifyLevel, title: 't', body: 'b' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.priority).toBe(NOTIFY_LEVELS.warn.priority);
    expect(payload.tags).toEqual([NOTIFY_LEVELS.warn.tag]);
  });

  it('keeps both implementations on a single-digit-second timeout', () => {
    const shellTimeout = /_NOTIFY_TIMEOUT_SEC="\$\{NTFY_TIMEOUT_SEC:-(\d)\}"/.exec(SHELL_LIB);
    expect(shellTimeout, 'the shell timeout is no longer a single digit').not.toBeNull();
  });
});

describe('redactForNotification — hostile input', () => {
  const cases: Array<[string, string, string]> = [
    [
      'an applicant e-mail address',
      'application from maria.papadopoulou@dimos-kalamatas.gr',
      NOTIFY_REDACTIONS.email,
    ],
    [
      'a Postgres connection string',
      'CONTROL_DATABASE_URL=postgresql://libriant:hunter2@db.internal:5432/libriant_control',
      NOTIFY_REDACTIONS.credential,
    ],
    [
      'a Redis URL with no username, which is the form Redis actually uses',
      'redis://:s3cr3t@redis:6379',
      NOTIFY_REDACTIONS.credential,
    ],
    [
      'a 64-hex secret straight out of .env.prod',
      'SESSION_SECRET=8f3a9c1d2e4b5a6f7089abcdef0123456789abcdef0123456789abcdef012345',
      NOTIFY_REDACTIONS.credential,
    ],
    [
      'a session JWT of the kind the audit lifted out of a log',
      'cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOE',
      NOTIFY_REDACTIONS.token,
    ],
    ['an ntfy access token', 'NTFY_TOKEN=tk_notarealtokenvalue0000', NOTIFY_REDACTIONS.credential],
    ['a Stripe live key', 'charged with sk_live_51ABCdefGHIjklMNOpqrs', NOTIFY_REDACTIONS.token],
    ['a Stripe webhook secret', 'verify whsec_abc123def456ghi', NOTIFY_REDACTIONS.token],
    ['a GitHub token', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', NOTIFY_REDACTIONS.token],
    ['a bare password assignment', 'PASSWORD: correct-horse-battery', NOTIFY_REDACTIONS.credential],
    ['a client IPv4 address', 'client 192.168.13.240 hammered the form', NOTIFY_REDACTIONS.ip],
    [
      'a client IPv6 address',
      'client 2001:0db8:85a3:0000:0000:8a2e:0370:7334 hammered the form',
      NOTIFY_REDACTIONS.ip,
    ],
    ['an international phone number', 'reachable on +30 210 1234567', NOTIFY_REDACTIONS.phone],
  ];

  it.each(cases)('strips %s', (_name, input, marker) => {
    const out = redactForNotification(input);
    expect(out).toContain(marker);
  });

  it.each(cases)('leaves no fragment of the secret behind in %s', (_name, input) => {
    const out = redactForNotification(input);
    for (const secret of [
      'maria.papadopoulou',
      'dimos-kalamatas.gr',
      'hunter2',
      's3cr3t',
      '8f3a9c1d2e4b5a6f7089abcdef0123456789abcdef0123456789abcdef012345',
      'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOE',
      'tk_notarealtokenvalue0000',
      'sk_live_51ABCdefGHIjklMNOpqrs',
      'whsec_abc123def456ghi',
      'correct-horse-battery',
      '192.168.13.240',
      '210 1234567',
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it('keeps the half of the message that is the whole point — where to look', () => {
    const out = redactForNotification(
      'Open https://admin.libriant.com/en/admin/applications to answer it.',
    );
    expect(out).toBe('Open https://admin.libriant.com/en/admin/applications to answer it.');
  });

  it('leaves ordinary operational text and Greek institution names alone', () => {
    const line = 'Δημοτική Βιβλιοθήκη Καλαμάτας (Καλαμάτα) — backup 4.2 GB in 91s, v1.4.2';
    expect(redactForNotification(line)).toBe(line);
  });

  it('does not mistake a timestamp for an IPv6 address', () => {
    expect(redactForNotification('finished at 2026-08-28T14:30:45Z')).toContain('14:30:45');
  });

  it('flattens control characters, which would be invalid raw inside a JSON string', () => {
    const out = redactForNotification('a b\tc\rdef\ng');
    expect(out).toBe('a b c d e f\ng');
  });
});

describe('NotifyService — off by default', () => {
  it('sends nothing, throws nothing and logs nothing when no topic is configured', async () => {
    envWith({});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const svc = new NotifyService();
    expect(svc.enabled).toBe(false);
    await expect(svc.send({ level: 'error', title: 't', body: 'b' })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    // …and nothing to say about it: an unconfigured host is not a
    // misconfigured one, so loadEnv reports no problem for NotifyService to log.
    expect(loadEnv().ntfyConfigProblem).toBeNull();
  });

  it('never fails boot on a malformed topic — it disables itself and says why, value-free', () => {
    envWith({ NTFY_TOPIC: 'has spaces and slashes/../etc' });
    const env = loadEnv();
    expect(env.ntfyTopic).toBeNull();
    expect(env.ntfyConfigProblem).toMatch(/characters ntfy does not accept/);
    expect(env.ntfyConfigProblem).not.toContain('has spaces');
  });

  it('refuses a short, guessable topic — on ntfy.sh that is a public feed', () => {
    envWith({ NTFY_TOPIC: 'libriant' });
    const env = loadEnv();
    expect(env.ntfyTopic).toBeNull();
    expect(env.ntfyConfigProblem).toMatch(/shorter than 24 characters/);
    expect(env.ntfyConfigProblem).not.toContain('libriant-prod');
  });

  it('says so when a token is set but a topic is not — that is an operator who tried', () => {
    envWith({ NTFY_TOKEN: 'tk_notarealtokenvalue0000' });
    const env = loadEnv();
    expect(env.ntfyConfigProblem).toMatch(/NTFY_TOKEN is set but NTFY_TOPIC is empty/);
    expect(env.ntfyConfigProblem).not.toContain('tk_');
  });

  it('drops a token that could inject a header rather than sending it', () => {
    envWith({ NTFY_TOPIC: TEST_TOPIC, NTFY_TOKEN: 'tk_bad\nX-Injected: 1' });
    const env = loadEnv();
    expect(env.ntfyTopic).toBe(TEST_TOPIC);
    expect(env.ntfyToken).toBeNull();
    expect(env.ntfyConfigProblem).toMatch(/cannot contain/);
  });

  it('falls back to info when NTFY_MIN_LEVEL is a typo, and reports it', () => {
    envWith({ NTFY_TOPIC: TEST_TOPIC, NTFY_MIN_LEVEL: 'warning' });
    const env = loadEnv();
    expect(env.ntfyMinLevel).toBe('info');
    expect(env.ntfyConfigProblem).toMatch(/NTFY_MIN_LEVEL must be one of/);
  });
});

describe('NotifyService — sending', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
      string,
      RequestInit,
    ];
    return { url, init, payload: JSON.parse(String(init.body)) };
  };

  beforeEach(() => {
    envWith({ NTFY_TOPIC: TEST_TOPIC, NTFY_SERVER: 'https://ntfy.example/' });
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('publishes to the server ROOT with the topic in the body, never in the URL', async () => {
    await new NotifyService().send({ level: 'warn', title: 'x', body: 'y' });
    const { url, payload } = lastCall();
    // The topic is a credential on ntfy.sh. A URL reaches proxy access logs
    // and error messages; a JSON body does not.
    expect(url).toBe('https://ntfy.example/');
    expect(url).not.toContain(TEST_TOPIC);
    expect(payload.topic).toBe(TEST_TOPIC);
  });

  it('sends the level as a priority and a tag, with caller tags appended', async () => {
    await new NotifyService().send({
      level: 'error',
      title: 'Backup FAILED',
      body: 'pg_dumpall exited 1',
      tags: ['floppy_disk'],
    });
    const { payload } = lastCall();
    expect(payload.priority).toBe(5);
    expect(payload.tags).toEqual(['rotating_light', 'floppy_disk']);
  });

  it('sends an unrecognised level as warn — never demoted, never promoted to 5', async () => {
    await new NotifyService().send({
      level: 'warning' as NotifyLevel,
      title: 't',
      body: 'b',
    });
    expect(lastCall().payload.priority).toBe(NOTIFY_LEVELS.warn.priority);
  });

  it('redacts the title and the body on the way out, whatever the caller passed', async () => {
    await new NotifyService().send({
      level: 'warn',
      title: 'application from maria@dimos-kalamatas.gr',
      body: 'CONTROL_DATABASE_URL=postgresql://libriant:hunter2@db:5432/x from 192.168.1.9',
    });
    const { payload } = lastCall();
    expect(payload.title).toBe(`application from ${NOTIFY_REDACTIONS.email}`);
    expect(payload.message).not.toContain('hunter2');
    expect(payload.message).toContain(NOTIFY_REDACTIONS.ip);
  });

  // NOTE the fixture: a long run of one letter is NOT usable here. `'A'.repeat(400)`
  // is 400 valid hex digits, so the 32+-hex rule redacts the whole thing before
  // the clip ever sees it — which is the redaction behaving correctly, and a
  // reminder that these two passes compose in that order.
  it('clips an over-long title to one marked line', async () => {
    await new NotifyService().send({
      level: 'info',
      title: 'a very long title indeed '.repeat(40),
      body: 'b',
    });
    const { payload } = lastCall();
    expect(payload.title).toHaveLength(100);
    expect(payload.title.endsWith('…')).toBe(true);
  });

  it('collapses a newline in the title, which the operator sees on one lock-screen line', async () => {
    await new NotifyService().send({ level: 'info', title: 'one\ntwo', body: 'b' });
    expect(lastCall().payload.title).toBe('one two');
  });

  it('bounds the request with a timeout signal rather than trusting the server', async () => {
    await new NotifyService().send({ level: 'info', title: 't', body: 'b' });
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the token as a bearer header, and only when one is configured', async () => {
    await new NotifyService().send({ level: 'info', title: 't', body: 'b' });
    expect(lastCall().init.headers).not.toHaveProperty('Authorization');

    envWith({ NTFY_TOPIC: TEST_TOPIC, NTFY_TOKEN: 'tk_notarealtokenvalue0000' });
    await new NotifyService().send({ level: 'info', title: 't', body: 'b' });
    expect(lastCall().init.headers).toMatchObject({
      Authorization: 'Bearer tk_notarealtokenvalue0000',
    });
  });
});

describe('NotifyService — a send can never break the thing it reports on', () => {
  beforeEach(() => {
    envWith({ NTFY_TOPIC: TEST_TOPIC });
  });

  it.each([
    ['a 500 from the server', async () => new Response('boom', { status: 500 })],
    ['a 429 rate limit', async () => new Response('slow down', { status: 429 })],
    ['a 401 on a protected topic', async () => new Response('nope', { status: 401 })],
    [
      'a connection refused',
      async () => {
        throw new Error('fetch failed');
      },
    ],
    [
      'our own timeout firing',
      async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        });
      },
    ],
  ])('resolves rather than rejecting on %s', async (_name, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    const svc = new NotifyService();
    await expect(svc.send({ level: 'error', title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('swallows a rejection from the detached form too, so nothing goes unhandled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const svc = new NotifyService();
    expect(() => svc.sendDetached({ level: 'error', title: 't', body: 'b' })).not.toThrow();
    // Let the dropped promise settle; an unhandled rejection would fail the run.
    await new Promise((r) => setImmediate(r));
  });
});

describe('NotifyService — the floor and the ceiling', () => {
  it('publishes nothing below NTFY_MIN_LEVEL', async () => {
    envWith({ NTFY_TOPIC: TEST_TOPIC, NTFY_MIN_LEVEL: 'warn' });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new NotifyService();

    await svc.send({ level: 'debug', title: 'no', body: 'b' });
    await svc.send({ level: 'info', title: 'no', body: 'b' });
    expect(fetchMock).not.toHaveBeenCalled();

    await svc.send({ level: 'warn', title: 'yes', body: 'b' });
    await svc.send({ level: 'error', title: 'yes', body: 'b' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops a notify-in-a-loop from burning the daily budget and training the operator to mute', async () => {
    envWith({ NTFY_TOPIC: TEST_TOPIC });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new NotifyService();

    for (let i = 0; i < 100; i++) {
      await svc.send({ level: 'error', title: `loop ${i}`, body: 'b' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});
