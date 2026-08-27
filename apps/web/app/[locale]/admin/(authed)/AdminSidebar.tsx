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
  /**
   * Applications nobody has read yet (launch-readiness-03). Rendered as a
   * count beside the Applications link — the whole point of the page is that a
   * library's application no longer waits for someone to think of looking, and
   * a nav entry with no number would be exactly that. `null` when the count
   * could not be read (a support admin is refused it, the API is down): the
   * badge disappears rather than claiming zero.
   */
  applicationsUnread: number | null;
};

/** Persistent sidebar for the admin shell — distinct from the tenant sidebar. */
export function AdminSidebar({ admin, applicationsUnread }: Props) {
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

  const links: Array<{ href: string; label: string; badge?: number }> = [
    { href: `${base}/tenants`, label: 'Tenants' },
    // launch-readiness-03: applications from the public form used to reach
    // Postgres and stop there — no notification that survives
    // EMAIL_DRIVER=console, and no page in this menu. First in the list after
    // the libraries themselves, because during the campaign it is the thing
    // with a two-working-day promise attached to it.
    {
      href: `${base}/applications`,
      label: 'Applications',
      badge: applicationsUnread ?? undefined,
    },
    { href: `${base}/library-requests`, label: 'Library requests' },
    { href: `${base}/fleet`, label: 'Capacity' },
    { href: `${base}/plans`, label: 'Plans' },
    { href: `${base}/subscriptions`, label: 'Subscriptions' },
    { href: `${base}/announcements`, label: 'Announcements' },
    { href: `${base}/system-mode`, label: 'System mode' },
    { href: `${base}/maintenance`, label: 'Maintenance' },
    { href: `${base}/export`, label: 'Export' },
    // launch-readiness-01: with EMAIL_DRIVER=console nothing Libriant composes
    // is delivered, so "read the mail" and "get someone back in without the
    // emailed link" are day-one operator tasks, not obscure ones. They sit in
    // the main nav for that reason.
    { href: `${base}/emails`, label: 'Emails' },
    { href: `${base}/account-recovery`, label: 'Account recovery' },
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
                {l.badge ? (
                  // Counted in the accessible name too — a screen-reader user
                  // gets "Applications, 3 unread", not a decorative number.
                  <span
                    style={{
                      marginLeft: 'auto',
                      background: 'var(--color-primary)',
                      color: 'var(--color-primary-fg)',
                      borderRadius: '999px',
                      padding: '0 var(--sp-2)',
                      fontSize: 'var(--fs-xs)',
                      lineHeight: '1.6',
                    }}
                  >
                    {l.badge}
                    <span className="lbr-visually-hidden"> unread</span>
                  </span>
                ) : null}
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
