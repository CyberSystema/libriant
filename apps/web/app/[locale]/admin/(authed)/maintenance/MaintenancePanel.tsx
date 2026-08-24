'use client';
import * as React from 'react';
import { Banner, Button, Card, CardBody, CardHeader, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

export type MaintenanceKind = 'diagnostics' | 'migrate' | 'fix' | 'vacuum';
export type MaintenanceScope = 'tenant' | 'control' | 'all';
export type MaintenanceStatus = 'queued' | 'running' | 'completed' | 'failed';

type Issue = { severity: 'error' | 'warning' | 'info'; target: string; message: string };
type TargetResult = { target: string; ok: boolean; summary: string };
type RunResult = { issues?: Issue[]; checked?: number; results?: TargetResult[] };

export type MaintenanceRun = {
  id: string;
  kind: MaintenanceKind;
  scope: MaintenanceScope;
  targetTenantId: string | null;
  status: MaintenanceStatus;
  progressDone: number;
  progressTotal: number;
  resultJson: RunResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TenantLite = { id: string; slug: string; name: string };

const KINDS: { value: MaintenanceKind; label: string; blurb: string }[] = [
  {
    value: 'diagnostics',
    label: 'Diagnostics scan',
    blurb:
      'Read-only. Checks DB reachability, unapplied migrations, orphan databases, and missing settings rows.',
  },
  {
    value: 'migrate',
    label: 'Run migrations',
    blurb: 'Applies pending schema migrations. Idempotent — safe to re-run.',
  },
  {
    value: 'fix',
    label: 'Integrity fixers',
    blurb: 'Re-seeds a missing tenant_settings row and rebuilds the effective-plan cache.',
  },
  {
    value: 'vacuum',
    label: 'VACUUM (ANALYZE)',
    blurb: 'Postgres bloat + planner-stats maintenance. No schema or data change.',
  },
];

function statusColor(s: MaintenanceStatus): string {
  if (s === 'completed') return 'var(--color-success)';
  if (s === 'failed') return 'var(--color-danger)';
  if (s === 'running') return 'var(--color-primary)';
  return 'var(--color-text-muted)';
}

function sevColor(s: Issue['severity']): string {
  if (s === 'error') return 'var(--color-danger)';
  if (s === 'warning') return 'var(--color-warning-text)';
  return 'var(--color-text-muted)';
}

export function MaintenancePanel({
  initialRuns,
  tenants,
}: {
  initialRuns: MaintenanceRun[];
  tenants: TenantLite[];
}) {
  const toast = useToast();
  const [runs, setRuns] = React.useState(initialRuns);
  const [kind, setKind] = React.useState<MaintenanceKind>('diagnostics');
  const [scope, setScope] = React.useState<MaintenanceScope>('all');
  const [tenantId, setTenantId] = React.useState<string>(tenants[0]?.id ?? '');
  const [launching, setLaunching] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  // Poll while anything is queued/running.
  React.useEffect(() => {
    const active = runs.some((r) => r.status === 'queued' || r.status === 'running');
    if (!active) return;
    const id = setInterval(async () => {
      try {
        const res = await api<{ runs: MaintenanceRun[] }>('/admin/maintenance?limit=25');
        setRuns(res.runs);
      } catch {
        /* transient — keep last known */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [runs]);

  const tenantName = (id: string | null) =>
    id ? (tenants.find((t) => t.id === id)?.slug ?? id) : null;

  async function launch() {
    if (scope === 'tenant' && !tenantId) {
      toast.show({ severity: 'critical', title: 'Pick a library first.' });
      return;
    }
    if (scope === 'all' && !window.confirm(`Run “${kind}” across ALL tenant databases?`)) return;
    setLaunching(true);
    try {
      const res = await api<{ run: MaintenanceRun }>('/admin/maintenance', {
        method: 'POST',
        body: { kind, scope, tenantId: scope === 'tenant' ? tenantId : undefined },
      });
      setRuns((prev) => [res.run, ...prev]);
      toast.show({ severity: 'success', title: 'Maintenance run started.' });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Could not start the run.',
      });
    } finally {
      setLaunching(false);
    }
  }

  const activeKind = KINDS.find((k) => k.value === kind)!;

  return (
    <>
      <Card style={{ marginBottom: 'var(--sp-5)' }}>
        <CardHeader title="Run a maintenance task" />
        <CardBody>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--sp-2)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            {KINDS.map((k) => (
              <Button
                key={k.value}
                variant={kind === k.value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setKind(k.value)}
              >
                {k.label}
              </Button>
            ))}
          </div>

          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
            {activeKind.blurb}
          </p>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--sp-4)',
              alignItems: 'flex-end',
              marginTop: 'var(--sp-3)',
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 500 }}>Target</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.currentTarget.value as MaintenanceScope)}
                className="lbr-input"
              >
                <option value="control">Control DB (system)</option>
                <option value="tenant">A specific library</option>
                <option value="all">All libraries{kind !== 'fix' ? ' + control' : ''}</option>
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

            <Button variant="primary" onClick={launch} loading={launching}>
              Launch
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent runs" subtitle="Auto-refreshes while a run is in progress." />
        <CardBody>
          {runs.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>No runs yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              {runs.map((r) => (
                <div
                  key={r.id}
                  style={{
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--sp-3)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--sp-3)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong>{KINDS.find((k) => k.value === r.kind)?.label ?? r.kind}</strong>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                      {r.scope === 'tenant' ? `tenant: ${tenantName(r.targetTenantId)}` : r.scope}
                    </span>
                    <span
                      style={{
                        color: statusColor(r.status),
                        fontWeight: 600,
                        fontSize: 'var(--fs-sm)',
                      }}
                    >
                      {r.status}
                      {r.status === 'running' && r.progressTotal > 0
                        ? ` (${r.progressDone}/${r.progressTotal})`
                        : ''}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--color-text-muted)',
                        fontSize: 'var(--fs-xs)',
                      }}
                    >
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                    {r.resultJson || r.error ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      >
                        {expanded === r.id ? 'Hide' : 'Details'}
                      </Button>
                    ) : null}
                  </div>

                  {expanded === r.id ? (
                    <div style={{ marginTop: 'var(--sp-3)' }}>
                      {r.error ? (
                        <Banner severity="critical">{r.error}</Banner>
                      ) : (
                        <RunDetails result={r.resultJson} />
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function RunDetails({ result }: { result: RunResult | null }) {
  if (!result) return <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>No details.</p>;

  if (result.issues) {
    if (result.issues.length === 0) {
      return (
        <p style={{ margin: 0, color: 'var(--color-success)' }}>
          ✓ No issues found
          {typeof result.checked === 'number' ? ` (${result.checked} checked)` : ''}.
        </p>
      );
    }
    return (
      <ul style={{ margin: 0, paddingLeft: 'var(--sp-4)' }}>
        {result.issues.map((i, ix) => (
          <li key={ix} style={{ marginBottom: 'var(--sp-1)' }}>
            <span style={{ color: sevColor(i.severity), fontWeight: 600 }}>[{i.severity}]</span>{' '}
            <strong>{i.target}</strong> — {i.message}
          </li>
        ))}
      </ul>
    );
  }

  if (result.results) {
    return (
      <ul style={{ margin: 0, paddingLeft: 'var(--sp-4)' }}>
        {result.results.map((res, ix) => (
          <li key={ix} style={{ marginBottom: 'var(--sp-1)' }}>
            <span style={{ color: res.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
              {res.ok ? '✓' : '✗'}
            </span>{' '}
            <strong>{res.target}</strong> — {res.summary}
          </li>
        ))}
      </ul>
    );
  }

  return <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>No details.</p>;
}
