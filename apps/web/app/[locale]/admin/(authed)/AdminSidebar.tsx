'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Asset, Button, PoweredBy, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { clearOfflineCaches } from '@/lib/offline';
import { useDrawerA11y } from '@/lib/useDrawerA11y';
import type { AdminProfile } from '@/lib/admin-session';

type Props = {
  admin: AdminProfile;
};

/** Persistent sidebar for the admin shell — distinct from the tenant sidebar. */
export function AdminSidebar({ admin }: Props) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const toast = useToast();
  const [signingOut, setSigningOut] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const base = '/admin';

  // Off-canvas drawer (mobile only; static sidebar on desktop).
  React.useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  // Escape-to-close, scroll-lock, focus trap + focus restore while open.
  const sidebarRef = useDrawerA11y<HTMLElement>(menuOpen, () => setMenuOpen(false));

  const links = [
    { href: `${base}/tenants`, label: 'Tenants' },
    { href: `${base}/library-requests`, label: 'Library requests' },
    { href: `${base}/fleet`, label: 'Capacity' },
    { href: `${base}/plans`, label: 'Plans' },
    { href: `${base}/subscriptions`, label: 'Subscriptions' },
    { href: `${base}/announcements`, label: 'Announcements' },
    { href: `${base}/system-mode`, label: 'System mode' },
    { href: `${base}/maintenance`, label: 'Maintenance' },
    { href: `${base}/export`, label: 'Export' },
    { href: `${base}/support`, label: 'Support access' },
    { href: `${base}/mfa`, label: 'Authenticator' },
  ];

  async function signOut() {
    setSigningOut(true);
    try {
      await api('/admin/auth/logout', { method: 'POST' });
    } catch (err) {
      // Still bounce — the cookie clear is best-effort.
      if (err instanceof ApiError) {
        toast.show({ severity: 'critical', title: err.message });
      }
    }
    await clearOfflineCaches();
    router.push(`/admin/login`);
    router.refresh();
  }

  return (
    <>
      {/* Mobile-only top bar: brand + hamburger. Hidden on desktop via CSS. */}
      <div className="lbr-shell__topbar">
        <Link href={`${base}/tenants`} className="lbr-shell__topbar-brand">
          <Asset name="brand/logo-square" width={28} height={28} />
          <span>Libriant Admin</span>
        </Link>
        <button
          type="button"
          className="lbr-shell__hamburger"
          aria-label={menuOpen ? 'Close menu' : 'Menu'}
          aria-expanded={menuOpen}
          aria-controls="lbr-admin-sidebar"
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
        id="lbr-admin-sidebar"
        className={`lbr-shell__sidebar${menuOpen ? ' is-open' : ''}`}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? true : undefined}
        aria-label={menuOpen ? 'Admin menu' : undefined}
      >
        <Link
          href={`${base}/tenants`}
          className="lbr-shell__brand"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <Asset name="brand/logo-square" width={28} height={28} />
          <div>
            <div className="lbr-shell__brand-name">Libriant</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>Admin</div>
          </div>
        </Link>
        <nav aria-label="Admin sections" className="lbr-nav">
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
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
        </nav>
        <div className="lbr-shell__footer">
          <div style={{ marginBottom: 'var(--sp-2)' }}>
            <div style={{ fontWeight: 500 }}>{admin.fullName}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
              {admin.role === 'owner' ? 'Owner' : 'Support'}
            </div>
          </div>
          <Button variant="ghost" size="sm" loading={signingOut} onClick={signOut}>
            Sign out
          </Button>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <PoweredBy />
          </div>
        </div>
      </aside>
    </>
  );
}
