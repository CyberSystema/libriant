import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { ExportManager, type ExportJobView } from './ExportManager';

export const dynamic = 'force-dynamic';

export default async function ExportPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let exports: ExportJobView[] = [];
  try {
    const res = await api<{ exports: ExportJobView[] }>(`/t/${params.slug}/exports`, { cookie });
    exports = res.exports;
  } catch (err) {
    // Export is admin-only — non-admins are 401/403'd; send them home.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader title={t('settings.export.title')} subtitle={t('settings.export.subtitle')} />
      <ExportManager
        slug={params.slug}
        locale={params.locale}
        catalog={catalog}
        initial={exports}
      />
    </>
  );
}
