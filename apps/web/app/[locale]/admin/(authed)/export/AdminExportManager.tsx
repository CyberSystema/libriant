'use client';
import * as React from 'react';
import { Button, Card, CardBody, CardHeader, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { dataPort } from '@/lib/ports';

type Format = 'csv' | 'json' | 'xlsx' | 'sql';
type Scope = 'tenant' | 'control' | 'all';
type Status = 'queued' | 'running' | 'completed' | 'failed';

export type ExportJobView = {
  id: string;
  format: Format;
  scope: Scope;
  targetTenantId: string | null;
  status: Status;
  progressDone: number;
  progressTotal: number;
  fileName: string | null;
  fileBytes: number | null;
  error: string | null;
  createdAt: string;
};

export type TenantLite = { id: string; slug: string; name: string };

const FORMATS: Format[] = ['csv', 'json', 'xlsx', 'sql'];
const FORMAT_LABEL: Record<Format, string> = {
  csv: 'CSV (zip)',
  json: 'JSON',
  xlsx: 'Excel (.xlsx)',
  sql: 'SQL dump',
};

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AdminExportManager({
  initial,
  tenants,
}: {
  initial: ExportJobView[];
  tenants: TenantLite[];
}) {
  const toast = useToast();
  const [exports, setExports] = React.useState(initial);
  const [format, setFormat] = React.useState<Format>('xlsx');
  const [scope, setScope] = React.useState<Scope>('tenant');
  const [tenantId, setTenantId] = React.useState<string>(tenants[0]?.id ?? '');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const active = exports.some((e) => e.status === 'queued' || e.status === 'running');
    if (!active) return;
    const id = setInterval(async () => {
      try {
        const res = await api<{ exports: ExportJobView[] }>('/admin/exports');
        setExports(res.exports);
      } catch {
        /* keep last known */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [exports]);

  const tenantSlug = (id: string | null) =>
    id ? (tenants.find((t) => t.id === id)?.slug ?? id) : null;

  async function create() {
    if (scope === 'tenant' && !tenantId) {
      toast.show({ severity: 'critical', title: 'Pick a library.' });
      return;
    }
    if (scope === 'all' && !window.confirm('Export EVERY library + the control DB?')) return;
    setBusy(true);
    try {
      const res = await api<{ export: ExportJobView }>('/admin/exports', {
        method: 'POST',
        body: { format, scope, tenantId: scope === 'tenant' ? tenantId : undefined },
      });
      setExports((prev) => [res.export, ...prev]);
      toast.show({ severity: 'success', title: 'Export started.' });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Could not start the export.',
      });
    } finally {
      setBusy(false);
    }
  }

  const scopeLabel = (e: ExportJobView) =>
    e.scope === 'tenant' ? `library: ${tenantSlug(e.targetTenantId)}` : e.scope;

  return (
    <>
      <Card style={{ marginBottom: 'var(--sp-5)' }}>
        <CardHeader title="New export" />
        <CardBody>
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-4)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.currentTarget.value as Scope)}
                className="lbr-input"
              >
                <option value="tenant">A specific library</option>
                <option value="control">Control DB (system)</option>
                <option value="all">Everything (control + all libraries)</option>
              </select>
            </label>

            {scope === 'tenant' ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>Library</span>
                <select
                  value={tenantId}
                  onChange={(e) => setTenantId(e.currentTarget.value)}
                  className="lbr-input"
                >
                  {tenants.length === 0 ? <option value="">No libraries</option> : null}
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.slug} — {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>Format</span>
              <select
                value={format}
                onChange={(e) => setFormat(e.currentTarget.value as Format)}
                className="lbr-input"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>

            <Button variant="primary" onClick={create} loading={busy}>
              Create export
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Recent exports"
          subtitle="Files are kept ~1 day. Auto-refreshes while building."
        />
        <CardBody>
          {exports.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>No exports yet.</p>
          ) : (
            <div className="lbr-table-wrap">
              <table className="lbr-table">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Format</th>
                    <th>Status</th>
                    <th>Size</th>
                    <th>Created</th>
                    <th>Download</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((e) => (
                    <tr key={e.id}>
                      <td>{scopeLabel(e)}</td>
                      <td>{FORMAT_LABEL[e.format]}</td>
                      <td>
                        {e.status}
                        {e.status === 'running' && e.progressTotal > 0
                          ? ` (${e.progressDone}/${e.progressTotal})`
                          : ''}
                        {e.status === 'failed' && e.error ? (
                          <div style={{ color: 'var(--color-danger)', fontSize: 'var(--fs-xs)' }}>
                            {e.error}
                          </div>
                        ) : null}
                      </td>
                      <td>{fmtBytes(e.fileBytes)}</td>
                      <td>{new Date(e.createdAt).toLocaleString()}</td>
                      <td>
                        {e.status === 'completed' ? (
                          <a
                            href={dataPort().resourceUrl(`/admin/exports/${e.id}/download`)}
                            className="lbr-btn lbr-btn--secondary lbr-btn--sm"
                          >
                            Download
                          </a>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}
