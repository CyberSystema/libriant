import Link from 'next/link';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { CatalogTable, type CatalogBib } from './CatalogTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null; minQueryChars?: number };

export default async function CatalogPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const q = searchParams.q?.trim();
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', '25');

  let initial: ListResponse<CatalogBib>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<CatalogBib>>(
      `/t/${params.slug}/catalog/bib?${qs.toString()}`,
      { cookie },
    );
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader
        title={t('common.nav.catalog')}
        subtitle={t('catalog.subtitle')}
        help={
          <HelpButton title={t('catalog.help.title')}>
            <p>{t('catalog.help.intro')}</p>
            <h3>{t('catalog.help.doTitle')}</h3>
            <ul>
              <li>{t('catalog.help.do1')}</li>
              <li>{t('catalog.help.do2')}</li>
              <li>{t('catalog.help.do3')}</li>
            </ul>
            <h3>{t('catalog.help.countsTitle')}</h3>
            <p>{t('catalog.help.countsBody')}</p>
          </HelpButton>
        }
        actions={
          <Link
            href={`/${params.locale}/t/${params.slug}/catalog/new`}
            className="lbr-btn lbr-btn--primary lbr-btn--md"
          >
            {t('catalog.addBook')}
          </Link>
        }
      />
      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}
      <CatalogTable catalog={catalog} locale={params.locale} slug={params.slug} initial={initial} />
    </>
  );
}
