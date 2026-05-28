'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Asset, Nav } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { LogoutButton } from './LogoutButton';

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  libraryName: string;
  userFullName: string;
};

/**
 * Sidebar shown on every tenant-scoped page. Pages still load their own
 * data; this only handles persistent navigation + a sign-out button.
 *
 * `NavLink` from `@libriant/ui` is a styled `<a>` — we render it through
 * Next's `<Link>` (which itself emits an `<a>`) so client-side routing
 * works and we keep the design-system styling in one place.
 */
export function SidebarNav({ catalog, locale, slug, libraryName, userFullName }: Props) {
  const t = createTranslator(catalog, locale);
  const pathname = usePathname() ?? '';
  const base = `/${locale}/t/${slug}`;
  const links = [
    { href: base, label: t('common.app.name') },
    { href: `${base}/catalog`, label: t('common.nav.catalog') },
    { href: `${base}/members`, label: t('common.nav.members') },
    { href: `${base}/loans`, label: t('common.nav.loans') },
    { href: `${base}/reservations`, label: t('common.nav.reservations') },
    { href: `${base}/billing`, label: 'Billing' },
    { href: `${base}/settings`, label: t('common.nav.settings') },
    { href: `${base}/help`, label: t('common.nav.help') },
  ];

  return (
    <aside className="lbr-shell__sidebar">
      <Link
        href={base}
        className="lbr-shell__brand"
        style={{ textDecoration: 'none', color: 'inherit' }}
      >
        <Asset name="brand/logo-square" width={28} height={28} />
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
      </div>
    </aside>
  );
}
