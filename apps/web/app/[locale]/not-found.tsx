'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Asset } from '@libriant/ui';
import { safeLocale, staticTranslator } from '@/lib/static-catalog';

/**
 * 404 for locale-prefixed routes. Renders inside `app/[locale]/layout.tsx`, so
 * it inherits the theme tokens and the brand — the root `not-found.tsx` could
 * do neither, and served English under `lang="en"` to Greek readers.
 *
 * Next passes no params to a `not-found`, so the locale comes from the path.
 * That also means the catalogue has to be the bundled one rather than the
 * server-loaded merge; the copy still lives in /locales either way.
 */
export default function LocaleNotFound() {
  const locale = safeLocale(usePathname()?.split('/')[1]);
  const t = staticTranslator(locale);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-6)',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ maxWidth: 520, textAlign: 'center' }}>
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: 'var(--sp-2)' }}>
          {t('system.notFound.title')}
        </h1>
        <p
          style={{
            fontSize: 'var(--fs-lg)',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--sp-5)',
          }}
        >
          {t('system.notFound.description')}
        </p>
        <Link
          href={`/${locale}`}
          className="lbr-btn lbr-btn--primary lbr-btn--md"
          style={{ textDecoration: 'none' }}
        >
          {t('system.notFound.home')}
        </Link>
      </div>
    </main>
  );
}
