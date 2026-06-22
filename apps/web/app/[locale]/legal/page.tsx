import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, PageHeader, PoweredBy } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { LEGAL_VERSION } from '@libriant/shared/legal';
import { loadCatalog } from '@/lib/locale-loader';
import { LEGAL_DOC_ORDER, legalSummaryKey, legalTitleKey } from '@/lib/legal';

export const dynamic = 'force-dynamic';

/** Public index of the legal layer (`/<locale>/legal`). No auth required. */
export default async function LegalIndexPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  if (!isLocale(locale)) notFound();
  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);

  return (
    <main className="lbr-legal">
      <PageHeader
        title={t('legal.index.title')}
        subtitle={t('legal.index.subtitle')}
        trail={
          <Link href={`/${locale}`} style={{ color: 'inherit' }}>
            ← Libriant
          </Link>
        }
      />

      <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
        {t('legal.draftNotice')}
      </Banner>

      <div className="lbr-legal__list">
        {LEGAL_DOC_ORDER.map((slug) => (
          <Link key={slug} href={`/${locale}/legal/${slug}`} className="lbr-legal__item">
            <Card>
              <CardBody>
                <h2 className="lbr-legal__item-title">{t(legalTitleKey(slug))}</h2>
                <p className="lbr-legal__item-summary">{t(legalSummaryKey(slug))}</p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>

      <p className="lbr-legal__meta">{t('legal.version', { version: LEGAL_VERSION })}</p>
      <footer className="lbr-legal__footer">
        <PoweredBy />
      </footer>
    </main>
  );
}
