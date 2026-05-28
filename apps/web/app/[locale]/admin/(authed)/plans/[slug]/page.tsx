import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { PlanFeatureEditor } from './PlanFeatureEditor';

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
  stripePriceId: string | null;
  sortOrder: number;
  values: Array<{
    featureKey: string;
    valueInt: number | null;
    valueBool: boolean | null;
    valueText: string | null;
  }>;
};

type Feature = {
  key: string;
  type: 'integer' | 'boolean' | 'text';
  label: string;
  description: string;
  defaultInt: number | null;
  defaultBool: boolean | null;
  defaultText: string | null;
  unit: string | null;
  sortOrder: number;
};

export default async function AdminPlanDetailPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let plan: Plan | null = null;
  let fetchError: string | null = null;
  try {
    const res = await api<{ plan: Plan }>(`/admin/plans/${params.slug}`, { cookie });
    plan = res.plan;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  const { features } = await api<{ features: Feature[] }>('/admin/feature-keys', { cookie }).catch(
    () => ({ features: [] as Feature[] }),
  );

  if (!plan) {
    return (
      <>
        <PageHeader title="Plan" />
        <Banner severity="critical">{fetchError ?? 'Something went wrong.'}</Banner>
      </>
    );
  }

  const fmtMoney = (cents: number, currency: string) =>
    new Intl.NumberFormat(params.locale, { style: 'currency', currency }).format(cents / 100);

  return (
    <>
      <PageHeader
        title={plan.name}
        subtitle={plan.description ?? plan.slug}
        trail={
          <Link href={`/${params.locale}/admin/plans`} style={{ color: 'inherit' }}>
            ← Plans
          </Link>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gap: 'var(--sp-4)',
        }}
      >
        <Card>
          <CardHeader
            title="Feature values"
            subtitle="Override the catalog defaults for this plan. Empty rows fall back to the catalog default."
          />
          <CardBody>
            <PlanFeatureEditor planSlug={plan.slug} features={features} planValues={plan.values} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Plan metadata" />
          <CardBody>
            <dl className="lbr-dl">
              <dt>Slug</dt>
              <dd>
                <code style={{ fontFamily: 'var(--font-mono)' }}>{plan.slug}</code>
              </dd>
              <dt>Billing mode</dt>
              <dd>{plan.billingMode}</dd>
              <dt>Monthly price</dt>
              <dd>{fmtMoney(plan.monthlyPriceCents, plan.currency)}</dd>
              <dt>Stripe price id</dt>
              <dd>
                {plan.stripePriceId ? (
                  <code style={{ fontFamily: 'var(--font-mono)' }}>{plan.stripePriceId}</code>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Active</dt>
              <dd>{plan.isActive ? 'Yes' : 'No'}</dd>
              <dt>Public</dt>
              <dd>{plan.isPublic ? 'Yes' : 'No'}</dd>
              <dt>Sort order</dt>
              <dd>{plan.sortOrder}</dd>
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
