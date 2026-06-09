import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the file-tracing root to the monorepo root. Without this Next walks
  // up and can latch onto a stray lockfile in $HOME, mis-rooting production
  // (standalone) output traces.
  outputFileTracingRoot: path.join(here, '../../'),
  transpilePackages: ['@libriant/ui', '@libriant/i18n', '@libriant/shared'],
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
