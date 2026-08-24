import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { LoanFilters } from './LoanFilters';
import { LoansTable, type LoanRow } from './LoansTable';
import { ScanToReturn } from './ScanToReturn';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

export default async function LoansPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const status = searchParams.status;
  const overdue = searchParams.overdue === '1';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (overdue) qs.set('overdue', '1');
  qs.set('limit', '25');

  let initial: ListResponse<LoanRow>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<LoanRow>>(`/t/${params.slug}/loans?${qs.toString()}`, {
      cookie,
    });
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader
        title={t('loans.title')}
        subtitle={t('loans.subtitle')}
        actions={
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <ScanToReturn slug={params.slug} locale={params.locale} catalog={catalog} />
            <Link
              href={`/${params.locale}/t/${params.slug}/loans/new`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('loans.newLoan')}
            </Link>
          </div>
        }
      />
      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}
      <LoanFilters catalog={catalog} locale={params.locale} />
      <LoansTable
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
        status={status}
        overdue={overdue}
        initial={initial}
      />
    </>
  );
}
