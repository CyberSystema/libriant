import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { currentAdminSession, requestCookieHeader } from '@/lib/admin-session';
import { OverridesEditor } from './OverridesEditor';
import { AdminBillingActions } from './AdminBillingActions';
import { TenantTagsEditor } from './TenantTagsEditor';
import { TenantSystemModePanel } from './TenantSystemModePanel';
import { LibraryStatusControl } from './LibraryStatusControl';
import { DeleteTenantButton } from './DeleteTenantButton';

export const dynamic = 'force-dynamic';

type TenantDetail = {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  status: string;
  primaryEmail: string | null;
  customSubdomain: string | null;
  cellId: string;
  dbUrl: string;
  storageUrl: string;
  createdAt: string;
  subscription: {
    status: string;
    billingMode: 'stripe' | 'manual';
    currentPeriodEnd: string | null;
    paidUntil: string | null;
    graceUntil: string | null;
    cancelAtPeriodEnd: boolean;
    plan: { id: string; slug: string; name: string; monthlyPriceCents: number; currency: string };
  } | null;
  billingAccount: {
    billingEmail: string;
    billingName: string;
    stripeCustomerId: string | null;
    country: string | null;
  } | null;
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

type Override = {
  id: string;
  featureKey: string;
  valueInt: number | null;
  valueBool: boolean | null;
  valueText: string | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
};

type Plan = {
  id: string;
  slug: string;
  name: string;
  values: Array<{
    featureKey: string;
    valueInt: number | null;
    valueBool: boolean | null;
    valueText: string | null;
  }>;
};

export default async function AdminTenantDetailPage(props: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();
  // Pause/resume is owner-only at the endpoint (`@AdminRoles('owner')`). A
  // support admin gets the state and the reason they cannot change it, rather
  // than a button that 403s.
  const admin = await currentAdminSession();

  let tenant: TenantDetail | null = null;
  let fetchError: string | null = null;
  try {
    const res = await api<{ tenant: TenantDetail }>(`/admin/tenants/${params.id}`, { cookie });
    tenant = res.tenant;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  type ActiveModeRow = {
    id: string;
    scope: 'global' | 'tenant';
    tenant: { id: string } | null;
    mode: 'normal' | 'maintenance' | 'read_only' | 'out_of_order' | 'under_construction';
    messageMarkdown: string | null;
    endsAt: string | null;
    endedAt: string | null;
    allowAdminBypass: boolean;
  };
  // Fetch features + overrides + plans + tags + active system mode windows +
  // the global subscriptions switch (so we can say whether limits are enforced).
  const [{ features }, { overrides }, { plans }, tagsPayload, currentMode, subsStatus] =
    await Promise.all([
      api<{ features: Feature[] }>('/admin/feature-keys', { cookie }).catch(() => ({
        features: [] as Feature[],
      })),
      api<{ overrides: Override[] }>(`/admin/tenants/${params.id}/overrides`, { cookie }).catch(
        () => ({ overrides: [] as Override[] }),
      ),
      api<{ plans: Plan[] }>('/admin/plans', { cookie }).catch(() => ({ plans: [] as Plan[] })),
      api<{ tags: string[]; knownTags: string[] }>(`/admin/tenants/${params.id}/tags`, {
        cookie,
      }).catch(() => ({ tags: [], knownTags: [] })),
      api<{ active: ActiveModeRow[] }>('/admin/system-mode/current', { cookie }).catch(() => ({
        active: [] as ActiveModeRow[],
      })),
      api<{ billingEnabled: boolean }>('/admin/subscriptions', { cookie }).catch(() => ({
        billingEnabled: null as boolean | null,
      })),
    ]);
  const billingEnabled = subsStatus.billingEnabled;
  const tenantSystemEvent =
    currentMode.active.find((e) => e.scope === 'tenant' && e.tenant?.id === params.id) ?? null;

  if (!tenant) {
    return (
      <>
        <PageHeader title="Tenant" />
        <Banner severity="critical">{fetchError ?? 'Something went wrong.'}</Banner>
      </>
    );
  }

  const currentPlan = tenant.subscription
    ? plans.find((p) => p.id === tenant!.subscription!.plan.id)
    : null;

  return (
    <>
      <PageHeader
        title={tenant.name}
        subtitle={`${tenant.slug} · ${tenant.cellId}`}
        trail={
          <Link href={`/admin/tenants`} style={{ color: 'inherit' }}>
            ← Tenants
          </Link>
        }
      />

      <div className="lbr-split">
        <div>
          {billingEnabled === false ? (
            <Card style={{ marginBottom: 'var(--sp-4)' }}>
              <CardHeader title="Subscriptions are off" />
              <CardBody>
                <p style={{ marginTop: 0 }}>
                  This library has <strong>unlimited access</strong> — no plan limits apply and
                  there&apos;s no billing.
                </p>
                <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
                  Plans and limits only take effect when you turn subscriptions on globally in{' '}
                  <Link href="/admin/subscriptions">Subscriptions</Link>.
                </p>
              </CardBody>
            </Card>
          ) : (
            <>
              <Card style={{ marginBottom: 'var(--sp-4)' }}>
                <CardHeader title="Subscription" />
                <CardBody>
                  {tenant.subscription ? (
                    <dl className="lbr-dl">
                      <dt>Plan</dt>
                      <dd>
                        <strong>{tenant.subscription.plan.name}</strong>
                      </dd>
                      <dt>Billing mode</dt>
                      <dd>
                        {tenant.subscription.billingMode === 'manual'
                          ? 'Manual / invoice'
                          : 'Stripe'}
                      </dd>
                      <dt>Status</dt>
                      <dd>{tenant.subscription.status}</dd>
                      {tenant.subscription.currentPeriodEnd ? (
                        <>
                          <dt>Period ends</dt>
                          <dd>
                            {new Date(tenant.subscription.currentPeriodEnd).toLocaleDateString(
                              params.locale,
                            )}
                          </dd>
                        </>
                      ) : null}
                      {tenant.subscription.paidUntil ? (
                        <>
                          <dt>Paid until</dt>
                          <dd>
                            {new Date(tenant.subscription.paidUntil).toLocaleDateString(
                              params.locale,
                            )}
                          </dd>
                        </>
                      ) : null}
                      {tenant.subscription.graceUntil ? (
                        <>
                          <dt>Grace ends</dt>
                          <dd>
                            {new Date(tenant.subscription.graceUntil).toLocaleDateString(
                              params.locale,
                            )}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  ) : (
                    <p>No subscription on file.</p>
                  )}
                  {tenant.subscription ? (
                    <div style={{ marginTop: 'var(--sp-4)' }}>
                      <AdminBillingActions
                        tenantId={tenant.id}
                        plans={plans}
                        billingMode={tenant.subscription.billingMode}
                      />
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Feature overrides"
                  subtitle="Per-tenant ceiling above what the plan provides. Empty rows fall back to the plan value, then the catalog default."
                />
                <CardBody>
                  <OverridesEditor
                    tenantId={tenant.id}
                    features={features}
                    overrides={overrides}
                    plan={currentPlan ?? null}
                    locale={params.locale}
                  />
                </CardBody>
              </Card>
            </>
          )}
        </div>

        <div>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader title="Metadata" />
            <CardBody>
              <dl className="lbr-dl">
                <dt>Status</dt>
                <dd>{tenant.status}</dd>
                <dt>Primary email</dt>
                <dd>{tenant.primaryEmail ?? '—'}</dd>
                <dt>Custom subdomain</dt>
                <dd>{tenant.customSubdomain ?? '—'}</dd>
                <dt>Cell</dt>
                <dd>{tenant.cellId}</dd>
                <dt>Default locale</dt>
                <dd>{tenant.defaultLocale}</dd>
                <dt>Created</dt>
                <dd>{new Date(tenant.createdAt).toLocaleDateString(params.locale)}</dd>
              </dl>
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title="Access"
              subtitle="Pause this library for abuse, non-payment, or because the library asked us to stop processing. Reversible; nothing is deleted."
            />
            <CardBody>
              <LibraryStatusControl
                tenantId={tenant.id}
                slug={tenant.slug}
                name={tenant.name}
                status={tenant.status}
                canPause={admin?.role === 'owner'}
              />
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title="Tags"
              subtitle="Free-form labels used to target announcements and system-mode events."
            />
            <CardBody>
              <TenantTagsEditor
                tenantId={tenant.id}
                initialTags={tagsPayload.tags}
                initialKnownTags={tagsPayload.knownTags}
              />
            </CardBody>
          </Card>

          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardHeader
              title="Tenant mode"
              subtitle="Isolate this library — read-only during a migration, maintenance during an incident."
            />
            <CardBody>
              <TenantSystemModePanel
                tenantId={tenant.id}
                initialActive={
                  tenantSystemEvent
                    ? {
                        id: tenantSystemEvent.id,
                        mode: tenantSystemEvent.mode,
                        endsAt: tenantSystemEvent.endsAt,
                        endedAt: tenantSystemEvent.endedAt,
                        messageMarkdown: tenantSystemEvent.messageMarkdown,
                        allowAdminBypass: tenantSystemEvent.allowAdminBypass,
                      }
                    : null
                }
              />
            </CardBody>
          </Card>

          {billingEnabled !== false && tenant.billingAccount ? (
            <Card>
              <CardHeader title="Billing account" />
              <CardBody>
                <dl className="lbr-dl">
                  <dt>Email</dt>
                  <dd>{tenant.billingAccount.billingEmail}</dd>
                  <dt>Name</dt>
                  <dd>{tenant.billingAccount.billingName}</dd>
                  <dt>Stripe</dt>
                  <dd>
                    {tenant.billingAccount.stripeCustomerId ? (
                      <code style={{ fontFamily: 'var(--font-mono)' }}>
                        {tenant.billingAccount.stripeCustomerId}
                      </code>
                    ) : (
                      '—'
                    )}
                  </dd>
                  {tenant.billingAccount.country ? (
                    <>
                      <dt>Country</dt>
                      <dd>{tenant.billingAccount.country}</dd>
                    </>
                  ) : null}
                </dl>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <Card style={{ marginTop: 'var(--sp-6)', borderColor: 'var(--color-danger)' }}>
        <CardHeader
          title="Danger zone"
          subtitle="Permanently delete this library. This drops its database and every record it holds — there is no undo."
        />
        <CardBody>
          <DeleteTenantButton tenantId={tenant.id} slug={tenant.slug} name={tenant.name} />
        </CardBody>
      </Card>
    </>
  );
}
