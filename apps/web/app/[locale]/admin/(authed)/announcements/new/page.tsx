import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { AnnouncementComposer } from './AnnouncementComposer';

export const dynamic = 'force-dynamic';

type TenantRow = { id: string; slug: string; name: string };
type PlanRow = { slug: string; name: string };

export default async function NewAnnouncementPage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let tenants: TenantRow[] = [];
  let plans: PlanRow[] = [];
  let allTags: string[] = [];
  let error: string | null = null;
  try {
    const [tRes, pRes] = await Promise.all([
      api<{ tenants: TenantRow[] }>('/admin/tenants?limit=200', { cookie }),
      api<{ plans: PlanRow[] }>('/admin/plans', { cookie }),
    ]);
    tenants = tRes.tenants;
    plans = pRes.plans;
    // Aggregate distinct tags via successive lookups — tag list is small;
    // a dedicated /admin/tags endpoint is overkill for MVP.
    const seen = new Set<string>();
    await Promise.all(
      tenants.slice(0, 50).map(async (t) => {
        try {
          const r = await api<{ knownTags: string[] }>(`/admin/tenants/${t.id}/tags`, { cookie });
          for (const tag of r.knownTags) seen.add(tag);
        } catch {
          // Tag lookup is a hint, not a requirement.
        }
      }),
    );
    allTags = Array.from(seen).sort();
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader title="New announcement" subtitle="Compose, target, and publish." />
      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}
      <AnnouncementComposer
        locale={params.locale}
        tenants={tenants}
        plans={plans}
        knownTags={allTags}
      />
    </>
  );
}
