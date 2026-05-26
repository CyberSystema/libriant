import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, createTranslator, LOCALE_DISPLAY, SUPPORTED_LOCALES } from '@libriant/i18n';
import { Asset, Banner, Button, EmptyState } from '@libriant/ui';
import { loadCatalog } from '@/lib/locale-loader';

export default async function LocaleHome({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '2rem 1.5rem' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '2rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            color: 'var(--color-primary)',
          }}
        >
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <nav aria-label={t('common.nav.language')} style={{ display: 'flex', gap: '0.5rem' }}>
          {SUPPORTED_LOCALES.map((loc) => (
            <Link
              key={loc}
              href={`/${loc}`}
              style={{
                padding: '0.25rem 0.5rem',
                borderRadius: 4,
                textDecoration: 'none',
                color: loc === params.locale ? 'var(--color-primary)' : 'var(--color-text-muted)',
                fontWeight: loc === params.locale ? 600 : 400,
              }}
            >
              {LOCALE_DISPLAY[loc].native}
            </Link>
          ))}
        </nav>
      </header>

      <h1 style={{ fontSize: 'var(--fs-3xl)', margin: '0 0 0.5rem 0' }}>{t('common.app.name')}</h1>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '2rem' }}>
        {t('common.app.tagline')}
      </p>

      <Banner
        severity="info"
        title={t('onboarding.welcome.title')}
        style={{ marginBottom: '2rem' }}
      >
        {t('onboarding.welcome.subtitle')}
      </Banner>

      <EmptyState
        illustration="illustrations/empty-catalog"
        title={t('catalog.empty.title')}
        description={t('catalog.empty.description')}
        action={<Button variant="primary">{t('catalog.empty.cta')}</Button>}
      />

      <footer
        style={{ marginTop: '3rem', fontSize: 'var(--fs-sm)', color: 'var(--color-text-subtle)' }}
      >
        <p>
          This page exercises the Step 0 foundation: design tokens from{' '}
          <code>assets/theme/tokens.json</code>, icons + illustrations from <code>assets/</code>,
          strings from <code>locales/{params.locale}/</code>. Edit any of those files and reload to
          see the change.
        </p>
      </footer>
    </main>
  );
}
