import { notFound } from 'next/navigation';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { AdminExportManager, type ExportJobView, type TenantLite } from './AdminExportManager';

export const dynamic = 'force-dynamic';

export default async function AdminExportPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let exports: ExportJobView[] = [];
  let tenants: TenantLite[] = [];
  let error: string | null = null;
  try {
    const [e, t] = await Promise.all([
      api<{ exports: ExportJobView[] }>('/admin/exports', { cookie }),
      api<{ tenants: TenantLite[] }>('/admin/exports/tenants', { cookie }),
    ]);
    exports = e.exports;
    tenants = t.tenants;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Export"
        subtitle="Dump a library's database, the control DB, or everything, to CSV / JSON / Excel / SQL — built in the background, then downloaded."
        help={
          <HelpButton title="About exports">
            <p>
              Each export runs as a background job on the worker and writes a file to the shared
              storage volume; this page polls progress and offers a download when it's ready.
            </p>
            <ul>
              <li>
                <strong>CSV</strong> — a zip with one CSV per table.
              </li>
              <li>
                <strong>JSON</strong> — one file, <code>{`{ table: rows }`}</code>.
              </li>
              <li>
                <strong>Excel</strong> — one workbook, a sheet per table.
              </li>
              <li>
                <strong>SQL dump</strong> — <code>pg_dump</code>, full-fidelity + restorable.
              </li>
            </ul>
            <p>Files are kept about a day. Binary columns are base64-encoded in CSV/JSON.</p>
          </HelpButton>
        }
      />
      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}
      <AdminExportManager initial={exports} tenants={tenants} />
    </>
  );
}
