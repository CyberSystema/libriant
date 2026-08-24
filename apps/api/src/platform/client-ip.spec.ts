import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientIp, describeTrustedProxies, isTrustedProxy } from './client-ip.js';

/** `peer` is the TCP peer — the only thing an attacker cannot choose. */
function req(
  headers: Record<string, string | string[]>,
  opts: { peer?: string; reqIp?: string } = {},
): Request {
  return {
    headers,
    ip: opts.reqIp,
    socket: { remoteAddress: opts.peer ?? '172.18.0.4' },
  } as unknown as Request;
}

afterEach(() => {
  delete process.env.TRUSTED_PROXY_CIDRS;
});

describe('clientIp', () => {
  describe('behind a trusted proxy (the Caddy container on the compose network)', () => {
    it('honours X-Real-IP', () => {
      expect(clientIp(req({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    });

    it('takes the LAST entry when X-Real-IP carries a list — ours is the one appended', () => {
      expect(clientIp(req({ 'x-real-ip': '198.51.100.9, 203.0.113.7' }))).toBe('203.0.113.7');
      expect(clientIp(req({ 'x-real-ip': ['198.51.100.9', '203.0.113.7'] }))).toBe('203.0.113.7');
    });

    it('ignores a non-IP X-Real-IP rather than making it a rate-limit bucket', () => {
      expect(clientIp(req({ 'x-real-ip': 'not-an-ip' }, { reqIp: '203.0.113.7' }))).toBe(
        '172.18.0.4',
      );
      expect(clientIp(req({ 'x-real-ip': '' }))).toBe('172.18.0.4');
    });

    it('falls back to the PEER, never to req.ip, when X-Real-IP is absent', () => {
      // req.ip is derived from X-Forwarded-For. `origin_guard` in the Caddyfile
      // sets X-Real-IP on every route Caddy proxies, so a request without one
      // did not come through a guarded route — and on the Docker userland-proxy
      // path the peer is private, so Express walks past it and hands back the
      // client's own X-Forwarded-For entry. The peer is the only proven value.
      expect(clientIp(req({}, { reqIp: '203.0.113.7' }))).toBe('172.18.0.4');
      expect(clientIp(req({}))).toBe('172.18.0.4');
    });

    it('an unguarded route cannot smuggle a bucket in via X-Forwarded-For', () => {
      // The exact shape of the /webhooks/* hole: reachable through Caddy (so the
      // peer is trusted) on a route that did not rewrite the headers.
      const smuggled = req(
        { 'x-forwarded-for': '192.0.2.55, 172.18.0.1' },
        { peer: '172.18.0.4', reqIp: '192.0.2.55' },
      );
      expect(clientIp(smuggled)).toBe('172.18.0.4');
    });

    it('unmaps IPv4-mapped IPv6 so one client is one bucket', () => {
      expect(clientIp(req({ 'x-real-ip': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
      expect(clientIp(req({}, { peer: '::ffff:10.1.2.3' }))).toBe('10.1.2.3');
    });
  });

  describe('from an untrusted peer (someone reaching the origin directly)', () => {
    // authn-authz-01 / input-and-files-02: this is the whole finding. Six wrong
    // logins each carrying a fresh X-Real-IP used to create six separate lockout
    // buckets, so the lockout never fired and every rate limit was a no-op.
    it('ignores X-Real-IP and reports the real peer', () => {
      expect(clientIp(req({ 'x-real-ip': '198.51.100.9' }, { peer: '203.0.113.7' }))).toBe(
        '203.0.113.7',
      );
    });

    it('collapses a rotating X-Real-IP into ONE bucket', () => {
      const buckets = new Set(
        ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'].map((forged) =>
          clientIp(req({ 'x-real-ip': forged }, { peer: '203.0.113.7' })),
        ),
      );
      expect([...buckets]).toEqual(['203.0.113.7']);
    });

    it('ignores X-Forwarded-For / req.ip too — the second spoof vector', () => {
      const spoofed = req(
        { 'x-forwarded-for': '192.0.2.55, 10.0.0.1' },
        { peer: '203.0.113.7', reqIp: '192.0.2.55' },
      );
      expect(clientIp(spoofed)).toBe('203.0.113.7');
    });

    it('reports undefined when there is no peer at all rather than inventing one', () => {
      expect(clientIp({ headers: { 'x-real-ip': '198.51.100.9' } } as unknown as Request)).toBe(
        undefined,
      );
    });
  });

  describe('the IPv6 / Docker userland-proxy path', () => {
    // The bypass that defeated the first fix. An IPv6 client reaches the host,
    // Docker's userland proxy re-originates the connection from the bridge
    // gateway, so Caddy's peer is private and its @cf_peer arm does not match.
    // origin_guard therefore stamps X-Real-IP with the GATEWAY, not with the
    // attacker's CF-Connecting-IP, and everything on that path shares one
    // bucket. This asserts the API's half: whatever the edge stamps, it is the
    // header we key on — so the edge must never be allowed to stamp a value the
    // client chose. See the Caddyfile snippet and prod-bootstrap.sh.
    it('collapses every rotating forgery into the single gateway bucket', () => {
      const buckets = new Set(
        ['198.51.100.1', '198.51.100.2', '198.51.100.3'].map((forged) =>
          clientIp(
            req(
              // What origin_guard leaves on the request for a private peer:
              // X-Real-IP replaced with the peer, CF-Connecting-IP deleted.
              { 'x-real-ip': '172.18.0.1', 'x-forwarded-for': forged },
              { peer: '172.18.0.4' },
            ),
          ),
        ),
      );
      expect([...buckets]).toEqual(['172.18.0.1']);
    });
  });

  describe('TRUSTED_PROXY_CIDRS', () => {
    it('narrows the trust set — a private peer outside the list is no longer believed', () => {
      process.env.TRUSTED_PROXY_CIDRS = '172.18.0.4/32';
      expect(clientIp(req({ 'x-real-ip': '203.0.113.7' }, { peer: '172.18.0.4' }))).toBe(
        '203.0.113.7',
      );
      expect(clientIp(req({ 'x-real-ip': '203.0.113.7' }, { peer: '10.0.0.9' }))).toBe('10.0.0.9');
    });

    it('accepts bare addresses and IPv6 CIDRs', () => {
      process.env.TRUSTED_PROXY_CIDRS = '2001:db8::1, 192.0.2.0/24';
      expect(isTrustedProxy('2001:db8::1')).toBe(true);
      expect(isTrustedProxy('2001:db8::2')).toBe(false);
      expect(isTrustedProxy('192.0.2.77')).toBe(true);
    });

    it('throws on a malformed entry so a typo fails boot, not silently trusts nobody', () => {
      process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8, nonsense';
      expect(() => describeTrustedProxies()).toThrow(/nonsense/);
      process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/64';
      expect(() => describeTrustedProxies()).toThrow(/prefix length/);
    });
  });
});

describe('isTrustedProxy', () => {
  it('trusts loopback and the private ranges by default (our own edge)', () => {
    for (const addr of ['127.0.0.1', '::1', '10.1.2.3', '172.18.0.4', '192.168.1.1', 'fd00::1']) {
      expect(isTrustedProxy(addr)).toBe(true);
    }
  });

  it('never trusts a public address, however it is spelled', () => {
    for (const addr of ['203.0.113.7', '::ffff:203.0.113.7', '2a01:4f8:13b:ac8::2']) {
      expect(isTrustedProxy(addr)).toBe(false);
    }
  });

  it('never trusts a missing or unparseable peer', () => {
    expect(isTrustedProxy(undefined)).toBe(false);
    expect(isTrustedProxy('')).toBe(false);
    expect(isTrustedProxy('localhost')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The edge contract this file depends on.
//
// clientIp() can only ever answer "the peer is our proxy, so believe its
// header". Whether that header is WORTH believing is decided in two files that
// live outside this package, and both have already been wrong in production
// shape at least once:
//
//   • infra/caddy/Caddyfile — the /webhooks/* route reached api:3001 with no
//     origin guard, so the client's own X-Real-IP was forwarded verbatim and
//     this function trusted it, because the peer genuinely was Caddy. The rule
//     ("every route that proxies imports the guard first") was stated in a
//     comment and broken by the very next route somebody added.
//   • infra/compose/docker-compose.prod.yml — `443:443` also binds [::], and
//     with no enable_ipv6 on the network Docker relays v6 through the userland
//     proxy from the bridge gateway. A verifier drove 25 logins with rotating
//     CF-Connecting-IP headers into 25 buckets through that path.
//
// Neither defect is visible from any TypeScript. These tests read the actual
// infra files, so the next omission fails the unit suite instead of an audit.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CADDYFILE = readFileSync(resolve(REPO_ROOT, 'infra/caddy/Caddyfile'), 'utf8');
/**
 * The compose file with its comments removed. These assertions are about what
 * the file DOES, and the comment above `ports:` necessarily quotes the settings
 * it is warning about — matching those would make the prose fail the test.
 */
const COMPOSE_PROD = readFileSync(
  resolve(REPO_ROOT, 'infra/compose/docker-compose.prod.yml'),
  'utf8',
)
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/\s+#.*$/, ''))
  .join('\n');

/**
 * Strip a Caddyfile line down to its directives.
 *
 * Comments run to end of line. Placeholders — `{$PUBLIC_HOST:app.libriant.com}`,
 * `{args[0]}`, `{err.status_code}` — are braces that do NOT open a block, so
 * they are removed before any brace counting: a placeholder is a `{...}` with
 * no whitespace inside, a block opener is a lone `{` at the end of a line.
 */
function caddyDirective(line: string): string {
  const hash = line.indexOf('#');
  const code = hash === -1 ? line : line.slice(0, hash);
  return code.replace(/\{[^{}\s]*\}/g, ' ').trim();
}

type Frame = { opener: string; guardTags: string[] };

/** Every `reverse_proxy` in the file, with the block chain that encloses it. */
function proxyDirectives(): Array<{ line: number; target: string; stack: Frame[] }> {
  const found: Array<{ line: number; target: string; stack: Frame[] }> = [];
  const stack: Frame[] = [];
  CADDYFILE.split('\n').forEach((raw, i) => {
    const line = caddyDirective(raw);
    if (!line) return;
    const guard = /^import\s+origin_guard\s+(\S+)/.exec(line);
    if (guard?.[1] && stack.length > 0) stack[stack.length - 1]?.guardTags.push(guard[1]);
    if (/^reverse_proxy\b/.test(line)) {
      found.push({ line: i + 1, target: line, stack: stack.map((f) => ({ ...f })) });
    }
    for (const ch of line) {
      if (ch === '{') stack.push({ opener: line.split(/\s+/)[0] ?? '', guardTags: [] });
      else if (ch === '}') stack.pop();
    }
  });
  return found;
}

describe('infra/caddy/Caddyfile — the origin guard', () => {
  it('finds every reverse_proxy in the file (the parser itself works)', () => {
    // Six today: /lbr-api and /webhooks and the catch-all on the app host, the
    // admin host's /lbr-api and its catch-all, and the marketing /apply. If this
    // number moves, a route was added or removed — check the next test, which is
    // the one that matters.
    expect(proxyDirectives().length).toBeGreaterThanOrEqual(6);
  });

  it('guards EVERY proxied route — this is what /webhooks/* failed', () => {
    const unguarded = proxyDirectives()
      .filter((p) => !p.stack.some((f) => f.opener === 'route' && f.guardTags.length > 0))
      .map((p) => `Caddyfile:${p.line} — ${p.target}`);
    expect(
      unguarded,
      'Every reverse_proxy must sit inside a `route { import origin_guard <tag> ... }`. ' +
        'Only `route` honours source order, so a guard outside one does not run first. ' +
        "Without it the upstream receives the CLIENT's X-Real-IP and believes it.",
    ).toEqual([]);
  });

  it('gives each import a tag unique within its site block', () => {
    // origin_guard defines named matchers, and named matchers are scoped to the
    // whole site block — importing it twice with the same tag silently redefines
    // them, which is a config that loads and guards the wrong thing.
    const tags = [...CADDYFILE.matchAll(/^\s*import\s+origin_guard\s+(\S+)/gm)].map((m) => m[1]);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('never writes X-Real-IP from a client header outside the Cloudflare-peer matcher', () => {
    const lines = CADDYFILE.split('\n')
      .map((l, i) => ({ n: i + 1, d: caddyDirective(l) }))
      .filter(({ d }) => /X-Real-IP/i.test(d) && /CF-Connecting-IP/i.test(d))
      .filter(({ d }) => !/^request_header\s+@cf_peer_/.test(d));
    expect(
      lines.map(({ n, d }) => `Caddyfile:${n} — ${d}`),
      'CF-Connecting-IP may only become X-Real-IP for a peer already matched as ' +
        'Cloudflare. A `header_up X-Real-IP {http.request.header.CF-Connecting-IP}` ' +
        'runs for EVERY peer — that is the original defect, verbatim.',
    ).toEqual([]);
  });

  it('drops the client X-Forwarded-For rather than passing it through', () => {
    expect(CADDYFILE).toMatch(/^\s*request_header\s+-X-Forwarded-For\s*$/m);
  });
});

describe('infra/compose/docker-compose.prod.yml — the published ports', () => {
  const ports = [...COMPOSE_PROD.matchAll(/^\s*-\s*'([^']*:(?:80|443)(?:\/udp)?)'/gm)].map(
    (m) => m[1] as string,
  );

  it('publishes 80/443 with an explicit bind address, never the bare form', () => {
    expect(ports.length).toBeGreaterThanOrEqual(3);
    const wildcard = ports.filter((p) => p.split(':').length < 3);
    expect(
      wildcard,
      "'443:443' binds [::] as well as 0.0.0.0. With no enable_ipv6 on the network " +
        'Docker cannot DNAT the v6 connection, so docker-proxy re-originates it from ' +
        'the bridge gateway and every IPv6 client looks private to the edge guard.',
    ).toEqual([]);
  });

  it('keeps the bind and the network IPv6 setting in step', () => {
    const v4Only = ports.every((p) => p.startsWith('${EDGE_BIND_IPV4:-0.0.0.0}'));
    const networkHasV6 = /enable_ipv6:\s*true/.test(COMPOSE_PROD);
    expect(
      v4Only && !networkHasV6,
      'These change together or not at all: an IPv6-enabled network with a v4-only ' +
        'publish is pointless, and a dual-stack publish without one is the userland-proxy ' +
        'bypass. See the comment above `ports:` for the full four-step switch.',
    ).toBe(true);
  });
});
