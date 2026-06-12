import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { LibraryPolicyForm, type TenantSettingsView } from './LibraryPolicyForm';

export const dynamic = 'force-dynamic';

/**
 * Library policy + feature switches. Admin-only: the API enforces this on
 * write (RolesGuard), and we gate the page on the session role too so
 * librarians/volunteers are sent back to the dashboard rather than shown a
 * form they can't save.
 */
export default async function LibrarySettingsPage(props: {
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
  let initial: TenantSettingsView;
  try {
    initial = await api<TenantSettingsView>(`/t/${params.slug}/settings`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader title={t('settings.library.title')} subtitle={t('settings.library.subtitle')} />
      <LibraryPolicyForm
        slug={params.slug}
        locale={params.locale}
        catalog={catalog}
        initial={initial}
      />
    </>
  );
}
