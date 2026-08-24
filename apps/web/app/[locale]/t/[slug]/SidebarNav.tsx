'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Asset, Nav, PoweredBy } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { useDrawerA11y } from '@/lib/useDrawerA11y';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { LogoutButton } from './LogoutButton';

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  libraryName: string;
  /** Per-library logo URL; when set, replaces the Libriant wordmark. */
  brandLogoUrl?: string | null;
  userFullName: string;
  /** When false (subscriptions disabled globally), the Billing item is hidden. */
  billingEnabled?: boolean;
  /** Library role of the signed-in user. Admin-only items (Team, Settings,
   *  Billing) are hidden from librarian/volunteer. */
  role?: 'owner' | 'admin' | 'librarian' | 'volunteer';
};

/**
 * Sidebar shown on every tenant-scoped page. Pages still load their own
 * data; this only handles persistent navigation + a sign-out button.
 *
 * `NavLink` from `@libriant/ui` is a styled `<a>` — we render it through
 * Next's `<Link>` (which itself emits an `<a>`) so client-side routing
 * works and we keep the design-system styling in one place.
 */
export function SidebarNav({
  catalog,
  locale,
  slug,
  libraryName,
  brandLogoUrl,
  userFullName,
  billingEnabled = true,
  role = 'owner',
}: Props) {
  const t = createTranslator(catalog, locale);
  const pathname = usePathname() ?? '';
  const base = `/${locale}/t/${slug}`;
  const isAdmin = role === 'owner' || role === 'admin';

  // Off-canvas drawer state (mobile only; the sidebar is static on desktop).
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Close the drawer whenever the route changes (a nav link was followed).
  React.useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  // mob-2: if the viewport grows past the mobile breakpoint while the drawer is
  // open, close it. The drawer is only meaningful below 768px; leaving it open
  // would strand `body { overflow: hidden }` (set by useDrawerA11y) on a desktop
  // page that has no visible drawer to dismiss. Closing it runs the hook's
  // cleanup, which restores the body scroll.
  React.useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const onChange = () => {
      if (!mql.matches) setMenuOpen(false);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  // Escape-to-close, scroll-lock, focus trap + focus restore while open.
  const sidebarRef = useDrawerA11y<HTMLElement>(menuOpen, () => setMenuOpen(false));

  const brandMark = brandLogoUrl ? (
    <img
      src={brandLogoUrl}
      alt={libraryName}
      height={28}
      style={{ maxHeight: 28, maxWidth: 120, objectFit: 'contain' }}
    />
  ) : (
    <Asset name="brand/logo-square" width={28} height={28} />
  );
  const links = [
    { href: base, label: t('common.app.name') },
    { href: `${base}/catalog`, label: t('common.nav.catalog') },
    { href: `${base}/members`, label: t('common.nav.members') },
    { href: `${base}/loans`, label: t('common.nav.loans') },
    { href: `${base}/reservations`, label: t('common.nav.reservations') },
    // Admin-only "control the library" areas — hidden from librarian/volunteer,
    // and Billing is also hidden while subscriptions are off.
    ...(isAdmin && billingEnabled
      ? [{ href: `${base}/billing`, label: t('shell.nav.billing') }]
      : []),
    ...(isAdmin ? [{ href: `${base}/staff`, label: t('common.nav.staff') }] : []),
    ...(isAdmin ? [{ href: `${base}/settings`, label: t('common.nav.settings') }] : []),
    { href: `${base}/desktop`, label: t('common.nav.desktop') },
    { href: `${base}/help`, label: t('common.nav.help') },
  ];

  return (
    <>
      {/* Mobile-only top bar: brand + hamburger. Hidden on desktop via CSS. */}
      <div className="lbr-shell__topbar">
        <Link href={base} className="lbr-shell__topbar-brand">
          {brandMark}
          <span>{libraryName}</span>
        </Link>
        <button
          type="button"
          className="lbr-shell__hamburger"
          aria-label={menuOpen ? t('common.nav.closeMenu') : t('common.nav.menu')}
          aria-expanded={menuOpen}
          aria-controls="lbr-tenant-sidebar"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
      <div
        className={`lbr-shell__scrim${menuOpen ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={() => setMenuOpen(false)}
      />
      <aside
        ref={sidebarRef}
        id="lbr-tenant-sidebar"
        className={`lbr-shell__sidebar${menuOpen ? ' is-open' : ''}`}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? true : undefined}
        aria-label={menuOpen ? t('common.nav.menu') : undefined}
      >
        <Link
          href={base}
          className="lbr-shell__brand"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          {brandMark}
          <span className="lbr-shell__brand-name">{libraryName}</span>
        </Link>
        <Nav ariaLabel={t('shell.nav.sections')}>
          {links.map((l) => {
            const active =
              l.href === base
                ? pathname === base || pathname === `${base}/`
                : pathname === l.href || pathname.startsWith(`${l.href}/`);
            const classes = ['lbr-nav__link'];
            if (active) classes.push('lbr-nav__link--active');
            return (
              <Link
                key={l.href}
                href={l.href}
                className={classes.join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                <span className="lbr-nav__link-label">{l.label}</span>
              </Link>
            );
          })}
        </Nav>
        <div className="lbr-shell__footer">
          <div style={{ marginBottom: 'var(--sp-2)' }}>{userFullName}</div>
          <LogoutButton catalog={catalog} locale={locale} />
          {/* The only language control used to be on the public landing page,
              so a librarian on an en-US machine had no way to reach Greek from
              inside their own library. */}
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <LocaleSwitcher locale={locale} label={t('shell.locale.label')} />
          </div>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <PoweredBy />
          </div>
        </div>
      </aside>
    </>
  );
}
