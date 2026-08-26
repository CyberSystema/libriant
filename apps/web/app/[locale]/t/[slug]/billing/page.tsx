import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound, redirect } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api, type BillingSnapshot } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { BillingActions } from './BillingActions';
import { PlanGrid, type AvailablePlan } from './PlanGrid';
import { PlanUsage, type PlanUsageResponse } from './PlanUsage';

export default async function BillingPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  // Load all three endpoints in parallel — all server-rendered so the page is
  // useful on first paint. Failures are local: if `/billing` is down we
  // can still show the plan grid; if `/plans` is down we still show the
  // current snapshot.
  //
  // launch-readiness-17: `/plan/usage` is the third. It counts rows in the
  // library's own database, so it is the slowest of the three and the one most
  // worth loading alongside the others rather than after them. A failure here
  // silently drops the usage card — the page's job is the subscription, and a
  // library must still be able to fix a declined card on a day the counters
  // cannot be read.
  const [snapshotResult, plansResult, usageResult] = await Promise.allSettled([
    api<BillingSnapshot>(`/t/${params.slug}/billing`, { cookie }),
    api<{ plans: AvailablePlan[] }>(`/t/${params.slug}/billing/plans`, { cookie }),
    api<PlanUsageResponse>(`/t/${params.slug}/plan/usage`, { cookie }),
  ]);

  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  const plans = plansResult.status === 'fulfilled' ? plansResult.value.plans : [];
  const usage = usageResult.status === 'fulfilled' ? usageResult.value.usage : [];
  const errorMessage =
    snapshotResult.status === 'rejected'
      ? translateApiError(snapshotResult.reason, t, t('common.states.error'))
      : null;

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(params.locale) : null;

  // Subscriptions turned off globally → there's nothing to manage and we don't
  // want to imply a plan exists. The Billing nav item is hidden too; if someone
  // reaches this URL directly, send them back to the library home.
  if (snapshot?.billingEnabled === false) {
    redirect(`/${params.locale}/t/${params.slug}`);
  }

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
          {/* billing-17: this sentence carries the deadline for fixing a
              declined card, and it was the one string on the page that skipped
              the catalog — so the Greek library whose payment just failed read
              the headline in Greek and the date in English. */}
          {snapshot.graceUntil
            ? t('billing.errors.paymentFailedGrace', {
                date: fmtDate(snapshot.graceUntil) ?? '',
              })
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
                    <dt style={{ color: 'var(--color-text-muted)' }}>{t('billing.renewsLabel')}</dt>
                    <dd style={{ margin: 0 }}>{fmtDate(snapshot.currentPeriodEnd)}</dd>
                  </>
                ) : null}
                {snapshot.paidUntil ? (
                  <>
                    <dt style={{ color: 'var(--color-text-muted)' }}>{t('billing.paidUntil')}</dt>
                    <dd style={{ margin: 0 }}>{fmtDate(snapshot.paidUntil)}</dd>
                  </>
                ) : null}
                {snapshot.graceUntil ? (
                  <>
                    <dt style={{ color: 'var(--color-text-muted)' }}>{t('billing.graceEnds')}</dt>
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

      <PlanUsage usage={usage} catalog={catalog} locale={params.locale} />

      <section style={{ marginTop: 'var(--sp-6)' }}>
        <h2 style={{ fontSize: 'var(--fs-xl)', marginBottom: 'var(--sp-3)' }}>
          {t('billing.availablePlans')}
        </h2>
        <PlanGrid
          plans={plans}
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          // billing-11 round 2. The grid is rendered for EVERY tenant — the
          // `billingMode === 'manual'` test at line 119 only swaps
          // BillingActions for a static notice, it never hid the grid — so a
          // contract library needs the grid itself to know it is a contract
          // library. Defaults to 'stripe' when the snapshot call failed, which
          // is the self-serve behaviour we had before; `selectPlan` refuses a
          // contract move server-side regardless, so a failed read cannot turn
          // into a downgrade.
          tenantBillingMode={snapshot?.billingMode === 'manual' ? 'manual' : 'stripe'}
        />
      </section>
    </>
  );
}
