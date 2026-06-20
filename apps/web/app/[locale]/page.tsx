import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, createTranslator, LOCALE_DISPLAY, SUPPORTED_LOCALES } from '@libriant/i18n';
import { Asset, PoweredBy } from '@libriant/ui';
import { loadCatalog } from '@/lib/locale-loader';

/**
 * Public marketing landing page (the apex `/<locale>`). Introduces Libriant
 * and routes visitors to sign-up / log-in. All copy comes from the `landing`
 * namespace (en + el); the look uses the design tokens + the shared `.lbr-*`
 * classes (see the "public landing page" block in @libriant/ui styles).
 */

const FEATURES = [
  'catalog',
  'circulation',
  'members',
  'reservations',
  'import',
  'bilingual',
] as const;

// Simple line icons (currentColor) so the page needs no extra image assets.
const ICONS: Record<(typeof FEATURES)[number], ReactNode> = {
  catalog: (
    <path d="M12 6.5C10.5 5 7.5 5 4 5.5v13c3.5-.5 6.5-.5 8 1 1.5-1.5 4.5-1.5 8-1v-13c-3.5-.5-6.5-.5-8 1Z M12 6.5v13" />
  ),
  circulation: (
    <>
      <path d="M4 9h12" />
      <path d="M13 6l3 3-3 3" />
      <path d="M20 15H8" />
      <path d="M11 18l-3-3 3-3" />
    </>
  ),
  members: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M20.5 19a5.5 5.5 0 0 0-4-5.3" />
    </>
  ),
  reservations: <path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1Z" />,
  import: (
    <>
      <path d="M12 3v10" />
      <path d="M8 9l4 4 4-4" />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>
  ),
  bilingual: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9 0-3.4 1.5-6.6 4-9Z" />
    </>
  ),
};

export default async function LandingPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const locale = params.locale;
  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);

  return (
    <div className="lbr-landing">
      <header className="lbr-landing__nav">
        <Link href={`/${locale}`} className="lbr-landing__brand" aria-label="Libriant">
          <Asset name="brand/logo" width={140} height={35} />
        </Link>
        <nav className="lbr-landing__nav-actions">
          <div className="lbr-landing__locales" aria-label={t('common.nav.language')}>
            {SUPPORTED_LOCALES.map((loc) => (
              <Link
                key={loc}
                href={`/${loc}`}
                className={`lbr-landing__locale${loc === locale ? ' lbr-landing__locale--active' : ''}`}
                aria-current={loc === locale ? 'page' : undefined}
              >
                {LOCALE_DISPLAY[loc].native}
              </Link>
            ))}
          </div>
          <Link href={`/${locale}/login`} className="lbr-btn lbr-btn--ghost">
            {t('landing.nav.login')}
          </Link>
          <Link href={`/${locale}/signup`} className="lbr-btn lbr-btn--primary">
            {t('landing.nav.signup')}
          </Link>
        </nav>
      </header>

      <section className="lbr-landing__hero">
        <div className="lbr-landing__hero-inner">
          <p className="lbr-landing__eyebrow">{t('landing.hero.eyebrow')}</p>
          <h1 className="lbr-landing__hero-title">{t('landing.hero.title')}</h1>
          <p className="lbr-landing__hero-sub">{t('landing.hero.subtitle')}</p>
          <div className="lbr-landing__hero-cta">
            <Link href={`/${locale}/signup`} className="lbr-landing__btn lbr-landing__btn--solid">
              {t('landing.hero.ctaPrimary')}
            </Link>
            <Link href={`/${locale}/login`} className="lbr-landing__btn lbr-landing__btn--outline">
              {t('landing.hero.ctaSecondary')}
            </Link>
          </div>
          <p className="lbr-landing__hero-note">{t('landing.hero.note')}</p>
        </div>
      </section>

      <section className="lbr-landing__section">
        <div className="lbr-landing__section-head">
          <h2 className="lbr-landing__section-title">{t('landing.features.title')}</h2>
          <p className="lbr-landing__section-sub">{t('landing.features.subtitle')}</p>
        </div>
        <div className="lbr-landing__features">
          {FEATURES.map((f) => (
            <article key={f} className="lbr-landing__feature">
              <span className="lbr-landing__feature-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {ICONS[f]}
                </svg>
              </span>
              <h3 className="lbr-landing__feature-title">{t(`landing.features.${f}.title`)}</h3>
              <p className="lbr-landing__feature-body">{t(`landing.features.${f}.body`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lbr-landing__section">
        <div className="lbr-landing__cta">
          <h2 className="lbr-landing__cta-title">{t('landing.cta.title')}</h2>
          <p className="lbr-landing__cta-body">{t('landing.cta.body')}</p>
          <Link href={`/${locale}/signup`} className="lbr-btn lbr-btn--primary lbr-btn--lg">
            {t('landing.cta.button')}
          </Link>
        </div>
      </section>

      <footer className="lbr-landing__footer">
        <PoweredBy />
        <span>{t('landing.footer.tagline')}</span>
      </footer>
    </div>
  );
}
