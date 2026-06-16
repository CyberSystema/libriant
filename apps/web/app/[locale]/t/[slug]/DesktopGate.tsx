'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { useDrawerA11y } from '@/lib/useDrawerA11y';
import { LogoutButton } from './LogoutButton';

/**
 * Hard runtime gate for the desktop shell. When the request came from the
 * Electron shell (server-detected via the `LibriantDesktop/` User-Agent) AND the
 * tenant isn't entitled to the desktop app, `blocked` is true and we overlay the
 * whole workspace with an upgrade screen — the desktop app is a paid feature
 * once subscriptions are on.
 *
 * `blocked` is computed on the server, so the overlay is in the initial HTML (no
 * flash of the workspace). We exempt the BILLING route via `usePathname()` so a
 * blocked user can still reach the upgrade flow — otherwise the gate would trap
 * them with no way to fix it. In a browser `blocked` is always false (the gate
 * only applies to the shell), so this renders nothing.
 */
export function DesktopGate({
  blocked,
  locale,
  slug,
  catalog,
  libraryName,
}: {
  blocked: boolean;
  locale: Locale;
  slug: string;
  catalog: Catalog;
  libraryName: string;
}) {
  const t = createTranslator(catalog, locale);
  const pathname = usePathname() ?? '';
  const billingBase = `/${locale}/t/${slug}/billing`;
  const active = blocked && !pathname.startsWith(billingBase);

  // Trap focus + lock scroll while the block is up so keyboard/screen-reader
  // users can't tab to the workspace behind the overlay (it's still in the DOM).
  // No Escape-dismiss — this is a hard block, not a closable dialog.
  const gateRef = useDrawerA11y<HTMLDivElement>(active, () => {});

  if (!active) return null;

  return (
    <div
      ref={gateRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('common.desktop.gateTitle')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--color-surface-muted, #f6f8fa)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <div className="lbr-choose" style={{ maxWidth: 520, textAlign: 'center' }}>
        <h1 className="lbr-choose__title">{libraryName}</h1>
        <h2 style={{ margin: 'var(--sp-3) 0 var(--sp-2)' }}>{t('common.desktop.gateTitle')}</h2>
        <p className="lbr-choose__subtitle">{t('common.desktop.gateBody')}</p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-2)',
            justifyContent: 'center',
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: 'var(--sp-4)',
          }}
        >
          <Link href={billingBase} className="lbr-btn lbr-btn--primary lbr-btn--md">
            {t('common.desktop.upgradeCta')}
          </Link>
          <LogoutButton catalog={catalog} locale={locale} />
        </div>
      </div>
    </div>
  );
}
