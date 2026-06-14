import type { Request } from 'express';

/**
 * Resolve the real client IP for audit + rate-limiting.
 *
 * We run behind Cloudflare → Caddy. Caddy sets `X-Real-IP` to Cloudflare's
 * `CF-Connecting-IP` (the true client), and the host firewall only admits
 * Cloudflare ranges, so the header cannot be spoofed by hitting the origin
 * directly (see infra/caddy/Caddyfile). `req.ip` is therefore the proxy peer
 * (a Caddy/Cloudflare edge address), NOT the client — keying rate limits on
 * it collapses every visitor into one bucket. Prefer `X-Real-IP`.
 *
 * `X-Forwarded-For` is deliberately NOT trusted here: in this topology Caddy
 * populates it with the Cloudflare edge node it saw, not the end user.
 */
export function clientIp(req: Request): string | undefined {
  const header = req.headers['x-real-ip'];
  const raw = Array.isArray(header) ? header[0] : header;
  const realIp = raw?.split(',')[0]?.trim();
  return realIp || req.ip || req.socket?.remoteAddress || undefined;
}
