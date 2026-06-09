'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Asset, Button, PoweredBy, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
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
  const base = '/admin';

  const links = [
    { href: `${base}/tenants`, label: 'Tenants' },
    { href: `${base}/fleet`, label: 'Capacity' },
    { href: `${base}/plans`, label: 'Plans' },
    { href: `${base}/subscriptions`, label: 'Subscriptions' },
    { href: `${base}/announcements`, label: 'Announcements' },
    { href: `${base}/system-mode`, label: 'System mode' },
    { href: `${base}/maintenance`, label: 'Maintenance' },
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
    router.push(`/admin/login`);
    router.refresh();
  }

  return (
    <aside className="lbr-shell__sidebar">
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
  );
}
