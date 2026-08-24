'use client';
import * as React from 'react';
import { Button, Card, useToast } from '@libriant/ui';
import type { Catalog, Locale, Translator } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

export type AvailablePlan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  billingMode: 'stripe' | 'manual';
  monthlyPriceCents: number;
  /** Null when the plan is not offered annually. Ten months for twelve. */
  annualPriceCents: number | null;
  hasStripeAnnualPrice: boolean;
  currency: string;
  hasStripePrice: boolean;
  isCurrent: boolean;
  sortOrder: number;
};

export type Cadence = 'month' | 'year';

/**
 * The cadence a card can actually charge, which is not always the one the
 * reader picked. A plan may carry an annual price with no Stripe Price object
 * behind it — a half-configured plan — and Checkout would reject it. Fall back
 * to monthly rather than render a button that 400s.
 */
export function bookableCadence(plan: AvailablePlan, wanted: Cadence): Cadence {
  return wanted === 'year' && plan.annualPriceCents != null && plan.hasStripeAnnualPrice
    ? 'year'
    : 'month';
}

/** True when at least one plan on offer is worth showing the toggle for. */
export function anyAnnual(plans: AvailablePlan[]): boolean {
  return plans.some((p) => p.annualPriceCents != null && p.hasStripeAnnualPrice);
}

/**
 * Monthly or yearly, chosen by the library rather than by us. Annual is the
 * default because it is what Greek public buyers contract on, but a library
 * whose budget line is monthly must be able to say so.
 */
export function CadenceToggle({
  value,
  onChange,
  t,
}: {
  value: Cadence;
  onChange: (next: Cadence) => void;
  t: Translator;
}) {
  return (
    <div
      role="group"
      aria-label={t('billing.cadenceLabel')}
      style={{
        display: 'flex',
        gap: 'var(--sp-2)',
        marginBottom: 'var(--sp-4)',
        flexWrap: 'wrap',
      }}
    >
      {(['year', 'month'] as const).map((c) => (
        <Button
          key={c}
          type="button"
          size="sm"
          variant={value === c ? 'primary' : 'secondary'}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
        >
          {c === 'year' ? t('billing.chooseAnnual') : t('billing.chooseMonthly')}
        </Button>
      ))}
    </div>
  );
}

type Props = {
  plans: AvailablePlan[];
  slug: string;
  catalog: Catalog;
  locale: Locale;
};

/**
 * Grid of plan cards. The current plan is flagged "you are here" and its
 * primary action is disabled. Stripe-billed plans show "Switch to X" →
 * POST to `/billing/checkout` → redirect to the returned Stripe URL.
 * Manual plans show "Contact us" — the librarian leaves the self-serve
 * flow and we (admin) flip them on via `/admin/billing/.../set-plan`.
 */
export function PlanGrid({ plans, slug, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [cadence, setCadence] = React.useState<Cadence>('year');
  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);

  async function upgrade(plan: AvailablePlan) {
    setBusy(plan.slug);
    try {
      const { url } = await api<{ url: string; sessionId: string }>(`/t/${slug}/billing/checkout`, {
        method: 'POST',
        // Charge the cadence the card is showing, not the one the reader asked
        // for — those differ on a plan with no annual price. Send the wrong one
        // and the card quotes 790 € while Stripe bills 79 €.
        body: { planSlug: plan.slug, interval: bookableCadence(plan, cadence) },
      });
      window.location.href = url;
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
      setBusy(null);
    }
  }

  if (!plans.length) {
    return <p style={{ color: 'var(--color-text-muted)' }}>{t('billing.noPlans')}</p>;
  }

  return (
    <>
      {anyAnnual(plans) ? <CadenceToggle value={cadence} onChange={setCadence} t={t} /> : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--sp-4)',
        }}
      >
        {plans.map((plan) => {
          const isFree = plan.monthlyPriceCents === 0;
          const isManual = plan.billingMode === 'manual';
          const isCurrent = plan.isCurrent;
          // Not `cadence` directly: a plan with no annual price stays monthly
          // however the toggle is set, and its card must say so.
          const annual = bookableCadence(plan, cadence) === 'year';
          return (
            <Card
              key={plan.id}
              variant={isCurrent ? 'elevated' : 'outlined'}
              style={{
                outline: isCurrent ? '2px solid var(--color-primary)' : undefined,
                outlineOffset: isCurrent ? 2 : undefined,
              }}
            >
              <h3 style={{ marginTop: 0 }}>{plan.name}</h3>
              <p
                style={{
                  fontSize: 'var(--fs-2xl)',
                  margin: '0 0 var(--sp-2) 0',
                  fontWeight: 600,
                }}
              >
                {isManual ? (
                  <span style={{ fontSize: 'var(--fs-lg)', color: 'var(--color-text-muted)' }}>
                    {t('billing.contractPricing')}
                  </span>
                ) : isFree ? (
                  <>{t('billing.free')}</>
                ) : (
                  <>
                    {fmtMoney(
                      annual
                        ? (plan.annualPriceCents ?? plan.monthlyPriceCents)
                        : plan.monthlyPriceCents,
                      plan.currency,
                    )}
                    <span
                      style={{
                        fontSize: 'var(--fs-sm)',
                        fontWeight: 400,
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      {' '}
                      {annual ? t('billing.perYear') : t('billing.perMonth')}
                    </span>
                    {/* The other cadence, so the saving is visible without
                        flipping the toggle to work it out. */}
                    {plan.annualPriceCents != null && plan.hasStripeAnnualPrice ? (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--fs-sm)',
                          fontWeight: 400,
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {annual
                          ? t('billing.orPerMonth', {
                              price: fmtMoney(plan.monthlyPriceCents, plan.currency),
                            })
                          : t('billing.orPerYear', {
                              price: fmtMoney(plan.annualPriceCents, plan.currency),
                            })}{' '}
                        · {t('billing.twoMonthsFree')}
                      </span>
                    ) : null}
                  </>
                )}
              </p>
              {plan.description ? (
                <p
                  style={{
                    color: 'var(--color-text-muted)',
                    fontSize: 'var(--fs-sm)',
                    marginBottom: 'var(--sp-3)',
                  }}
                >
                  {plan.description}
                </p>
              ) : null}
              <div style={{ marginTop: 'var(--sp-3)' }}>
                {isCurrent ? (
                  <Button variant="ghost" disabled style={{ width: '100%' }}>
                    ✓ {t('billing.actions.youAreHere')}
                  </Button>
                ) : isManual ? (
                  <a
                    href="mailto:hello@libriant.com"
                    className="lbr-btn lbr-btn--secondary lbr-btn--md"
                    style={{ width: '100%', textDecoration: 'none' }}
                  >
                    {t('billing.actions.contactSales')}
                  </a>
                ) : !plan.hasStripePrice ? (
                  <Button variant="secondary" disabled style={{ width: '100%' }}>
                    {t('billing.chooser.notBookable')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    style={{ width: '100%' }}
                    loading={busy === plan.slug}
                    onClick={() => upgrade(plan)}
                  >
                    {t('billing.actions.switchTo', { plan: plan.name })}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
