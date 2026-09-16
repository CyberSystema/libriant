import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { LoanFilters } from './LoanFilters';
import { LoansTable, type LoanRow } from './LoansTable';
import { ScanToReturn } from './ScanToReturn';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

/**
 * The six values `lbr2.loan_status` holds, mirrored here rather than imported —
 * the DTO lives in the API and the web app does not depend on it (2.0 phase 20q).
 *
 * 1.0 had three. A bookmarked `?status=` is filtered against this list before it
 * is forwarded because `validateDto` runs `forbidNonWhitelisted`: an unknown
 * value is a 400 and a red banner, where dropping it shows the unfiltered list,
 * which is the answer a stale link should get.
 */
const LOAN_STATUSES = [
  'active',
  'recalled',
  'claims_returned',
  'claims_never_borrowed',
  'returned',
  'lost',
];

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

  const requested = LOAN_STATUSES.includes(searchParams.status ?? '')
    ? searchParams.status
    : undefined;
  const overdue = searchParams.overdue === '1';
  /**
   * THE PAIR THE API REFUSES, resolved here rather than sent.
   *
   * `circulation.controller.ts` 400s `?overdue=1` paired with any status but
   * `active`, and it is right to: `?overdue=1` IS the active-and-past-due queue,
   * so `?status=lost&overdue=1` can only match nothing, and an empty page at a
   * desk reads as "nothing is overdue". `LoanFilters` already clears one when it
   * sets the other, so the only way to arrive with both is a bookmark or a typed
   * URL — and the overdue queue is the more specific of the two intents, so it
   * wins and the status is dropped.
   */
  const status = overdue && requested !== 'active' ? undefined : requested;
  const open = searchParams.open === '1';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (overdue) qs.set('overdue', '1');
  if (open) qs.set('open', '1');
  qs.set('limit', '25');

  let initial: ListResponse<LoanRow>;
  let fetchError: string | null = null;
  try {
    initial = await dataPort().get<ListResponse<LoanRow>>(
      `/t/${params.slug}/circulation/loans?${qs.toString()}`,
      { cookie },
    );
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
        open={open}
        initial={initial}
      />
    </>
  );
}
