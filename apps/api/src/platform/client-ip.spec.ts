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
