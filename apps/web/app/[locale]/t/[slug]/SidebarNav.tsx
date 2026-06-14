'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Asset, Nav, PoweredBy } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
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
  // While open: close on Escape and lock background scroll.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [menuOpen]);

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
    ...(isAdmin && billingEnabled ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    ...(isAdmin ? [{ href: `${base}/staff`, label: t('common.nav.staff') }] : []),
    ...(isAdmin ? [{ href: `${base}/settings`, label: t('common.nav.settings') }] : []),
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
      <aside id="lbr-tenant-sidebar" className={`lbr-shell__sidebar${menuOpen ? ' is-open' : ''}`}>
        <Link
          href={base}
          className="lbr-shell__brand"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          {brandMark}
          <span className="lbr-shell__brand-name">{libraryName}</span>
        </Link>
        <Nav ariaLabel="Sections">
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
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <PoweredBy />
          </div>
        </div>
      </aside>
    </>
  );
}
