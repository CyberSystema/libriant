import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { type PriceCatalogue, priceCatalogueFor, stripeStateBanner } from './price-catalogue';

export const dynamic = 'force-dynamic';

type Plan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  billingMode: 'stripe' | 'manual';
  monthlyPriceCents: number;
  annualPriceCents: number | null;
  currency: string;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
  values: Array<{ featureKey: string }>;
};

export default async function AdminPlansPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let plans: Plan[] = [];
  let error: string | null = null;
  let catalogue: PriceCatalogue | null = null;
  let catalogueError: string | null = null;
  try {
    // billing-10 / billing-14. Both endpoints, in parallel, and neither failure
    // hides the other: the plan list is still useful without the reconciliation
    // and vice versa.
    const [plansRes, catalogueRes] = await Promise.allSettled([
      api<{ plans: Plan[] }>('/admin/plans', { cookie }),
      api<PriceCatalogue>('/admin/billing/price-catalogue', { cookie }),
    ]);
    if (plansRes.status === 'fulfilled') plans = plansRes.value.plans;
    else throw plansRes.reason;
    if (catalogueRes.status === 'fulfilled') catalogue = catalogueRes.value;
    else {
      catalogueError =
        catalogueRes.reason instanceof ApiError
          ? catalogueRes.reason.message
          : 'The Stripe price catalogue could not be checked.';
    }
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(params.locale, { style: 'currency', currency }).format(cents / 100);

  const stripeState = stripeStateBanner(catalogue);
  const brokenPlans = catalogue?.plans.filter((p) => p.problems.length) ?? [];

  return (
    <>
      <PageHeader
        title="Plans"
        subtitle="Edit feature values per plan. Changes invalidate the EffectivePlan cache for every affected tenant."
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      {/*
        billing-14. `stripeReady` was computed for "the admin UI" and no page in
        apps/web read it, so an operator on a host that cannot charge saw a
        completely normal screen and found out when the Subscriptions toggle
        threw. This is the first consumer: it says so up front, on the screen
        where the price catalogue is configured, and it names the exact setting.

        It is not on the Subscriptions screen itself — that component is owned
        by another package; see the report's out_of_scope_files_needed for the
        banner it still needs.
      */}
      {stripeState ? (
        <Banner
          severity={stripeState.severity}
          title={stripeState.title}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          {stripeState.body}
        </Banner>
      ) : null}

      {catalogueError ? (
        <Banner severity="warning" style={{ marginBottom: 'var(--sp-4)' }}>
          {catalogueError} Prices below are shown unverified.
        </Banner>
      ) : null}

      {/*
        billing-10. The reconciliation used to be a curl command in a runbook —
        "the audit would report it afterwards, but only if someone runs the
        audit". It now runs on every visit to this page, and every plan row
        below carries its verdict.
      */}
      {catalogue && brokenPlans.length ? (
        <Banner
          severity="critical"
          title={`${brokenPlans.length} plan${brokenPlans.length === 1 ? '' : 's'} cannot be sold as configured`}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          <ul style={{ margin: 'var(--sp-2) 0 0 var(--sp-4)', padding: 0 }}>
            {brokenPlans.map((p) => (
              <li key={p.slug}>
                <strong>{p.slug}</strong> — {p.problems.join('; ')}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {catalogue && catalogue.ok ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
          Every active plan reconciles with Stripe (checked{' '}
          {new Date(catalogue.checkedAt).toLocaleString(params.locale)}).
        </Banner>
      ) : null}

      <div className="lbr-table-wrap">
        <table className="lbr-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Mode</th>
              <th>Price</th>
              <th>Stripe</th>
              <th>Features</th>
              <th>Public</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const audit = priceCatalogueFor(catalogue, p.slug);
              return (
                <tr key={p.id}>
                  <td>
                    <Link href={`/admin/plans/${p.slug}`}>
                      <strong>{p.name}</strong>
                    </Link>
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                      {p.slug}
                    </div>
                  </td>
                  <td>{p.billingMode === 'manual' ? 'Manual' : 'Stripe'}</td>
                  <td>
                    {fmtMoney(p.monthlyPriceCents, p.currency)}
                    {p.annualPriceCents != null ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {' · '}
                        {fmtMoney(p.annualPriceCents, p.currency)}/yr
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {!audit ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>not checked</span>
                    ) : audit.problems.length ? (
                      <span style={{ color: 'var(--color-danger, #b91c1c)' }}>
                        {audit.problems.length} problem
                        {audit.problems.length === 1 ? '' : 's'}
                      </span>
                    ) : audit.notes.length ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>not sold</span>
                    ) : (
                      <span style={{ color: 'var(--color-success, #15803d)' }}>✓ reconciled</span>
                    )}
                  </td>
                  <td>{p.values.length}</td>
                  <td>{p.isPublic ? '✓' : '—'}</td>
                  <td>{p.isActive ? '✓' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
