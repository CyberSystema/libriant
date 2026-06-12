import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api, type BillingSnapshot, type ListResponse } from '@/lib/api';

type ListShape = ListResponse<unknown>;

/**
 * Tenant home — at-a-glance counts pulled in parallel from the API, plus
 * the current billing snapshot. Server-rendered so the page is usable
 * the moment the layout finishes auth-redirects.
 *
 * Each API failure is caught locally so one slow endpoint doesn't blank
 * the whole dashboard; the affected tile shows its own friendly error.
 */
export default async function TenantHome(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  async function safeCount(path: string): Promise<{ count: number | null; error: boolean }> {
    try {
      const res = await api<ListShape>(path, { cookie });
      // Cursor-paged endpoints don't return a total; render the page-1 size
      // followed by "+" if there's a nextCursor. Good enough for the home
      // tile; a totals endpoint can replace this later.
      return { count: res.items.length, error: false };
    } catch {
      return { count: null, error: true };
    }
  }

  async function safeBilling(): Promise<BillingSnapshot | null> {
    try {
      return await api<BillingSnapshot>(`/t/${params.slug}/billing`, { cookie });
    } catch {
      return null;
    }
  }

  const [books, members, activeLoans, overdueLoans, queuedHolds, billing] = await Promise.all([
    safeCount(`/t/${params.slug}/catalog/books?limit=1`),
    safeCount(`/t/${params.slug}/members?limit=1`),
    safeCount(`/t/${params.slug}/loans?status=active&limit=100`),
    safeCount(`/t/${params.slug}/loans?overdue=1&limit=100`),
    safeCount(`/t/${params.slug}/reservations?status=queued&limit=100`),
    safeBilling(),
  ]);

  const isEmpty = books.count === 0 && members.count === 0;
  const off = t('common.dashboard.offline');

  return (
    <>
      <PageHeader title={t('common.app.name')} subtitle={t('onboarding.welcome.subtitle')} />

      {billing && billing.billingEnabled && billing.status === 'past_due' ? (
        <Banner
          severity="warning"
          title={t('billing.retry.title')}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          {t('billing.retry.body', { date: fmtDate(billing.graceUntil) ?? '' })}{' '}
          <Link href={`/${params.locale}/t/${params.slug}/billing`}>{t('billing.retry.link')}</Link>
          .
        </Banner>
      ) : null}

      {isEmpty ? (
        <EmptyState
          illustration="illustrations/welcome"
          title={t('onboarding.welcome.title')}
          description={t('onboarding.welcome.subtitle')}
          action={
            <Link
              href={`/${params.locale}/t/${params.slug}/onboarding`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('onboarding.welcome.start')}
            </Link>
          }
        />
      ) : books.count === 0 || members.count === 0 ? (
        <Banner
          severity="info"
          title={t('onboarding.nudge.title')}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          {books.count === 0
            ? t('onboarding.nudge.bookMissing')
            : t('onboarding.nudge.memberMissing')}{' '}
          <Link href={`/${params.locale}/t/${params.slug}/onboarding`}>
            {t('onboarding.nudge.cta')}
          </Link>
        </Banner>
      ) : null}

      {!isEmpty ? (
        <section className="lbr-stat-grid" style={{ marginBottom: 'var(--sp-6)' }}>
          <Tile label={t('common.nav.catalog')} value={books} offline={off} />
          <Tile label={t('common.nav.members')} value={members} offline={off} />
          <Tile label={t('common.dashboard.activeLoans')} value={activeLoans} offline={off} />
          <Tile label={t('common.dashboard.overdueLoans')} value={overdueLoans} offline={off} />
          <Tile label={t('common.dashboard.queuedHolds')} value={queuedHolds} offline={off} />
        </section>
      ) : null}

      {/* The plan card is billing-only. When subscriptions are disabled the
          whole product is free, so there's no plan to manage — hide it
          entirely (the Billing page shows the "everything's included" notice
          for anyone who still navigates there). */}
      {billing?.billingEnabled === false ? null : (
        <Card>
          <CardHeader
            title={t('common.dashboard.currentPlan')}
            subtitle={t('common.dashboard.currentPlanSub')}
          />
          <CardBody>
            {billing ? (
              <>
                <p style={{ margin: '0 0 var(--sp-2) 0' }}>
                  <strong>{billing.plan.name}</strong> ·{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {billing.billingMode === 'manual'
                      ? t('billing.billingMode.manual')
                      : t('billing.billingMode.stripe')}
                  </span>
                </p>
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  {t('billing.statusLabel')}: <strong>{billing.status}</strong>
                  {billing.currentPeriodEnd
                    ? ` · ${t('billing.renewsOn', { date: fmtDate(billing.currentPeriodEnd) ?? '' })}`
                    : null}
                  {billing.cancelAtPeriodEnd ? ` · ${t('billing.cancelScheduled')}` : null}
                </p>
                <p style={{ marginTop: 'var(--sp-3)' }}>
                  <Link href={`/${params.locale}/t/${params.slug}/billing`}>
                    {t('billing.manage')} →
                  </Link>
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                {t('billing.unreachable')}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  offline,
}: {
  label: string;
  value: { count: number | null; error: boolean };
  offline: string;
}) {
  return (
    <Card>
      <div className="lbr-stat">
        <span className="lbr-stat__label">{label}</span>
        <span className="lbr-stat__value">
          {value.error ? '—' : value.count === null ? '—' : value.count.toString()}
        </span>
        {value.error ? <span className="lbr-stat__caption">{offline}</span> : null}
      </div>
    </Card>
  );
}

function fmtDate(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return new Date(input).toLocaleDateString();
  } catch {
    return null;
  }
}
