import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { LibraryProfileForm, type LibraryProfileView } from './LibraryProfileForm';

export const dynamic = 'force-dynamic';

/**
 * Library information (the control-plane profile). Owner/admin only — librarians
 * and volunteers are redirected. Free fields (public contact + description) save
 * directly; core fields (name / type / address) go through an owner-approved
 * change request.
 */
export default async function LibraryProfilePage(props: {
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
  let initial: LibraryProfileView;
  try {
    initial = await api<LibraryProfileView>(`/t/${params.slug}/library`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader title={t('library.profile.title')} subtitle={t('library.profile.subtitle')} />
      <LibraryProfileForm
        initial={initial}
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
      />
    </>
  );
}
