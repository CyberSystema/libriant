/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
      ],
    };
  },
};

export default nextConfig;
