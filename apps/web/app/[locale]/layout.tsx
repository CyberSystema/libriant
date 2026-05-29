import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, SUPPORTED_LOCALES } from '@libriant/i18n';
import { AssetProvider, tokensToCssVars } from '@libriant/ui';
import '@libriant/ui/styles.css';
import { loadManifest, loadTokens } from '@/lib/assets-server';

export const metadata: Metadata = {
  title: 'Libriant',
  description: 'Library management, made simple.',
  icons: { icon: '/_assets/brand/favicon.svg' },
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

  const [manifest, tokens] = await Promise.all([loadManifest(), loadTokens()]);
  const css = tokensToCssVars(tokens);

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
      </body>
    </html>
  );
}
