import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, SUPPORTED_LOCALES, createTranslator } from '@libriant/i18n';
import { AssetProvider, tokensToCssVars } from '@libriant/ui';
import '@libriant/ui/styles.css';
import { loadManifest, loadTokens } from '@/lib/assets-server';
import { loadCatalog } from '@/lib/locale-loader';
import { ServiceWorkerManager } from '@/components/ServiceWorkerManager';

export const metadata: Metadata = {
  title: 'Libriant',
  description: 'Library management, made simple.',
  icons: {
    icon: '/_assets/brand/favicon.svg',
    apple: '/_assets/brand/logo-square.svg',
  },
  // iOS: launch standalone (no Safari chrome) when added to the home screen.
  appleWebApp: { capable: true, title: 'Libriant', statusBarStyle: 'default' },
};

/**
 * Mobile-first viewport. `width=device-width, initial-scale=1` is what makes
 * the responsive layout actually apply on phones; `viewport-fit=cover` lets
 * content extend under iOS notches (we pair this with safe-area-aware padding
 * where it matters). Explicit so it can never regress to a desktop-width page.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export default async function LocaleLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;

  const { children } = props;

  if (!isLocale(params.locale)) notFound();

  const [manifest, tokens, catalog] = await Promise.all([
    loadManifest(),
    loadTokens(),
    loadCatalog(params.locale),
  ]);
  const css = tokensToCssVars(tokens);
  const t = createTranslator(catalog, params.locale);

  return (
    <html lang={params.locale}>
      <head>
        {/* Tokens are emitted server-side as CSS custom properties. Editing
            /assets/theme/tokens.json changes the look on next page load. */}
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <AssetProvider manifest={manifest} baseUrl="/_assets">
          {children}
        </AssetProvider>
        {/* Registers the PWA service worker (prod) + shows an offline status bar. */}
        <ServiceWorkerManager offlineLabel={t('common.offline.banner')} />
      </body>
    </html>
  );
}
