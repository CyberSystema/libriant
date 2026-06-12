import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { AuditLog, type AuditRow } from './AuditLog';

export const dynamic = 'force-dynamic';

/**
 * Activity log — read-only view of the library's own data changes (members,
 * loans, fines, settings). Admin-only: the API enforces it, and we gate the
 * page on session role so non-admins are sent back to the dashboard.
 */
export default async function ActivityPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  const session = await currentSession();
  const role = session?.user.role;
  if (role !== 'owner' && role !== 'admin') {
    redirect(`/${params.locale}/t/${params.slug}`);
  }

  const cookie = await requestCookieHeader();
  let initial: { items: AuditRow[]; nextCursor: string | null } = { items: [], nextCursor: null };
  try {
    initial = await api<{ items: AuditRow[]; nextCursor: string | null }>(
      `/t/${params.slug}/audit`,
      { cookie },
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader title={t('settings.activity.title')} subtitle={t('settings.activity.subtitle')} />
      <AuditLog slug={params.slug} locale={params.locale} catalog={catalog} initial={initial} />
    </>
  );
}
