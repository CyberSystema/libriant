import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@libriant/i18n';
import { currentAdminSession } from '@/lib/admin-session';
import { AdminSidebar } from './AdminSidebar';

/**
 * Wrapper for every authenticated admin page. The route group `(authed)`
 * means the URL doesn't include the segment, so paths stay clean
 * (`/admin/tenants` rather than `/admin/(authed)/tenants`).
 *
 *   - No session? bounce to `/<locale>/admin/login`.
 *   - Session OK? render the persistent sidebar shell.
 */
export default async function AuthedAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const admin = await currentAdminSession();
  if (!admin) redirect(`/${params.locale}/admin/login`);

  return (
    <div className="lbr-shell">
      <AdminSidebar locale={params.locale} admin={admin} />
      <main className="lbr-shell__main">{children}</main>
    </div>
  );
}
