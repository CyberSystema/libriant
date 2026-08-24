import type { MetadataRoute } from 'next';

/**
 * Web app manifest — makes Libriant installable as a PWA. Next serves this at
 * `/manifest.webmanifest` and injects `<link rel="manifest">` automatically.
 *
 * frontend-19: this used to declare `orientation: 'portrait-primary'` and
 * SVG-only icons. Android honours the orientation lock, so a tablet mounted in
 * landscape at the circulation desk — the obvious deployment — could not be
 * used in the orientation it is physically bolted into (WCAG 2.1 SC 1.3.4,
 * Level AA). Leaving `orientation` out lets the device decide, which is the
 * only correct answer for a device we do not own. `lang` was `en` for a product
 * whose default locale is Greek.
 *
 * Icons: `/_assets/*` SVGs are hot-swappable (a designer drops in a new file
 * and the app picks it up with no rebuild), and that is still true everywhere
 * the app renders a logo. It cannot be true for the PWA icons: iOS refuses SVG
 * for `apple-touch-icon` outright, and Android maskable icons need real pixels
 * inside the safe zone. So the install icons are rasters committed under
 * `apps/web/public`, generated from `assets/brand/logo-square.svg` with sharp
 * (192 and 512 transparent full-bleed; 512 maskable at 64% on white, because
 * the shelf mark reaches the artboard corners and a launcher mask would clip
 * it; 180 opaque for iOS). Re-run that rasterisation when the brand mark
 * changes — the SVG entry below keeps the hot-swap path for browsers that can
 * take it, but the PNGs are what an install actually uses.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Libriant',
    short_name: 'Libriant',
    description: 'Library management, made simple.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1f6feb',
    lang: 'el',
    dir: 'ltr',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/_assets/brand/logo-square.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
