'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Asset, Button, Card, PoweredBy, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import type { AvailablePlan } from './billing/PlanGrid';

type Props = {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  plans: AvailablePlan[];
  libraryName: string;
};

/**
 * Forced full-page plan chooser. Rendered by the tenant layout (in place of
 * the normal shell, like SystemModeTakeover) when subscriptions are enabled
 * but the library hasn't chosen a plan yet — so there's no redirect loop and
 * nothing in the library is reachable until a plan is picked.
 *
 *   - Free plans  → POST /billing/select  (records the choice, no Stripe)
 *   - Paid plans  → POST /billing/checkout → Stripe Checkout (payment method)
 *   - Manual plans → contact us (admin sets those up by invoice)
 */
export function ChoosePlanScreen({ slug, locale, catalog, plans, libraryName }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);

  function fail(err: unknown) {
    toast.show({
      severity: 'critical',
      title: err instanceof ApiError ? err.message : t('common.states.error'),
    });
    setBusy(null);
  }

  async function choose(plan: AvailablePlan) {
    setBusy(plan.slug);
    try {
      if (plan.monthlyPriceCents === 0) {
        // Free plan: record the choice; the gate clears on refresh.
        await api(`/t/${slug}/billing/select`, { method: 'POST', body: { planSlug: plan.slug } });
        router.refresh();
        return;
      }
      // Paid plan: off to Stripe Checkout to capture a payment method.
      const { url } = await api<{ url: string; sessionId: string }>(`/t/${slug}/billing/checkout`, {
        method: 'POST',
        body: { planSlug: plan.slug },
      });
      window.location.href = url;
    } catch (err) {
      fail(err);
    }
  }

  const hasPaid = plans.some((p) => p.monthlyPriceCents > 0 && p.billingMode === 'stripe');

  return (
    <main className="lbr-choose-shell">
      <div className="lbr-choose">
        <div className="lbr-choose__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-choose__title">{t('billing.chooser.title')}</h1>
        <p className="lbr-choose__subtitle">
          {t('billing.chooser.subtitle', { library: libraryName })}
        </p>

        {plans.length === 0 ? (
          <Card style={{ marginTop: 'var(--sp-5)' }}>
            <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
              {t('billing.chooser.empty')}
            </p>
          </Card>
        ) : (
          <div className="lbr-choose__grid">
            {plans.map((plan) => {
              const isFree = plan.monthlyPriceCents === 0;
              const isManual = plan.billingMode === 'manual';
              const bookable = isFree || (plan.billingMode === 'stripe' && plan.hasStripePrice);
              return (
                <Card key={plan.id} variant="outlined" className="lbr-choose__card">
                  <h3 style={{ marginTop: 0 }}>{plan.name}</h3>
                  <p className="lbr-choose__price">
                    {isManual ? (
                      <span style={{ fontSize: 'var(--fs-lg)', color: 'var(--color-text-muted)' }}>
                        {t('billing.billingMode.manual')}
                      </span>
                    ) : isFree ? (
                      <>{t('billing.free')}</>
                    ) : (
                      <>
                        {fmtMoney(plan.monthlyPriceCents, plan.currency)}
                        <span className="lbr-choose__per"> {t('billing.perMonth')}</span>
                      </>
                    )}
                  </p>
                  {plan.description ? <p className="lbr-choose__desc">{plan.description}</p> : null}
                  <div style={{ marginTop: 'auto', paddingTop: 'var(--sp-3)' }}>
                    {isManual ? (
                      <a
                        href="mailto:hello@libriant.com"
                        className="lbr-btn lbr-btn--secondary lbr-btn--md"
                        style={{ width: '100%', textDecoration: 'none' }}
                      >
                        {t('billing.actions.contactSales')}
                      </a>
                    ) : !bookable ? (
                      <Button variant="secondary" disabled style={{ width: '100%' }}>
                        {t('billing.chooser.notBookable')}
                      </Button>
                    ) : (
                      <Button
                        variant={isFree ? 'secondary' : 'primary'}
                        style={{ width: '100%' }}
                        loading={busy === plan.slug}
                        disabled={busy !== null && busy !== plan.slug}
                        onClick={() => choose(plan)}
                      >
                        {isFree
                          ? t('billing.chooser.choose', { plan: plan.name })
                          : t('billing.chooser.subscribe', { plan: plan.name })}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {hasPaid ? <p className="lbr-choose__hint">{t('billing.chooser.paidHint')}</p> : null}

        <div className="lbr-choose__footer">
          <PoweredBy />
        </div>
      </div>
    </main>
  );
}
