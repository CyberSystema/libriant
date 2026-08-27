import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { ApplicationsClient, type ApplicationsList } from './ApplicationsClient';

export const dynamic = 'force-dynamic';

/**
 * launch-readiness-03 — the libraries that answered the campaign.
 *
 * Every application from the public form at libriant.com landed in Postgres
 * and told nobody: the notification is an e-mail, and Libriant launches with
 * EMAIL_DRIVER=console, which composes mail and delivers none of it. The only
 * read path was `GET /admin/applications.csv`, linked from nowhere. Meanwhile
 * the site promises an answer within two working days and the campaign points
 * 277 Greek mailboxes at that form. This page, and the unread count beside it
 * in the sidebar, are the notification that works with the mail driver we
 * actually run.
 *
 * Owner-only at the API (see admin-applications.controller.ts): every row is
 * an identifiable person's name, address and phone number. A support admin
 * reaching this page gets the API's own refusal in a banner rather than a
 * blank screen. Admin panel is English-only by convention.
 */
export default async function AdminApplicationsPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const search = await props.searchParams;
  const cookie = await requestCookieHeader();

  const qs = search.status ? `?status=${encodeURIComponent(search.status)}` : '';

  let data: ApplicationsList | null = null;
  let error: string | null = null;
  try {
    data = await api<ApplicationsList>(`/admin/applications${qs}`, { cookie });
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Could not load the applications.';
  }

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle="Libraries that asked for one of the launch places. Answering one is a reply from your own mailbox — this page is where you find the address and record what you decided."
      />
      {error ? <Banner severity="critical">{error}</Banner> : null}
      {data ? <ApplicationsClient initial={data} initialStatus={search.status ?? ''} /> : null}
    </>
  );
}
