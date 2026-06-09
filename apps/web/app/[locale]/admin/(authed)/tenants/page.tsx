import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';

export const dynamic = 'force-dynamic';

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  status: 'active' | 'paused' | 'archived';
  primaryEmail: string | null;
  createdAt: string;
  cellId: string;
  plan: { slug: string; name: string } | null;
  billingStatus: string | null;
  billingMode: string | null;
};

export default async function AdminTenantsPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  const qs = new URLSearchParams();
  if (searchParams.q) qs.set('q', searchParams.q);
  if (searchParams.status) qs.set('status', searchParams.status);
  if (searchParams.planSlug) qs.set('planSlug', searchParams.planSlug);

  let tenants: TenantRow[] = [];
  let billingEnabled: boolean | null = null;
  let error: string | null = null;
  try {
    const [tRes, sRes] = await Promise.all([
      api<{ tenants: TenantRow[] }>(`/admin/tenants?${qs.toString()}`, { cookie }),
      api<{ billingEnabled: boolean }>('/admin/subscriptions', { cookie }).catch(() => ({
        billingEnabled: null as boolean | null,
      })),
    ]);
    tenants = tRes.tenants;
    billingEnabled = sRes.billingEnabled;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }
  // Treat unknown (fetch failed) as "on" so we don't hide columns on a glitch.
  const subsOn = billingEnabled !== false;

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Metadata-only view. Tenant data requires a redeemed support key (coming in Step 18a)."
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      {billingEnabled === false ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
          <strong>Subscriptions are off.</strong> Every library has unlimited access — no plans or
          limits — so plan &amp; billing columns are hidden. Turn them on in{' '}
          <Link href="/admin/subscriptions">Subscriptions</Link>.
        </Banner>
      ) : null}

      <form
        method="get"
        style={{
          display: 'flex',
          gap: 'var(--sp-2)',
          marginBottom: 'var(--sp-4)',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="search"
          name="q"
          defaultValue={searchParams.q ?? ''}
          placeholder="Search slug / name / email…"
          className="lbr-input"
          style={{ maxWidth: 280 }}
        />
        <select
          name="status"
          defaultValue={searchParams.status ?? ''}
          className="lbr-input"
          style={{ maxWidth: 160 }}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
        {subsOn ? (
          <select
            name="planSlug"
            defaultValue={searchParams.planSlug ?? ''}
            className="lbr-input"
            style={{ maxWidth: 200 }}
          >
            <option value="">Any plan</option>
            <option value="starter">Starter</option>
            <option value="community">Community</option>
            <option value="municipal">Municipal</option>
            <option value="institutional">Institutional</option>
            <option value="on-prem-enterprise">On-prem / Enterprise</option>
          </select>
        ) : null}
        <button type="submit" className="lbr-btn lbr-btn--secondary lbr-btn--md">
          Filter
        </button>
      </form>

      {tenants.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No tenants match.</p>
      ) : (
        <table className="lbr-table">
          <thead>
            <tr>
              <th>Library</th>
              {subsOn ? <th>Plan</th> : null}
              {subsOn ? <th>Billing</th> : null}
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link href={`/admin/tenants/${t.id}`}>
                    <strong>{t.name}</strong>
                  </Link>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {t.slug} · {t.primaryEmail ?? '—'}
                  </div>
                </td>
                {subsOn ? (
                  <td>
                    {t.plan ? (
                      t.plan.name
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    )}
                  </td>
                ) : null}
                {subsOn ? (
                  <td>
                    {t.billingStatus ?? '—'}
                    {t.billingMode ? (
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                        {t.billingMode === 'manual' ? 'Manual / invoice' : 'Self-serve (card)'}
                      </div>
                    ) : null}
                  </td>
                ) : null}
                <td>{t.status}</td>
                <td>{new Date(t.createdAt).toLocaleDateString(params.locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
