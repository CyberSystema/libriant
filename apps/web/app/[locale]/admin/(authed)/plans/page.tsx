import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';

export const dynamic = 'force-dynamic';

type Plan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  billingMode: 'stripe' | 'manual';
  monthlyPriceCents: number;
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
  try {
    const res = await api<{ plans: Plan[] }>('/admin/plans', { cookie });
    plans = res.plans;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(params.locale, { style: 'currency', currency }).format(cents / 100);

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

      <table className="lbr-table">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Mode</th>
            <th>Price</th>
            <th>Features</th>
            <th>Public</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
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
              <td>{fmtMoney(p.monthlyPriceCents, p.currency)}</td>
              <td>{p.values.length}</td>
              <td>{p.isPublic ? '✓' : '—'}</td>
              <td>{p.isActive ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
