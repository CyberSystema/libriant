/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@libriant/ui', '@libriant/i18n', '@libriant/shared'],
  // Don't bundle SVGs from /assets into JS — they're served via the
  // `/_assets/*` route so designers can hot-swap files at runtime.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/_assets/:path*', destination: '/api/assets/:path*' },
      ],
    };
  },
};

export default nextConfig;
