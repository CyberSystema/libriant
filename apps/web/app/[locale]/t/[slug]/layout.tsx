import { notFound, redirect } from 'next/navigation';
import { Banner, ToastProvider } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { ApiError, api } from '@/lib/api';
import { currentAnnouncements } from '@/lib/announcements';
import { currentImpersonation } from '@/lib/impersonation';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { currentSystemMode, isTakeoverMode } from '@/lib/system-mode';
import { AnnouncementsTopBanners } from './AnnouncementsTopBanners';
import { ChoosePlanScreen } from './ChoosePlanScreen';
import { ImpersonationBanner } from './ImpersonationBanner';
import { type AvailablePlan } from './billing/PlanGrid';
import { SidebarNav } from './SidebarNav';
import { SystemModeTakeover } from './SystemModeTakeover';

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
export default async function TenantLayout(props: {
  children: React.ReactNode;
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;

  const { children } = props;

  if (!isLocale(params.locale)) notFound();

  // System mode resolves first. A maintenance / out_of_order takeover
  // renders before any auth fetch (the API blocks those anyway, but we
  // also don't want to bounce the user to /login during an outage).
  // Impersonating admins bypass — they're the people debugging the
  // outage and need the library reachable.
  const [systemMode, impersonation] = await Promise.all([
    currentSystemMode(params.slug),
    currentImpersonation(),
  ]);
  if (isTakeoverMode(systemMode.mode) && !impersonation) {
    return <SystemModeTakeover mode={systemMode} />;
  }

  const session = await currentSession();

  // Either a real session OR an active impersonation cookie grants entry.
  // The impersonating admin doesn't have a tenant session — they hold the
  // separate __Host-libriant_imp cookie validated server-side.
  if (!session && !impersonation) {
    redirect(`/${params.locale}/login`);
  }
  if (session && session.tenant.slug !== params.slug) {
    // The signed-in user belongs to a different library. Don't show them
    // a 403 — quietly send them to their own home.
    redirect(`/${params.locale}/t/${session.tenant.slug}`);
  }
  if (impersonation && impersonation.tenant.slug !== params.slug) {
    // The admin's impersonation cookie covers a different tenant. Send
    // them back to their support home to redeem the right key.
    redirect(`/admin/support`);
  }

  const catalog = await loadCatalog(params.locale);
  const libraryName = session?.tenant.name ?? impersonation?.tenant.name ?? params.slug;
  const userFullName =
    session?.user.fullName ?? impersonation?.admin.fullName ?? 'Libriant support';

  // Forced plan choice. When subscriptions are enabled and this library hasn't
  // picked a plan yet, every page is replaced by the chooser until they do.
  // Only real librarian sessions are gated — an impersonating admin debugging
  // the library must not be forced to pick a plan on the tenant's behalf. A
  // failure to read billing state never hard-blocks the library.
  //
  // The same fetch tells us whether subscriptions are on at all, which we pass
  // to the sidebar so the "Billing" item is hidden while they're off.
  let billingEnabled = true;
  if (session && !impersonation) {
    const cookie = await requestCookieHeader();
    try {
      const gate = await api<{ billingEnabled: boolean; planSelected: boolean }>(
        `/t/${params.slug}/billing/gate`,
        { cookie },
      );
      billingEnabled = gate.billingEnabled;
      if (gate.billingEnabled && !gate.planSelected) {
        const { plans } = await api<{ plans: AvailablePlan[] }>(`/t/${params.slug}/billing/plans`, {
          cookie,
        });
        return (
          <ToastProvider>
            <ChoosePlanScreen
              slug={params.slug}
              locale={params.locale}
              catalog={catalog}
              plans={plans}
              libraryName={libraryName}
            />
          </ToastProvider>
        );
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // ApiError (e.g. billing snapshot unavailable) — fall through and let the
      // library render rather than locking the user out on a transient error.
    }
  }

  // Announcement banners only render for real librarian sessions — admins
  // under impersonation neither own nor need to act on the tenant's
  // announcements. The endpoint also keys deliveries on `users.id`, which
  // doesn't exist for AdminUsers.
  const announcements = session && !impersonation ? await currentAnnouncements(params.slug) : [];

  return (
    <ToastProvider>
      <div className="lbr-shell">
        <SidebarNav
          catalog={catalog}
          locale={params.locale}
          slug={params.slug}
          libraryName={libraryName}
          userFullName={userFullName}
          billingEnabled={billingEnabled}
        />
        <main className="lbr-shell__main">
          {impersonation ? (
            <ImpersonationBanner
              tenantName={impersonation.tenant.name}
              expiresAt={impersonation.expiresAt}
            />
          ) : null}
          {systemMode.mode === 'under_construction' ? (
            <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
              <strong>Heads-up:</strong>{' '}
              {systemMode.messageMarkdown ??
                'Some Libriant features are still rolling out. If you hit something odd, refresh and try again.'}
            </Banner>
          ) : null}
          {systemMode.mode === 'read_only' ? (
            <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
              <strong>Read-only mode.</strong>{' '}
              {systemMode.messageMarkdown ??
                "We're not accepting changes right now. You can still browse, but saves will fail until we're back."}
            </Banner>
          ) : null}
          {announcements.length > 0 ? (
            <AnnouncementsTopBanners slug={params.slug} initial={announcements} />
          ) : null}
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
