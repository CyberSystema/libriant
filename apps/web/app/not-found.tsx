import Link from 'next/link';
import { DEFAULT_LOCALE } from '@libriant/i18n';
import { staticTranslator } from '@/lib/static-catalog';

/**
 * Root not-found document.
 *
 * The root layout (`app/layout.tsx`) is a pass-through and renders no `<html>`,
 * so this page supplies its own. It covers routes that never reach the locale
 * layout — unmatched/non-locale URLs, and the `notFound()` thrown by
 * `app/[locale]/layout.tsx` for an unsupported locale. Kept self-contained
 * (inline styles, no AssetProvider) so it works without the per-locale theme.
 *
 * By definition there is no locale to read here, and it used to resolve that by
 * declaring `lang="en"` and speaking English at a Greek audience. It now says
 * the same thing twice, Greek first, with each block carrying its own `lang` so
 * a screen reader pronounces both correctly.
 */
const SECONDARY = DEFAULT_LOCALE === 'el' ? 'en' : 'el';

export default function NotFound() {
  const primary = staticTranslator(DEFAULT_LOCALE);
  const secondary = staticTranslator(SECONDARY);

  return (
    <html lang={DEFAULT_LOCALE}>
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
        <main style={{ textAlign: 'center', padding: '2rem', maxWidth: '32rem' }}>
          <p style={{ fontSize: '3rem', margin: '0 0 0.5rem', fontWeight: 700 }}>404</p>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>
            {primary('system.notFound.title')}
          </h1>
          <p style={{ margin: '0 0 1.5rem', color: '#57606a', lineHeight: 1.5 }}>
            {primary('system.notFound.description')}
          </p>
          <Link
            href={`/${DEFAULT_LOCALE}`}
            style={{ color: '#1f6feb', textDecoration: 'none', fontWeight: 600 }}
          >
            {primary('system.notFound.home')}
          </Link>
          <div
            lang={SECONDARY}
            style={{
              marginTop: '2rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid #d0d7de',
              color: '#57606a',
            }}
          >
            <p style={{ margin: '0 0 1rem', lineHeight: 1.5 }}>
              {secondary('system.notFound.description')}
            </p>
            <Link
              href={`/${SECONDARY}`}
              style={{ color: '#1f6feb', textDecoration: 'none', fontWeight: 600 }}
            >
              {secondary('system.notFound.home')}
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
