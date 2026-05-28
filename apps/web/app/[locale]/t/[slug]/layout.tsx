import { notFound, redirect } from 'next/navigation';
import { ToastProvider } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession } from '@/lib/session';
import { SidebarNav } from './SidebarNav';

/**
 * Every tenant-scoped page goes through here. Three jobs:
 *
 *   1. Require a valid session — redirect anonymous users to `/login`.
 *   2. Enforce cross-tenant isolation — if the URL slug doesn't match the
 *      session's tenant slug, bounce to the user's own library. (The API
 *      already 403s; this front-end check spares the user the error.)
 *   3. Render the persistent sidebar shell so every child page gets the
 *      same nav + sign-out controls without duplicating boilerplate.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();

  const session = await currentSession();
  if (!session) {
    redirect(`/${params.locale}/login`);
  }
  if (session.tenant.slug !== params.slug) {
    // The signed-in user belongs to a different library. Don't show them
    // a 403 — quietly send them to their own home.
    redirect(`/${params.locale}/t/${session.tenant.slug}`);
  }

  const catalog = await loadCatalog(params.locale);

  return (
    <ToastProvider>
      <div className="lbr-shell">
        <SidebarNav
          catalog={catalog}
          locale={params.locale}
          slug={params.slug}
          libraryName={session.tenant.name}
          userFullName={session.user.fullName}
        />
        <main className="lbr-shell__main">{children}</main>
      </div>
    </ToastProvider>
  );
}
