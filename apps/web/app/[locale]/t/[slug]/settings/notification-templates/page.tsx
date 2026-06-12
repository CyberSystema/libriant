import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { TemplateEditor, type Templates } from './TemplateEditor';

export const dynamic = 'force-dynamic';

/**
 * Notification-template editor. Admin-only — lets a library override the copy
 * of its member reminder emails. Empty fields fall back to the built-in
 * localized templates.
 */
export default async function NotificationTemplatesPage(props: {
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
  let templates: Templates = {};
  try {
    const res = await api<{ notificationTemplates: Templates }>(`/t/${params.slug}/settings`, {
      cookie,
    });
    templates = res.notificationTemplates ?? {};
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      redirect(`/${params.locale}/t/${params.slug}`);
    }
    throw err;
  }

  return (
    <>
      <PageHeader
        title={t('settings.templates.title')}
        subtitle={t('settings.templates.subtitle')}
      />
      <TemplateEditor
        slug={params.slug}
        locale={params.locale}
        catalog={catalog}
        initial={templates}
      />
    </>
  );
}
