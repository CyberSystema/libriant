import Link from 'next/link';
import { createTranslator, type Locale } from '@libriant/i18n';
import type { LegalDocSlug } from '@libriant/shared/legal';
import { loadCatalog } from '@/lib/locale-loader';
import { legalTitleKey } from '@/lib/legal';

/** Curated footer subset (the docs visitors look for most). The full set lives
 *  on the /legal index. */
const FOOTER_DOCS: readonly LegalDocSlug[] = ['terms', 'privacy', 'cookies', 'legal-notice'];

/**
 * Reusable legal-links footer row (Terms · Privacy · Cookies · Legal notice),
 * used on the public landing + the auth pages. Async server component: loads its
 * own `legal` namespace so callers don't have to thread translations.
 */
export async function LegalFooterLinks({ locale }: { locale: Locale }) {
  const catalog = await loadCatalog(locale, ['legal']);
  const t = createTranslator(catalog, locale);
  return (
    <nav className="lbr-legal-links" aria-label={t('legal.footer.heading')}>
      {FOOTER_DOCS.map((slug) => (
        <Link key={slug} href={`/${locale}/legal/${slug}`} className="lbr-legal-links__item">
          {t(legalTitleKey(slug))}
        </Link>
      ))}
    </nav>
  );
}
