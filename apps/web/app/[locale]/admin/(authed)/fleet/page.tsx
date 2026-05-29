import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';

export const dynamic = 'force-dynamic';

type FleetOverview = {
  generatedAt: string;
  tenants: {
    total: number;
    byStatus: Record<string, number>;
    byPlan: Record<string, number>;
    byCell: Record<string, number>;
    totalStorageBytes: number;
    totalDbBytes: number;
    oldestCreatedAt: string | null;
    newestCreatedAt: string | null;
  };
  database: {
    controlDbBytes: number;
    tenantDbCount: number;
    tenantDbTotalBytes: number;
    connections: {
      total: number;
      max: number;
      usedPct: number | null;
      topByDatabase: Array<{ datname: string; conns: number }>;
    };
    cacheHitRatio: number | null;
  };
  redis: { usedMemoryBytes: number; keys: number } | null;
  disk: { totalBytes: number; freeBytes: number } | null;
  signals: {
    connectionsUsedPct: number | null;
    cacheHitRatio: number | null;
    diskUsedPct: number | null;
  };
  perTenant: Array<{
    slug: string;
    name: string;
    status: string;
    plan: string | null;
    cell: string;
    dbBytes: number;
    storageBytes: number;
    totalBytes: number;
  }>;
};

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[i]}`;
}

const muted = 'var(--color-text-muted)';

/** A headline number with an optional "concern" colour + sub-label. */
function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ok' | 'warn' | 'crit';
}) {
  const color =
    tone === 'crit'
      ? 'var(--color-danger, #b42318)'
      : tone === 'warn'
        ? 'var(--color-warning, #b54708)'
        : 'var(--color-text)';
  return (
    <Card>
      <CardBody>
        <div style={{ fontSize: 'var(--fs-xs)', color: muted, textTransform: 'uppercase' }}>
          {label}
        </div>
        <div style={{ fontSize: 'var(--fs-2xl, 1.6rem)', fontWeight: 600, color }}>{value}</div>
        {sub ? (
          <div style={{ fontSize: 'var(--fs-xs)', color: muted, marginTop: 'var(--sp-1)' }}>
            {sub}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function breakdown(o: Record<string, number>): string {
  return (
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ') || '—'
  );
}

export default async function AdminFleetPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let data: FleetOverview | null = null;
  let error: string | null = null;
  try {
    data = await api<FleetOverview>('/admin/fleet/overview', { cookie });
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Could not load the capacity overview.';
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Fleet & capacity" subtitle="Tenant census and host resource usage." />
        <Banner severity="critical">{error}</Banner>
      </>
    );
  }

  const s = data.signals;
  const connTone =
    s.connectionsUsedPct == null
      ? undefined
      : s.connectionsUsedPct >= 85
        ? 'crit'
        : s.connectionsUsedPct >= 60
          ? 'warn'
          : 'ok';
  const diskTone =
    s.diskUsedPct == null
      ? undefined
      : s.diskUsedPct >= 90
        ? 'crit'
        : s.diskUsedPct >= 80
          ? 'warn'
          : 'ok';
  const cacheTone =
    s.cacheHitRatio == null
      ? undefined
      : s.cacheHitRatio >= 0.99
        ? 'ok'
        : s.cacheHitRatio >= 0.95
          ? 'warn'
          : 'crit';

  return (
    <>
      <PageHeader
        title="Fleet & capacity"
        subtitle={`All libraries and host resource usage. Snapshot at ${new Date(data.generatedAt).toLocaleString(params.locale)}.`}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <Stat
          label="Libraries"
          value={String(data.tenants.total)}
          sub={breakdown(data.tenants.byStatus)}
        />
        <Stat
          label="PG connections"
          value={`${data.database.connections.total} / ${data.database.connections.max}`}
          sub={s.connectionsUsedPct == null ? undefined : `${s.connectionsUsedPct}% used`}
          tone={connTone}
        />
        <Stat
          label="Cache hit ratio"
          value={s.cacheHitRatio == null ? 'n/a' : `${(s.cacheHitRatio * 100).toFixed(2)}%`}
          sub="target > 99%"
          tone={cacheTone}
        />
        <Stat
          label="Disk (storage vol)"
          value={s.diskUsedPct == null ? 'n/a' : `${s.diskUsedPct}%`}
          sub={
            data.disk
              ? `${fmtBytes(data.disk.totalBytes - data.disk.freeBytes)} / ${fmtBytes(data.disk.totalBytes)}`
              : undefined
          }
          tone={diskTone}
        />
        <Stat
          label="Storage (tracked)"
          value={fmtBytes(data.tenants.totalStorageBytes)}
          sub={`DBs: ${fmtBytes(data.database.tenantDbTotalBytes)} across ${data.database.tenantDbCount}`}
        />
        <Stat
          label="Redis"
          value={data.redis ? fmtBytes(data.redis.usedMemoryBytes) : 'n/a'}
          sub={data.redis ? `${data.redis.keys} keys` : undefined}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <Card>
          <CardHeader title="By plan" />
          <CardBody>
            <p style={{ margin: 0, color: muted }}>{breakdown(data.tenants.byPlan)}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="By cell" />
          <CardBody>
            <p style={{ margin: 0, color: muted }}>{breakdown(data.tenants.byCell)}</p>
          </CardBody>
        </Card>
      </div>

      <h2 style={{ fontSize: 'var(--fs-lg)', marginBottom: 'var(--sp-2)' }}>
        Libraries by size (heaviest first)
      </h2>
      {data.perTenant.length === 0 ? (
        <p style={{ color: muted }}>No libraries yet.</p>
      ) : (
        <table className="lbr-table">
          <thead>
            <tr>
              <th>Library</th>
              <th>Status</th>
              <th>Plan</th>
              <th>Cell</th>
              <th style={{ textAlign: 'right' }}>Database</th>
              <th style={{ textAlign: 'right' }}>Storage</th>
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.perTenant.slice(0, 50).map((t) => (
              <tr key={t.slug}>
                <td>
                  <strong>{t.name}</strong>
                  <div style={{ color: muted, fontSize: 'var(--fs-xs)' }}>{t.slug}</div>
                </td>
                <td>{t.status}</td>
                <td>{t.plan ?? '—'}</td>
                <td>{t.cell}</td>
                <td style={{ textAlign: 'right' }}>{fmtBytes(t.dbBytes)}</td>
                <td style={{ textAlign: 'right' }}>{fmtBytes(t.storageBytes)}</td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{fmtBytes(t.totalBytes)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
