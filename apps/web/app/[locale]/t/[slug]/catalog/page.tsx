import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { CatalogTable, type CatalogBook } from './CatalogTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: { locale: string; slug: string };
  searchParams: Record<string, string | undefined>;
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const q = searchParams.q?.trim();
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit', '25');

  let initial: ListResponse<CatalogBook>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<CatalogBook>>(
      `/t/${params.slug}/catalog/books?${qs.toString()}`,
      { cookie },
    );
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
  }

  return (
    <>
      <PageHeader
        title={t('common.nav.catalog')}
        subtitle={t('catalog.subtitle')}
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
