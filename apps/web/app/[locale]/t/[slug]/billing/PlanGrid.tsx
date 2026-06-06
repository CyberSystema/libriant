'use client';
import * as React from 'react';
import { Button, Card, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

export type AvailablePlan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  billingMode: 'stripe' | 'manual';
  monthlyPriceCents: number;
  currency: string;
  hasStripePrice: boolean;
  isCurrent: boolean;
  sortOrder: number;
};

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
  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);

  async function upgrade(plan: AvailablePlan) {
    setBusy(plan.slug);
    try {
      const { url } = await api<{ url: string; sessionId: string }>(`/t/${slug}/billing/checkout`, {
        method: 'POST',
        body: { planSlug: plan.slug },
      });
      window.location.href = url;
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
      setBusy(null);
    }
  }

  if (!plans.length) {
    return (
      <p style={{ color: 'var(--color-text-muted)' }}>
        No plans are configured yet. Ask an admin to seed the plan catalog.
      </p>
    );
  }

  return (
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
                  Contract pricing
                </span>
              ) : isFree ? (
                <>{t('billing.free')}</>
              ) : (
                <>
                  {fmtMoney(plan.monthlyPriceCents, plan.currency)}
                  <span
                    style={{
                      fontSize: 'var(--fs-sm)',
                      fontWeight: 400,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {' '}
                    {t('billing.perMonth')}
                  </span>
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
                  Not bookable yet
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
  );
}
