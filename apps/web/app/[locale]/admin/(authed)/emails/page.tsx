import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { EmailOutboxClient, type OutboxList } from './EmailOutboxClient';

export const dynamic = 'force-dynamic';

/**
 * launch-readiness-01 — read what Libriant would have sent.
 *
 * Libriant launches with `EMAIL_DRIVER=console`: every message is composed,
 * queued, stored and marked delivered against a fabricated provider id, and
 * then goes nowhere. The console driver withholds the body from the container
 * log (it can carry a one-time link), so before this page the only way to get
 * a verification or reset link to the librarian who needed it was an
 * undocumented psql query against `email_outbox`, inside the token's TTL.
 *
 * Owner-admin only, and every open of a message writes an `audit_log` row —
 * see admin-outbox.controller.ts for why reading a body is treated as a
 * privileged act rather than a page view. Admin panel is English-only by
 * convention.
 */
export default async function AdminEmailsPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; status?: string; kind?: string; tenant?: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const search = await props.searchParams;
  const cookie = await requestCookieHeader();

  const query = new URLSearchParams();
  if (search.q) query.set('q', search.q);
  if (search.status) query.set('status', search.status);
  if (search.kind) query.set('kind', search.kind);
  if (search.tenant) query.set('tenant', search.tenant);
  const qs = query.toString();

  let data: OutboxList | null = null;
  let error: string | null = null;
  try {
    data = await api<OutboxList>(`/admin/outbox${qs ? `?${qs}` : ''}`, { cookie });
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Could not load the outbox.';
  }

  return (
    <>
      <PageHeader
        title="Emails"
        subtitle="Everything Libriant composed — whether or not it was delivered."
      />
      {error ? <Banner severity="critical">{error}</Banner> : null}
      {data ? <EmailOutboxClient initial={data} initialFilters={search} /> : null}
    </>
  );
}
