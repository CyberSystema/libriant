import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, PageHeader, PoweredBy } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { LEGAL_VERSION, isLegalDocSlug } from '@libriant/shared/legal';
import { loadCatalog } from '@/lib/locale-loader';
import { loadLegalDoc, legalTitleKey } from '@/lib/legal';

export const dynamic = 'force-dynamic';

/** A single public legal document (`/<locale>/legal/<slug>`). No auth required. */
export default async function LegalDocPage(props: {
  params: Promise<{ locale: string; doc: string }>;
}) {
  const { locale, doc } = await props.params;
  if (!isLocale(locale) || !isLegalDocSlug(doc)) notFound();

  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);
  const rendered = await loadLegalDoc(locale, doc);
  if (!rendered) notFound();

  return (
    <main className="lbr-legal">
      <PageHeader
        title={t(legalTitleKey(doc))}
        trail={
          <Link href={`/${locale}/legal`} style={{ color: 'inherit' }}>
            ← {t('legal.backToIndex')}
          </Link>
        }
      />

      <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
        {t('legal.draftNotice')}
      </Banner>
      {rendered.fallback ? (
        <Banner severity="warning" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('legal.fallbackNotice')}
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          <article
            className="lbr-prose"
            // Server-owned, checked-in markdown rendered at request time — no
            // user input, identical trust model to the help articles.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        </CardBody>
      </Card>

      <p className="lbr-legal__meta">{t('legal.version', { version: LEGAL_VERSION })}</p>
      <footer className="lbr-legal__footer">
        <PoweredBy />
      </footer>
    </main>
  );
}
