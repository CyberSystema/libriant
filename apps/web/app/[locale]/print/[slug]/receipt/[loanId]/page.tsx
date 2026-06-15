import { notFound } from 'next/navigation';
import { Asset, Barcode, PoweredBy } from '@libriant/ui';
import {
  createTranslator,
  formatCurrency,
  formatDate,
  formatDateTime,
  isLocale,
  type Locale,
} from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';

export const dynamic = 'force-dynamic';

type LoanReceipt = {
  id: string;
  loanedAt: string;
  dueAt: string;
  returnedAt: string | null;
  status: 'active' | 'returned' | 'lost';
  member: { id: string; memberNumber: string; fullName: string };
  copy: { id: string; barcode: string; book: { id: string; title: string } };
  fines: Array<{
    id: string;
    amountCents: number;
    currency: string;
    reason: string;
    status: 'outstanding' | 'paid' | 'waived';
  }>;
};

/**
 * Chrome-free circulation receipt — a checkout or return slip. Reachable both as
 * a silent desktop print (hidden window) and a normal browser tab (auto-prints);
 * either way the request carries the librarian's session cookie, so the same
 * authenticated `api()` calls the rest of the app uses work here.
 */
export default async function ReceiptPage(props: {
  params: Promise<{ locale: string; slug: string; loanId: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const locale: Locale = params.locale;
  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);

  const session = await currentSession();
  if (!session) notFound();
  // Mirror the tenant shell's isolation: a slug that isn't the caller's own
  // tenant is a clean 404 (the API would 403 it anyway — this avoids surfacing
  // that as a 500).
  if (session.tenant.slug !== params.slug) notFound();
  const cookie = await requestCookieHeader();

  let loan: LoanReceipt;
  try {
    loan = await api<LoanReceipt>(`/t/${params.slug}/loans/${params.loanId}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const libraryName = session.tenant.name;
  const brandLogoUrl = session.tenant.brandLogoRef
    ? `/lbr-api/t/${session.tenant.slug}/storage/${session.tenant.brandLogoRef}`
    : null;
  const isReturn = loan.status === 'returned';
  const outstanding = loan.fines.filter((f) => f.status === 'outstanding');

  return (
    <div className="lbr-receipt">
      <div className="lbr-receipt__brand">
        {brandLogoUrl ? (
          <img src={brandLogoUrl} alt={libraryName} />
        ) : (
          <Asset name="brand/logo" style={{ maxHeight: 32 }} />
        )}
      </div>
      <div className="lbr-receipt__lib">{libraryName}</div>
      <div className="lbr-receipt__kind">
        {isReturn ? t('loans.print.returnSlip') : t('loans.print.checkoutSlip')}
      </div>

      <hr />

      <div className="lbr-receipt__row">
        <span>{t('loans.print.member')}</span>
        <span>
          {loan.member.fullName} · {loan.member.memberNumber}
        </span>
      </div>

      <div className="lbr-receipt__item">
        <strong>{loan.copy.book.title}</strong>
        <div className="lbr-receipt__row">
          <span>{t('loans.detail.copy')}</span>
          <span>{loan.copy.barcode}</span>
        </div>
      </div>

      <div className="lbr-receipt__row">
        <span>{t('loans.columns.checkedOut')}</span>
        <span>{formatDate(new Date(loan.loanedAt), locale)}</span>
      </div>
      <div className="lbr-receipt__row">
        <span>{isReturn ? t('loans.detail.returnedAt') : t('loans.print.dueDate')}</span>
        <span>
          {isReturn && loan.returnedAt
            ? formatDate(new Date(loan.returnedAt), locale)
            : formatDate(new Date(loan.dueAt), locale)}
        </span>
      </div>

      {outstanding.length > 0 ? (
        <>
          <hr />
          {outstanding.map((f) => (
            <div className="lbr-receipt__row" key={f.id}>
              <span>{f.reason}</span>
              <span>{formatCurrency(f.amountCents / 100, locale, f.currency)}</span>
            </div>
          ))}
        </>
      ) : null}

      <div className="lbr-receipt__barcode">
        <Barcode value={loan.copy.barcode} height={48} />
      </div>

      <hr />

      <div className="lbr-receipt__foot">
        <div>{t('loans.print.generatedAt', { at: formatDateTime(new Date(), locale) })}</div>
        <div style={{ marginTop: 4 }}>
          <PoweredBy />
        </div>
      </div>
    </div>
  );
}
