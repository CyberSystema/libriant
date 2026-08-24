import type { CSSProperties } from 'react';
import { notFound, redirect } from 'next/navigation';
import { Banner, uiStringsFromCatalog } from '@libriant/ui';
import { UiChrome } from '@/components/UiChrome';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { ApiError, ApiUnavailableError, api } from '@/lib/api';
import { currentAnnouncements } from '@/lib/announcements';
import { currentImpersonation } from '@/lib/impersonation';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { isDesktopRequest } from '@/lib/desktop-server';
import { currentSystemMode, isTakeoverMode } from '@/lib/system-mode';
import { OfflineQueueProvider } from '@/components/OfflineQueueProvider';
import { AnnouncementsTopBanners } from './AnnouncementsTopBanners';
import { ChoosePlanScreen } from './ChoosePlanScreen';
import { EmailVerifyBanner } from './EmailVerifyBanner';
import { FirstLoginSetup } from './FirstLoginSetup';
import { ImpersonationBanner } from './ImpersonationBanner';
import { type AvailablePlan } from './billing/PlanGrid';
import { DesktopGate } from './DesktopGate';
import { LogoutButton } from './LogoutButton';
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

  // Catalog loads first so even the pre-auth takeover screen is localized.
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  // Accessible names for the design system's own controls (frontend-13).
  const uiStrings = uiStringsFromCatalog(t);

  // System mode resolves FIRST, and on its own. A maintenance / out_of_order
  // takeover renders before any auth fetch (the API blocks those anyway, but we
  // also don't want to bounce the user to /login during an outage).
  //
  // It used to share a `Promise.all` with the impersonation probe, and that is
  // what made the maintenance lever crash every signed-in librarian: the
  // middleware's always-pass list does not cover /support/impersonation/me, so
  // that probe 503s during a maintenance window and the combined promise
  // rejected before this branch could ever be evaluated. The takeover is the
  // one screen whose entire job is to work when the rest of the API does not,
  // so nothing that can fail may be resolved alongside it.
  const systemMode = await currentSystemMode(params.slug);
  // Impersonating admins bypass the takeover — they're the people debugging the
  // outage and need the library reachable. Fails soft to `null`.
  const impersonation = await currentImpersonation();
  if (isTakeoverMode(systemMode.mode) && !impersonation) {
    return <SystemModeTakeover mode={systemMode} catalog={catalog} locale={params.locale} />;
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

  const libraryName = session?.tenant.name ?? impersonation?.tenant.name ?? params.slug;
  const userFullName =
    session?.user.fullName ?? impersonation?.admin.fullName ?? 'Libriant support';
  const role = session?.user.role ?? 'owner';
  const isLibraryAdmin = role === 'owner' || role === 'admin';

  // First-login setup. Admin-created staff are forced through a one-time
  // "set your name + password (or keep them)" screen before anything else.
  if (session && !impersonation && session.user.mustChangeCredentials) {
    return (
      <UiChrome strings={uiStrings}>
        <FirstLoginSetup
          locale={params.locale}
          catalog={catalog}
          currentName={session.user.fullName}
        />
      </UiChrome>
    );
  }

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
        // Choosing a plan is an admin action. Staff just see a notice until an
        // admin picks one (they can't reach the rest of the library yet).
        if (!isLibraryAdmin) {
          // Sign-out and a support address are not decoration here. This is a
          // full-page takeover with no nav, and there is no GET logout route,
          // so without the button the only way off this screen is clearing
          // cookies — on a shared circulation-desk machine that also strands
          // the admin who needs to sign in and pick the plan.
          return (
            <UiChrome strings={uiStrings}>
              <main className="lbr-choose-shell">
                <div className="lbr-choose" style={{ maxWidth: 560 }}>
                  <h1 className="lbr-choose__title">{libraryName}</h1>
                  <p className="lbr-choose__subtitle">{t('billing.choosePlanGate')}</p>
                  <div
                    style={{
                      display: 'flex',
                      gap: 'var(--sp-3)',
                      justifyContent: 'center',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      marginTop: 'var(--sp-5)',
                    }}
                  >
                    <LogoutButton catalog={catalog} locale={params.locale} />
                    <a href="mailto:hello@libriant.com">{t('billing.actions.contactSales')}</a>
                  </div>
                </div>
              </main>
            </UiChrome>
          );
        }
        const { plans } = await api<{ plans: AvailablePlan[] }>(`/t/${params.slug}/billing/plans`, {
          cookie,
        });
        return (
          <UiChrome strings={uiStrings}>
            <ChoosePlanScreen
              slug={params.slug}
              locale={params.locale}
              catalog={catalog}
              plans={plans}
              libraryName={libraryName}
            />
          </UiChrome>
        );
      }
    } catch (err) {
      // A billing read that failed — a 5xx, or an API that never answered —
      // must never lock the library out. `ApiUnavailableError` is in here
      // because the fetch deadline turns a wedged API into a throw rather than
      // a five-minute hang, and that must degrade the same way a 503 does.
      if (!(err instanceof ApiError) && !(err instanceof ApiUnavailableError)) throw err;
    }
  }

  // Desktop runtime gate. When the request comes from the Electron shell (UA
  // marker) and the tenant isn't entitled to the desktop app (a paid feature
  // once subscriptions are on), we hard-block the workspace below. Computed
  // server-side so the overlay is in the first paint; only fetched for desktop
  // requests, so browsers pay nothing. A transient read failure never blocks.
  let desktopBlocked = false;
  if (session && !impersonation && (await isDesktopRequest())) {
    try {
      const cookie = await requestCookieHeader();
      const access = await api<{ allowed: boolean }>(`/t/${params.slug}/desktop/access`, {
        cookie,
      });
      desktopBlocked = !access.allowed;
    } catch (err) {
      if (!(err instanceof ApiError) && !(err instanceof ApiUnavailableError)) throw err;
    }
  }

  // Announcement banners only render for real librarian sessions — admins
  // under impersonation neither own nor need to act on the tenant's
  // announcements. The endpoint also keys deliveries on `users.id`, which
  // doesn't exist for AdminUsers.
  const announcements = session && !impersonation ? await currentAnnouncements(params.slug) : [];

  // Per-library branding (real sessions only; admins-under-impersonation see
  // the default theme). `brandColor` recolors the shell via --color-primary;
  // the logo, if set, replaces the wordmark in the header.
  const brandColor = session?.tenant.brandColor ?? null;
  const brandLogoUrl = session?.tenant.brandLogoRef
    ? `/lbr-api/t/${params.slug}/storage/${session.tenant.brandLogoRef}`
    : null;
  const shellStyle = brandColor
    ? ({ ['--color-primary']: brandColor } as CSSProperties)
    : undefined;

  return (
    <UiChrome strings={uiStrings}>
      <OfflineQueueProvider slug={params.slug} catalog={catalog} locale={params.locale}>
        <div className="lbr-shell" style={shellStyle}>
          {/* WCAG 2.4.1: the brand link, 8-11 nav links and sign-out all sit
              ahead of <main> in tab order on every page load. */}
          <a href="#lbr-main" className="lbr-skip">
            {t('shell.skipToContent')}
          </a>
          <DesktopGate
            blocked={desktopBlocked}
            locale={params.locale}
            slug={params.slug}
            catalog={catalog}
            libraryName={libraryName}
          />
          <SidebarNav
            catalog={catalog}
            locale={params.locale}
            slug={params.slug}
            libraryName={libraryName}
            brandLogoUrl={brandLogoUrl}
            userFullName={userFullName}
            billingEnabled={billingEnabled}
            role={role}
          />
          <main className="lbr-shell__main" id="lbr-main" tabIndex={-1}>
            {impersonation ? (
              <ImpersonationBanner
                tenantName={impersonation.tenant.name}
                expiresAt={impersonation.expiresAt}
              />
            ) : null}
            {systemMode.mode === 'under_construction' ? (
              <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
                <strong>{t('system.underConstruction.title')}</strong>{' '}
                {systemMode.messageMarkdown ?? t('system.underConstruction.description')}
              </Banner>
            ) : null}
            {systemMode.mode === 'read_only' ? (
              <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
                <strong>{t('system.readOnly.title')}</strong>{' '}
                {systemMode.messageMarkdown ?? t('system.readOnly.body')}
              </Banner>
            ) : null}
            {announcements.length > 0 ? (
              <AnnouncementsTopBanners
                slug={params.slug}
                catalog={catalog}
                locale={params.locale}
                initial={announcements}
              />
            ) : null}
            {session && !impersonation && session.user.emailVerified === false ? (
              <EmailVerifyBanner
                email={session.user.email}
                catalog={catalog}
                locale={params.locale}
              />
            ) : null}
            {children}
          </main>
        </div>
      </OfflineQueueProvider>
    </UiChrome>
  );
}
