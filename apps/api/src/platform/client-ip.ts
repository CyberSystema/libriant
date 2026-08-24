import { BlockList, isIP, isIPv6 } from 'node:net';
import type { Request } from 'express';

/**
 * Default trust set: loopback + every private / link-local range.
 *
 * The API listens on the internal compose network and is never published to a
 * host port, so its only possible TCP peer is the Caddy container. A request
 * whose peer is a PUBLIC address therefore did not come through our edge —
 * somebody pointed at the API directly — and nothing it claims about itself can
 * be believed. Defaulting to "private peer = our own proxy" keeps dev, test and
 * the compose stack working with no configuration, while a misconfiguration
 * that exposes the API can never turn into a spoofable rate-limit key.
 *
 * `TRUSTED_PROXY_CIDRS` (comma-separated CIDRs or bare IPs) narrows this to an
 * explicit list — e.g. the Caddy container address alone.
 */
const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fe80::/10',
  'fc00::/7',
].join(',');

/** Parsed form of the current spec. Re-parsed only when the spec string changes. */
let parsed: { spec: string; list: BlockList } | null = null;

/**
 * Resolve the real client IP for audit + rate-limiting.
 *
 * EVERY unauthenticated budget in the system keys on this value: the signup /
 * login / password-reset / email-verify limiters (auth.controller.ts), the
 * admin-login limiter, the `/apply` throttle, and the per-(account+IP)
 * brute-force lockout in login.service.ts.
 *
 * This function used to return `X-Real-IP` unconditionally, justified by a
 * comment claiming the host firewall admitted only Cloudflare ranges so the
 * header could not be forged. No such rule existed on any box, and the audit
 * (authn-authz-01 / input-and-files-02) executed the consequence: six wrong
 * logins each carrying a fresh `X-Real-IP` never tripped the lockout, 25 logins
 * with rotating headers never hit the 20/5min cap, and eight signups with
 * rotating headers provisioned eight Postgres databases.
 *
 * So the header is honoured ONLY when the immediate TCP peer is a trusted
 * proxy. Untrusted peer → the peer address IS the client, headers ignored.
 *
 * ---- what this layer does and does NOT guarantee ---------------------------
 * It guarantees: nobody who reaches the API directly can name themselves. It
 * CANNOT guarantee that a header arriving from our own proxy is true, because
 * from here Caddy is Caddy no matter what Caddy believed. That is why the value
 * has to be made trustworthy before it gets here, in two layers:
 *
 *   1. scripts/prod-bootstrap.sh --firewall-only — the packet never arrives
 *      unless its source is Cloudflare. Hooked into INPUT *and* DOCKER-USER,
 *      v4 *and* v6, because of (2).
 *   2. infra/caddy/Caddyfile (origin_guard) — X-Real-IP is written from the TCP
 *      PEER: `CF-Connecting-IP` is copied only when the peer really is a
 *      Cloudflare address, and for any other admitted peer the peer address
 *      itself becomes X-Real-IP. Client-supplied X-Forwarded-For is dropped.
 *
 * Layer 2 was added because layer 2's first version (a bare Cloudflare-or-
 * private matcher) was walked straight through over IPv6: the host has a public
 * v6 address, Docker publishes 443 on [::], and with no `enable_ipv6` on the
 * compose network the connection is relayed by Docker's userland proxy, which
 * re-originates it from the BRIDGE GATEWAY — a private address the matcher
 * admitted, after which the forged `CF-Connecting-IP` was stamped in as before.
 * The lesson that shaped all three layers: never infer "trusted" from an
 * address family or a range that our own plumbing can synthesise.
 */
export function clientIp(req: Request): string | undefined {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!isTrustedProxy(peer)) return peer;

  const forwarded = normalizeIp(lastHeaderValue(req.headers['x-real-ip']));
  // Validate: a misconfigured proxy that forwards an empty or garbage value
  // must not become a rate-limit bucket of its own.
  if (forwarded) return forwarded;

  // No X-Real-IP: the peer is the answer, and we do NOT fall back to `req.ip`.
  // `origin_guard` sets X-Real-IP on every route Caddy proxies, so an absent
  // one means the request did not come through one of them — a direct hit on
  // api:3001, or a route someone added without the guard. `req.ip` is derived
  // from X-Forwarded-For, i.e. from exactly the client-authored surface this
  // function exists to distrust: on the userland-proxy path the peer is private
  // and therefore "trusted", so Express would walk past it and hand back the
  // client's own entry. The peer is the only thing left that was proven by a
  // completed TCP handshake.
  return peer;
}

/**
 * Is `addr` one of our own reverse proxies — i.e. may we believe the
 * forwarding headers on a connection coming from it?
 *
 * Exported so main.ts can hand the SAME predicate to Express's `trust proxy`.
 * A blanket `trust proxy: true` there made `req.ip` client-controlled, which is
 * how the second spoof vector in authn-authz-01 worked.
 */
export function isTrustedProxy(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = normalizeIp(addr);
  if (!ip) return false;
  return trustedProxies().check(ip, isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/** The trust set in force, for the boot log. Also validates it (throws if malformed). */
export function describeTrustedProxies(): string {
  trustedProxies();
  return currentSpec();
}

function currentSpec(): string {
  const raw = process.env.TRUSTED_PROXY_CIDRS?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_TRUSTED_PROXY_CIDRS;
}

function trustedProxies(): BlockList {
  const spec = currentSpec();
  if (parsed?.spec === spec) return parsed.list;
  const list = new BlockList();
  for (const entry of spec.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const [addr, prefixRaw] = splitCidr(token);
    const family = isIP(addr);
    if (family === 0) {
      throw new Error(
        `TRUSTED_PROXY_CIDRS contains "${token}", which is not an IP address or CIDR.`,
      );
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    const maxPrefix = family === 6 ? 128 : 32;
    const prefix = prefixRaw === undefined ? maxPrefix : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(
        `TRUSTED_PROXY_CIDRS contains "${token}", whose prefix length is out of range.`,
      );
    }
    list.addSubnet(addr, prefix, type);
  }
  parsed = { spec, list };
  return list;
}

function splitCidr(token: string): [string, string | undefined] {
  const slash = token.lastIndexOf('/');
  if (slash < 0) return [token, undefined];
  return [token.slice(0, slash), token.slice(slash + 1)];
}

/**
 * Take the LAST value, not the first. Our proxy REPLACES `X-Real-IP`, so there
 * is normally exactly one; if a hop ever appends instead, the value our own
 * proxy wrote is the trailing one, and the leading ones are the client's.
 */
function lastHeaderValue(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const flat = Array.isArray(header) ? header.join(',') : header;
  const parts = flat.split(',');
  return parts[parts.length - 1]?.trim();
}

/**
 * Strip the `::ffff:` prefix from IPv4-mapped addresses and any `%zone` suffix,
 * so one client is one bucket regardless of which socket family carried it, and
 * return undefined for anything that is not an IP at all.
 */
function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bare = value.trim().split('%')[0] ?? '';
  const unmapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1] ?? bare;
  return isIP(unmapped) === 0 ? undefined : unmapped;
}
