import { notFound, redirect } from 'next/navigation';
import { createTranslator, isLocale } from '@libriant/i18n';
import { api } from '@/lib/api';
import { currentAdminSession, requestCookieHeader } from '@/lib/admin-session';
import { loadCatalog } from '@/lib/locale-loader';
import { AdminSidebar } from './AdminSidebar';

/**
 * Applications nobody has read yet, for the sidebar badge
 * (launch-readiness-03).
 *
 * This is the CALLER that makes the count mean something: an Applications page
 * an operator has to remember to open is the same silence the finding is
 * about, one click shallower. Every admin page render asks for it, so it is
 * deliberately the counts-only endpoint — `GET /admin/applications/summary` —
 * rather than the list: no personal data crosses the wire, and no audit row is
 * written for what is only a page view.
 *
 * Never throws: the endpoint is owner-only, so a support admin is refused it,
 * and an API that is down must not take the whole admin shell with it. Both
 * cases return null and the badge simply is not there.
 */
async function unreadApplications(cookie: string | undefined): Promise<number | null> {
  try {
    const res = await api<{ counts: { new: number } }>('/admin/applications/summary', { cookie });
    return res.counts.new;
  } catch {
    return null;
  }
}

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
  const applicationsUnread = await unreadApplications(await requestCookieHeader());

  return (
    <div className="lbr-shell">
      <a href="#lbr-main" className="lbr-skip">
        {t('shell.skipToContent')}
      </a>
      <AdminSidebar admin={admin} applicationsUnread={applicationsUnread} />
      <main className="lbr-shell__main" id="lbr-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
