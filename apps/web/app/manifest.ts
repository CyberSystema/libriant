import type { MetadataRoute } from 'next';

/**
 * Web app manifest — makes Libriant installable as a PWA. Next serves this at
 * `/manifest.webmanifest` and injects `<link rel="manifest">` automatically.
 *
 * Icons reference the brand SVGs through the `/_assets/*` route (the same
 * hot-swappable asset system the rest of the app uses), so a logo change is
 * picked up without a rebuild. `logo-square.svg` is a filled square whose
 * content sits inside the maskable safe zone, so it doubles as the maskable
 * icon. `theme_color` is the default brand primary.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Libriant',
    short_name: 'Libriant',
    description: 'Library management, made simple.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: '#1f6feb',
    lang: 'en',
    dir: 'ltr',
    icons: [
      {
        src: '/_assets/brand/logo-square.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/_assets/brand/logo-square.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
      {
        src: '/_assets/brand/favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}
