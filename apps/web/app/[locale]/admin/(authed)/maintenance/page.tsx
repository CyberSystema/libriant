import { notFound } from 'next/navigation';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { MaintenancePanel, type MaintenanceRun, type TenantLite } from './MaintenancePanel';

export const dynamic = 'force-dynamic';

export default async function AdminMaintenancePage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let runs: MaintenanceRun[] = [];
  let tenants: TenantLite[] = [];
  let error: string | null = null;
  try {
    const [r, t] = await Promise.all([
      api<{ runs: MaintenanceRun[] }>('/admin/maintenance', { cookie }),
      api<{ tenants: TenantLite[] }>('/admin/maintenance/tenants', { cookie }),
    ]);
    runs = r.runs;
    tenants = t.tenants;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Maintenance"
        subtitle="Diagnose and repair the platform: scan for issues, apply schema migrations, run integrity fixers, and VACUUM — per library, the control DB, or everything at once."
        help={
          <HelpButton title="Maintenance tools">
            <h3>Diagnostics scan</h3>
            <p>
              Read-only. Flags unreachable databases, unapplied migrations, orphaned databases (a DB
              with no tenant row), and missing <code>tenant_settings</code> rows.
            </p>
            <h3>Run migrations (&ldquo;restructure&rdquo;)</h3>
            <p>
              Applies pending Prisma schema migrations to a library DB, the control DB, or all of
              them. Idempotent — re-running when there&apos;s nothing pending is a no-op.
            </p>
            <h3>Integrity fixers</h3>
            <p>
              Re-seeds a missing <code>tenant_settings</code> row and rebuilds the effective-plan
              cache. Use after the scan reports those.
            </p>
            <h3>VACUUM (ANALYZE)</h3>
            <p>Postgres bloat cleanup + planner-stats refresh. No schema or data change.</p>
            <p>
              Every task runs as a background job on the worker; this page polls its progress and
              results.
            </p>
          </HelpButton>
        }
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      <MaintenancePanel initialRuns={runs} tenants={tenants} />
    </>
  );
}
