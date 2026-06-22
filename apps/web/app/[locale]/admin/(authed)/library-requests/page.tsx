import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { LibraryRequestsClient, type LibraryRequest } from './LibraryRequestsClient';

export const dynamic = 'force-dynamic';

/**
 * Owner-admin review of tenant-submitted library-profile change requests
 * (core fields: name / type / address). Approving applies the change to the
 * tenant and notifies the library. Admin panel is English-only by convention.
 */
export default async function AdminLibraryRequestsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let requests: LibraryRequest[] = [];
  let error: string | null = null;
  try {
    const res = await api<{ requests: LibraryRequest[] }>(
      '/admin/library-requests?status=pending',
      { cookie },
    );
    requests = res.requests;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Library requests"
        subtitle="Tenant-requested changes to core library details (name / type / address) awaiting your decision."
      />
      {error ? (
        <Banner severity="critical">{error}</Banner>
      ) : (
        <LibraryRequestsClient initial={requests} />
      )}
    </>
  );
}
