import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import {
  type AnnouncementDetail,
  type AnnouncementStats,
  announcementStatus,
  describeAudience,
  severityLabel,
} from '../types';
import { AnnouncementActions } from './AnnouncementActions';

export const dynamic = 'force-dynamic';

export default async function AnnouncementDetailPage(props: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let ann: AnnouncementDetail | null = null;
  let stats: AnnouncementStats | null = null;
  let error: string | null = null;
  try {
    const [a, s] = await Promise.all([
      api<{ announcement: AnnouncementDetail }>(`/admin/announcements/${params.id}`, { cookie }),
      api<{ stats: AnnouncementStats }>(`/admin/announcements/${params.id}/stats`, { cookie }),
    ]);
    ann = a.announcement;
    stats = s.stats;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  if (!ann || !stats) {
    return (
      <>
        <PageHeader title="Announcement" />
        {error ? <Banner severity="critical">{error}</Banner> : null}
      </>
    );
  }

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

  return (
    <>
      <PageHeader
        title={ann.title}
        subtitle={`${severityLabel(ann.severity)} — ${announcementStatus(ann)}`}
        actions={
          <Link href={`/admin/announcements`} className="lbr-btn lbr-btn--ghost lbr-btn--md">
            Back to list
          </Link>
        }
      />

      <div className="lbr-split">
        <Card>
          <CardHeader title="Message" />
          <CardBody>
            <pre
              style={{
                background: 'var(--color-surface-muted)',
                padding: 'var(--sp-3)',
                borderRadius: 'var(--radius-sm)',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
              }}
            >
              {ann.bodyMarkdown}
            </pre>
          </CardBody>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <Card>
            <CardHeader title="Audience + scheduling" />
            <CardBody>
              <dl style={{ margin: 0 }}>
                <dt>Audience</dt>
                <dd>{describeAudience(ann.audience)}</dd>
                <dt>Channels</dt>
                <dd>
                  {[ann.deliverInApp ? 'In-app' : null, ann.deliverEmail ? 'Email' : null]
                    .filter(Boolean)
                    .join(' + ') || '—'}
                </dd>
                <dt>Published</dt>
                <dd>{fmt(ann.publishedAt)}</dd>
                <dt>Scheduled</dt>
                <dd>{fmt(ann.publishAt)}</dd>
                <dt>Expires</dt>
                <dd>{fmt(ann.expiresAt)}</dd>
                <dt>Dismissible</dt>
                <dd>{ann.dismissible ? 'Yes' : 'No'}</dd>
                <dt>Requires acknowledgement</dt>
                <dd>{ann.requiresAck ? 'Yes' : 'No'}</dd>
                <dt>Created</dt>
                <dd>
                  {fmt(ann.createdAt)} by {ann.createdBy.fullName}
                </dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Delivery stats" />
            <CardBody>
              <dl style={{ margin: 0 }}>
                <dt>Currently targets</dt>
                <dd>{stats.targetTenantCount} active libraries</dd>
                <dt>Deliveries materialized</dt>
                <dd>{stats.deliveryCount}</dd>
                <dt>In-app delivered</dt>
                <dd>{stats.deliveredInAppCount}</dd>
                <dt>Email delivered</dt>
                <dd>{stats.deliveredEmailCount}</dd>
                <dt>Dismissed</dt>
                <dd>{stats.dismissedCount}</dd>
                <dt>Acknowledged</dt>
                <dd>{stats.acknowledgedCount}</dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Actions" />
            <CardBody>
              <AnnouncementActions
                id={ann.id}
                title={ann.title}
                isExpired={!!ann.expiresAt && new Date(ann.expiresAt) <= new Date()}
                isArchived={!!ann.archivedAt}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
