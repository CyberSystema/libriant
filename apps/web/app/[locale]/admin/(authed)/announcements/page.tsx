import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import {
  type AnnouncementSummary,
  announcementStatus,
  describeAudience,
  severityLabel,
} from './types';

export const dynamic = 'force-dynamic';

const STATUS_TABS = ['active', 'scheduled', 'expired', 'archived'] as const;
type StatusTab = (typeof STATUS_TABS)[number];

export default async function AdminAnnouncementsPage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { status?: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();
  const status: StatusTab = STATUS_TABS.includes(searchParams.status as StatusTab)
    ? (searchParams.status as StatusTab)
    : 'active';

  let announcements: AnnouncementSummary[] = [];
  let error: string | null = null;
  try {
    const res = await api<{ announcements: AnnouncementSummary[] }>(
      `/admin/announcements?status=${status}`,
      { cookie },
    );
    announcements = res.announcements;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle="Send messages to libraries — in-app, email, or both. Target everyone, specific libraries, plans, or tags."
        help={
          <HelpButton title="About announcements">
            <h3>Severity → behaviour</h3>
            <ul>
              <li>
                <strong>info</strong> — blue dismissible banner.
              </li>
              <li>
                <strong>warning</strong> — orange dismissible banner.
              </li>
              <li>
                <strong>critical</strong> — red sticky banner. With <em>requires ack</em>, it
                becomes a full-screen modal blocking each user until they acknowledge.
              </li>
            </ul>
            <h3>Audience targeting</h3>
            <p>Four shapes, mutually exclusive:</p>
            <ul>
              <li>
                <strong>all</strong> — every active library.
              </li>
              <li>
                <strong>tenant_ids</strong> — specific libraries by id.
              </li>
              <li>
                <strong>plan_slugs</strong> — libraries on a plan (e.g. <code>community</code>).
              </li>
              <li>
                <strong>tags</strong> — libraries with any of the matching tags.
              </li>
            </ul>
            <h3>Delivery + scheduling</h3>
            <p>
              <strong>In-app</strong> shows the banner; <strong>email</strong> queues a row in the
              email outbox (Step 18d). Email delivery is idempotent on{' '}
              <code>announcement:&lt;id&gt;:tenant:&lt;tenantId&gt;</code> — a retried publish never
              duplicates the library&rsquo;s email.
            </p>
            <p>
              <strong>publishAt</strong> defers the live state — until then the row is in the
              Scheduled tab. <strong>expiresAt</strong> ends visibility cleanly.
            </p>
            <h3>Lifecycle</h3>
            <p>
              <strong>Expire now</strong> ends visibility but keeps the row + history.{' '}
              <strong>Archive</strong> hides it from active and expired lists (history stays for
              audit). Both are non-destructive — delivery + acknowledgement rows are never deleted.
            </p>
          </HelpButton>
        }
        actions={
          <Link
            href={`/${params.locale}/admin/announcements/new`}
            className="lbr-btn lbr-btn--primary lbr-btn--md"
          >
            New announcement
          </Link>
        }
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      <nav
        aria-label="Status filter"
        className="lbr-nav"
        style={{
          flexDirection: 'row',
          gap: 'var(--sp-1)',
          marginBottom: 'var(--sp-3)',
          flexWrap: 'wrap',
        }}
      >
        {STATUS_TABS.map((t) => {
          const active = t === status;
          const classes = ['lbr-nav__link'];
          if (active) classes.push('lbr-nav__link--active');
          return (
            <Link
              key={t}
              href={`/${params.locale}/admin/announcements?status=${t}`}
              className={classes.join(' ')}
              aria-current={active ? 'page' : undefined}
            >
              <span className="lbr-nav__link-label" style={{ textTransform: 'capitalize' }}>
                {t}
              </span>
            </Link>
          );
        })}
      </nav>

      {announcements.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No announcements in this state yet.</p>
      ) : (
        <table className="lbr-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Severity</th>
              <th>Audience</th>
              <th>Channels</th>
              <th>Published</th>
              <th>Expires</th>
              <th>Delivered</th>
            </tr>
          </thead>
          <tbody>
            {announcements.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link href={`/${params.locale}/admin/announcements/${a.id}`}>
                    <strong>{a.title}</strong>
                  </Link>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
                    {announcementStatus(a)} — by {a.createdBy.fullName}
                  </div>
                </td>
                <td>{severityLabel(a.severity)}</td>
                <td>{describeAudience(a.audience)}</td>
                <td>
                  {[a.deliverInApp ? 'In-app' : null, a.deliverEmail ? 'Email' : null]
                    .filter(Boolean)
                    .join(' + ') || '—'}
                </td>
                <td>
                  {a.publishedAt
                    ? new Date(a.publishedAt).toLocaleString()
                    : a.publishAt
                      ? `at ${new Date(a.publishAt).toLocaleString()}`
                      : '—'}
                </td>
                <td>{a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'never'}</td>
                <td>{a.deliveryCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
