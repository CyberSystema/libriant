'use client';
import * as React from 'react';
import { DEFAULT_LOCALE, type Locale } from '@libriant/i18n';
import { safeLocale, staticTranslator } from '@/lib/static-catalog';

/**
 * Last-resort boundary: catches throws from `app/[locale]/layout.tsx` itself,
 * which is the one place `app/[locale]/error.tsx` cannot reach. It replaces the
 * whole document, so it renders its own `<html>`/`<body>` and cannot rely on
 * the token stylesheet or the AssetProvider — everything here is inline.
 *
 * The locale normally lives in the URL, but the root layout that would parse it
 * is exactly what failed, so we read it from `location` after mount and start
 * from Greek (`DEFAULT_LOCALE`) — the market this ships to. Doing it in an
 * effect rather than during render keeps the server and client markup identical.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = React.useState<Locale>(DEFAULT_LOCALE);
  React.useEffect(() => {
    setLocale(safeLocale(window.location.pathname.split('/')[1]));
    console.error('[libriant] fatal render failure', error.digest ?? error.message);
  }, [error]);
  const t = staticTranslator(locale);

  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#f6f8fa',
          color: '#1f2328',
        }}
      >
        <main style={{ textAlign: 'center', padding: '2rem', maxWidth: '34rem' }}>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.75rem' }}>{t('system.crash.title')}</h1>
          <p style={{ margin: '0 0 1.5rem', color: '#57606a', lineHeight: 1.5 }}>
            {t('system.crash.description')}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              appearance: 'none',
              border: 0,
              borderRadius: 8,
              padding: '0.625rem 1.25rem',
              background: '#1f6feb',
              color: '#fff',
              fontWeight: 600,
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            {t('system.crash.retry')}
          </button>
          {error.digest ? (
            <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', color: '#57606a' }}>
              {t('system.crash.reference')}: <code>{error.digest}</code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
