import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
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

  const overdue = loan.status === 'active' && new Date(loan.dueAt) < new Date();
  const dueDays = daysFromNow(loan.dueAt);

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

      {loan.fines.length > 0 ? (
        <Card>
          <CardHeader title={t('loans.detail.fines')} />
          <CardBody>
            <div className="lbr-table-wrap">
              <table className="lbr-table">
                <thead>
                  <tr>
                    <th>{t('loans.detail.reason')}</th>
                    <th>{t('loans.detail.amount')}</th>
                    <th>{t('common.actions.search')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loan.fines.map((f) => (
                    <tr key={f.id}>
                      <td>{f.reason}</td>
                      <td>
                        {new Intl.NumberFormat(params.locale, {
                          style: 'currency',
                          currency: f.currency,
                        }).format(f.amountCents / 100)}
                      </td>
                      <td>{f.status}</td>
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
