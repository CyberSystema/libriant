import { notFound, redirect } from 'next/navigation';
import { createTranslator, isLocale } from '@libriant/i18n';
import { currentAdminSession } from '@/lib/admin-session';
import { loadCatalog } from '@/lib/locale-loader';
import { AdminSidebar } from './AdminSidebar';

/**
 * Wrapper for every authenticated admin page. The route group `(authed)`
 * means the URL doesn't include the segment, so paths stay clean
 * (`/admin/tenants` rather than `/admin/(authed)/tenants`).
 *
 *   - No session? bounce to `/<locale>/admin/login`.
 *   - Session OK? render the persistent sidebar shell.
 */
export default async function AuthedAdminLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;

  const { children } = props;

  if (!isLocale(params.locale)) notFound();
  const admin = await currentAdminSession();
  if (!admin) redirect(`/admin/login`);

  // The admin plane is English-only, but the skip link is a keyboard
  // affordance, not copy — it comes from the catalogue like everything else.
  const t = createTranslator(await loadCatalog(params.locale, ['shell']), params.locale);

  return (
    <div className="lbr-shell">
      <a href="#lbr-main" className="lbr-skip">
        {t('shell.skipToContent')}
      </a>
      <AdminSidebar admin={admin} />
      <main className="lbr-shell__main" id="lbr-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
