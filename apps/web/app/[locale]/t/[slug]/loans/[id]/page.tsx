import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { FinesPanel, type FinesListResponse } from '@/components/FinesPanel';
import { formatMoney } from '@/components/money';
import { LoanActions } from './LoanActions';

type LoanDetail = {
  id: string;
  loanedAt: string;
  dueAt: string;
  returnedAt: string | null;
  renewedCount: number;
  status: 'active' | 'returned' | 'lost';
  notes: string | null;
  member: { id: string; memberNumber: string; fullName: string };
  copy: {
    id: string;
    barcode: string;
    status: string;
    book: { id: string; title: string };
  };
  fines: Array<{
    id: string;
    amountCents: number;
    currency: string;
    reason: string;
    status: 'outstanding' | 'paid' | 'waived';
  }>;
};

function fmtDate(iso: string | null, locale: string): string {
  return iso ? new Date(iso).toLocaleDateString(locale) : '—';
}

function daysFromNow(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default async function LoanDetailPage(props: {
  params: Promise<{ locale: string; slug: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let loan: LoanDetail | null = null;
  let fetchError: string | null = null;
  try {
    loan = await api<LoanDetail>(`/t/${params.slug}/loans/${params.id}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  if (!loan) {
    return (
      <>
        <PageHeader title={t('loans.title')} />
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      </>
    );
  }

  // Bound once: `isLocale()` narrows `params.locale`, but that narrowing is lost
  // inside a callback (a `.map()` over the fines), where TypeScript sees a plain
  // string again.
  const locale = params.locale;
  const overdue = loan.status === 'active' && new Date(loan.dueAt) < new Date();
  const dueDays = daysFromNow(loan.dueAt);

  // The loan payload carries enough of each fine to *show* one (amount, reason,
  // status) but not enough to settle it, so the full rows come from the fines
  // endpoint — and only when this loan actually has fines, which most do not.
  // A failure here degrades to the loan's own thinner list rather than dropping
  // the fines off the page: "no fines" and "we could not load the fines" must
  // never look the same on a screen about money.
  let fines: FinesListResponse | null = null;
  let finesError: string | null = null;
  if (loan.fines.length > 0) {
    try {
      fines = await api<FinesListResponse>(
        `/t/${params.slug}/fines?loanId=${encodeURIComponent(loan.id)}&limit=50`,
        { cookie },
      );
    } catch (err) {
      finesError = translateApiError(err, t, t('loans.fines.loadFailed'));
    }
  }

  // Role only decides which buttons are drawn; the API enforces it (StaffWrite
  // to record a payment, owner/admin to write one off). An impersonating
  // Libriant admin holds no tenant session and is treated as owner, the same
  // way the tenant layout resolved them to let them in here.
  const session = await currentSession().catch(() => null);
  const role = session?.user.role ?? 'owner';
  const canSettleFines = role === 'owner' || role === 'admin' || role === 'librarian';
  const canWriteOffFines = role === 'owner' || role === 'admin';

  return (
    <>
      <PageHeader
        title={loan.copy.book.title}
        subtitle={`${t('loans.detail.copy')}: ${loan.copy.barcode}`}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/loans`} style={{ color: 'inherit' }}>
            ← {t('loans.title')}
          </Link>
        }
      />

      {overdue ? (
        <Banner severity="warning" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('loans.overdueBy', { days: -dueDays })}
        </Banner>
      ) : loan.status === 'active' && dueDays <= 3 ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('loans.dueIn', { days: dueDays })}
        </Banner>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('loans.detail.summary')} />
        <CardBody>
          <dl className="lbr-dl">
            <dt>{t('loans.columns.status')}</dt>
            <dd>
              <strong>{t(`loans.status.${loan.status}`)}</strong>
              {loan.status === 'active' && loan.renewedCount > 0
                ? ` · ${t('loans.detail.renewedCount', { count: loan.renewedCount })}`
                : ''}
            </dd>
            <dt>{t('loans.columns.member')}</dt>
            <dd>
              <Link href={`/${params.locale}/t/${params.slug}/members/${loan.member.id}`}>
                {loan.member.fullName}
              </Link>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {' '}
                · {loan.member.memberNumber}
              </span>
            </dd>
            <dt>{t('loans.columns.checkedOut')}</dt>
            <dd>{fmtDate(loan.loanedAt, params.locale)}</dd>
            <dt>{t('loans.columns.dueDate')}</dt>
            <dd>
              {fmtDate(loan.dueAt, params.locale)}
              {loan.status === 'active' ? (
                overdue ? (
                  <span style={{ color: 'var(--color-danger)' }}>
                    {' '}
                    · {t('loans.overdueBy', { days: -dueDays })}
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {' '}
                    · {t('loans.dueIn', { days: dueDays })}
                  </span>
                )
              ) : null}
            </dd>
            {loan.returnedAt ? (
              <>
                <dt>{t('loans.detail.returnedAt')}</dt>
                <dd>{fmtDate(loan.returnedAt, params.locale)}</dd>
              </>
            ) : null}
            {loan.notes ? (
              <>
                <dt>{t('loans.detail.notes')}</dt>
                <dd>
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      font: 'inherit',
                      margin: 0,
                    }}
                  >
                    {loan.notes}
                  </pre>
                </dd>
              </>
            ) : null}
          </dl>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('loans.detail.actions')} />
        <CardBody>
          <LoanActions slug={params.slug} loan={loan} catalog={catalog} locale={params.locale} />
        </CardBody>
      </Card>

      {fines ? (
        <FinesPanel
          slug={params.slug}
          locale={params.locale}
          catalog={catalog}
          scope={{ kind: 'loan', loanId: loan.id }}
          initial={fines}
          canSettle={canSettleFines}
          canWriteOff={canWriteOffFines}
        />
      ) : loan.fines.length > 0 ? (
        // Fallback for a failed fines fetch: the loan's own list, read-only.
        // The status column used to be headed by `common.actions.search`
        // ("Search"), and the status itself printed as the raw API enum.
        <Card>
          <CardHeader title={t('loans.fines.title')} />
          <CardBody>
            {finesError ? (
              <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
                {finesError}
              </Banner>
            ) : null}
            <div className="lbr-table-wrap">
              <table className="lbr-table">
                <thead>
                  <tr>
                    <th>{t('loans.fines.columns.reason')}</th>
                    <th>{t('loans.fines.columns.amount')}</th>
                    <th>{t('loans.fines.columns.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loan.fines.map((f) => (
                    <tr key={f.id}>
                      <td>{f.reason}</td>
                      <td>{formatMoney(f.amountCents, f.currency, locale)}</td>
                      <td>{t(`loans.fines.status.${f.status}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
