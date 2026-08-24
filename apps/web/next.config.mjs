import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A value that changes on every build, inlined into the client bundle and used
 * to register the service worker as `/sw.js?v=<buildId>` (see lib/offline.ts).
 *
 * frontend-27: `public/sw.js` is byte-identical between deploys, so without
 * this the browser never notices a new worker, never re-runs install/activate,
 * and the caches named after the worker's version are never evicted — they grow
 * by one full set of hashed chunks per release and a corrected `offline.html`
 * never reaches an existing install. CI can pin it (`LIBRIANT_BUILD_ID`, e.g.
 * the commit sha) so the same build is reproducible; otherwise the build's own
 * timestamp is enough to make each deploy distinct.
 */
const buildId = process.env.LIBRIANT_BUILD_ID || Date.now().toString(36);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the file-tracing root to the monorepo root. Without this Next walks
  // up and can latch onto a stray lockfile in $HOME, mis-rooting production
  // (standalone) output traces.
  outputFileTracingRoot: path.join(here, '../../'),
  transpilePackages: ['@libriant/ui', '@libriant/i18n', '@libriant/shared'],
  // Inlined at build time (NOT re-read at `next start`), which is what makes it
  // a build id rather than a process id.
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  // Don't bundle SVGs from /assets into JS — they're served via the
  // `/_assets/*` route so designers can hot-swap files at runtime.
  // Also proxy /lbr-api/* to the NestJS API so browser fetches stay
  // same-origin (cookie sharing works in dev without TLS/Caddy gymnastics).
  async rewrites() {
    const apiTarget = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    return {
      beforeFiles: [
        { source: '/_assets/:path*', destination: '/api/assets/:path*' },
        { source: '/lbr-api/:path*', destination: `${apiTarget}/:path*` },
        // The admin panel is English-only and locale-free in the URL. Serve
        // `/admin/*` from the `en` route internally — the pages live under
        // app/[locale]/admin, so locale resolves to 'en' and the URL stays
        // `/admin/*`.
        { source: '/admin/:path*', destination: '/en/admin/:path*' },
      ],
    };
  },
  // WEB-02: Content-Security-Policy. The Caddy edge already sets the other
  // hardening headers (HSTS, X-Frame-Options, X-Content-Type-Options, …) but
  // there was no CSP anywhere, so an HTML sink regression (we render
  // `dangerouslySetInnerHTML` for the injected token <style> and for
  // tenant-authored help articles) would have no containment for script
  // execution or data exfiltration. We set CSP here at the web app rather than
  // Caddy because the Caddyfile is one shared snippet for both hosts and these
  // rules track the Next.js app's needs.
  //
  // `style-src` allows 'unsafe-inline' because Next injects inline styles (and
  // the per-library accent-colour <style>) without a nonce; a nonce-based
  // policy needs request-scoped middleware plumbing — a larger change. Scripts
  // get 'unsafe-inline' for Next's bootstrap/hydration inline scripts (the App
  // Router emits them without a nonce). object-src/base-uri/frame-ancestors are
  // locked down to actually contain an injection.
  //
  // A10-04 (documented residual): dropping script-src 'unsafe-inline' requires a
  // per-request nonce via a Next middleware ('nonce-<v>' + 'strict-dynamic').
  // That is the right hardening but it must be runtime-verified (a wrong nonce
  // breaks ALL hydration), so it is tracked as a follow-up rather than shipped
  // blind. Containment today rests on: no unescaped tenant HTML sinks (help
  // markdown is server-owned; announcements/branding are React-escaped; SVG
  // upload is blocked server-side), plus object-src/base-uri/frame-ancestors.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // Same-origin XHR/fetch only; browser API calls go through /lbr-api/* on
      // the same origin (see lib/api.ts), so no cross-origin connect is needed.
      "connect-src 'self'",
      // PWA: the service worker (worker-src) and web manifest (manifest-src)
      // are served from our own origin. Both fall back to default-src, but
      // we name them so the policy stays explicit if default-src tightens.
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Content-Security-Policy', value: csp }],
      },
    ];
  },
  // Canonicalise any locale-prefixed admin URL (stale links / bookmarks) to the
  // locale-free path. Runs before the rewrite above, so there's no loop.
  async redirects() {
    return [
      {
        source: '/:locale(en|el)/admin/:path*',
        destination: '/admin/:path*',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
