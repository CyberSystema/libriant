import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api, type BillingSnapshot } from '@/lib/api';
import { BillingActions } from './BillingActions';
import { PlanGrid, type AvailablePlan } from './PlanGrid';

export default async function BillingPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  // Load both endpoints in parallel — both server-rendered so the page is
  // useful on first paint. Failures are local: if `/billing` is down we
  // can still show the plan grid; if `/plans` is down we still show the
  // current snapshot.
  const [snapshotResult, plansResult] = await Promise.allSettled([
    api<BillingSnapshot>(`/t/${params.slug}/billing`, { cookie }),
    api<{ plans: AvailablePlan[] }>(`/t/${params.slug}/billing/plans`, { cookie }),
  ]);

  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  const plans = plansResult.status === 'fulfilled' ? plansResult.value.plans : [];
  const errorMessage =
    snapshotResult.status === 'rejected'
      ? snapshotResult.reason instanceof ApiError
        ? snapshotResult.reason.message
        : t('common.states.error')
      : null;

  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(params.locale, { style: 'currency', currency }).format(cents / 100);
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(params.locale) : null;

  return (
    <>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />

      {errorMessage ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {errorMessage}
        </Banner>
      ) : null}

      {snapshot && snapshot.status === 'past_due' ? (
        <Banner severity="warning" title={t('billing.errors.paymentFailed')}>
          {snapshot.graceUntil
            ? `Your plan stays active until ${fmtDate(snapshot.graceUntil)}.`
            : null}
        </Banner>
      ) : null}

      {snapshot && snapshot.cancelAtPeriodEnd && snapshot.currentPeriodEnd ? (
        <Banner severity="info">
          {t('billing.cancelScheduled', { date: fmtDate(snapshot.currentPeriodEnd) ?? '' })}
        </Banner>
      ) : null}

      <Card style={{ marginTop: 'var(--sp-4)' }}>
        <CardHeader title={t('billing.currentPlan')} />
        <CardBody>
          {snapshot ? (
            <>
              <p style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>
                <strong>{snapshot.plan.name}</strong>
                {snapshot.billingMode === 'manual' ? (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 'var(--sp-2)' }}>
                    · {t('billing.billingMode.manual')}
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 'var(--sp-2)' }}>
                    · {t('billing.billingMode.stripe')}
                  </span>
                )}
              </p>
              <dl
                style={{
                  marginTop: 'var(--sp-4)',
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: 'var(--sp-2) var(--sp-5)',
                  fontSize: 'var(--fs-sm)',
                }}
              >
                <dt style={{ color: 'var(--color-text-muted)' }}>{t('billing.currentStatus')}</dt>
                <dd style={{ margin: 0 }}>
                  <strong>{snapshot.status}</strong>
                </dd>
                {snapshot.currentPeriodEnd ? (
                  <>
                    <dt style={{ color: 'var(--color-text-muted)' }}>Renews</dt>
                    <dd style={{ margin: 0 }}>{fmtDate(snapshot.currentPeriodEnd)}</dd>
                  </>
                ) : null}
                {snapshot.paidUntil ? (
                  <>
                    <dt style={{ color: 'var(--color-text-muted)' }}>Paid until</dt>
                    <dd style={{ margin: 0 }}>{fmtDate(snapshot.paidUntil)}</dd>
                  </>
                ) : null}
                {snapshot.graceUntil ? (
                  <>
                    <dt style={{ color: 'var(--color-text-muted)' }}>Grace ends</dt>
                    <dd style={{ margin: 0 }}>{fmtDate(snapshot.graceUntil)}</dd>
                  </>
                ) : null}
              </dl>
              {snapshot.billingMode === 'manual' ? (
                <p
                  style={{
                    marginTop: 'var(--sp-4)',
                    color: 'var(--color-text-muted)',
                    fontSize: 'var(--fs-sm)',
                  }}
                >
                  {t('billing.manualNotice')}
                </p>
              ) : (
                <div style={{ marginTop: 'var(--sp-4)' }}>
                  <BillingActions
                    slug={params.slug}
                    catalog={catalog}
                    locale={params.locale}
                    canOpenPortal={Boolean(snapshot.stripeCustomerId)}
                    hasPaidSubscription={Boolean(snapshot.stripeSubscriptionId)}
                    cancelAtPeriodEnd={snapshot.cancelAtPeriodEnd}
                  />
                </div>
              )}
            </>
          ) : (
            <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
              {t('common.states.error')}
            </p>
          )}
        </CardBody>
      </Card>

      <section style={{ marginTop: 'var(--sp-6)' }}>
        <h2 style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--sp-3)' }}>
          {t('billing.availablePlans')}
        </h2>
        <PlanGrid plans={plans} slug={params.slug} catalog={catalog} locale={params.locale} />
      </section>
    </>
  );
}
