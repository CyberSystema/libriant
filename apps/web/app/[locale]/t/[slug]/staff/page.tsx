import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { StaffManager, type StaffMember } from './StaffManager';

export const dynamic = 'force-dynamic';

export default async function StaffPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();
  const session = await currentSession();

  let staff: StaffMember[] = [];
  try {
    const res = await api<{ staff: StaffMember[] }>(`/t/${params.slug}/staff`, { cookie });
    staff = res.staff;
  } catch (err) {
    // Non-admins are 401/403'd by the API — send them back to the dashboard.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader title={t('settings.staff.title')} subtitle={t('settings.staff.subtitle')} />
      <StaffManager
        slug={params.slug}
        locale={params.locale}
        catalog={catalog}
        initialStaff={staff}
        currentUserId={session?.user.id ?? ''}
      />
    </>
  );
}
