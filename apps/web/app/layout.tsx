import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Libriant',
  description: 'Library management, made simple.',
};

/**
 * Pass-through root layout — it renders NO document of its own.
 *
 * The real document (`<html lang>`, the themed `<head>`, and `<body>` with the
 * AssetProvider) is rendered by `app/[locale]/layout.tsx`, the only layout that
 * knows the locale. If this layout ALSO rendered `<html>`/`<body>`, the App
 * Router would nest them — `<html><body><html lang><body>…` — which the browser
 * can't represent and React can't hydrate, leaving a blank page.
 *
 * Every rendered route still ends up with exactly one document:
 *   - `/`            → `app/page.tsx` redirects to a locale (renders nothing).
 *   - `/<locale>/…`  → `app/[locale]/layout.tsx` supplies the document.
 *   - anything else  → `app/not-found.tsx` carries its own `<html>`/`<body>`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
