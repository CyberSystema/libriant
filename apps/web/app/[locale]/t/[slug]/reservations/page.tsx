import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { ReservationFilters } from './ReservationFilters';
import { ReservationsTable, type ReservationRow } from './ReservationsTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

export default async function ReservationsPage(props: {
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
  const includeResolved = searchParams.includeResolved === '1';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (includeResolved) qs.set('includeResolved', '1');
  qs.set('limit', '25');

  let initial: ListResponse<ReservationRow>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<ReservationRow>>(
      `/t/${params.slug}/reservations?${qs.toString()}`,
      { cookie },
    );
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader
        title={t('reservations.title')}
        subtitle={t('reservations.subtitle')}
        actions={
          <Link
            href={`/${params.locale}/t/${params.slug}/reservations/new`}
            className="lbr-btn lbr-btn--primary lbr-btn--md"
          >
            {t('reservations.placeHold')}
          </Link>
        }
      />
      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}
      <ReservationFilters catalog={catalog} locale={params.locale} />
      <ReservationsTable
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
        status={status}
        includeResolved={includeResolved}
        initial={initial}
      />
    </>
  );
}
