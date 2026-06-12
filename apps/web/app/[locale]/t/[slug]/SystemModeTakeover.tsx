import { Asset } from '@libriant/ui';
import { createTranslator, type Catalog, type Locale } from '@libriant/i18n';
import type { ResolvedSystemMode, SystemModeKind } from '@/lib/system-mode';

type Props = {
  mode: ResolvedSystemMode;
  catalog: Catalog;
  locale: Locale;
};

/**
 * Brand-aware takeover served when the tenant layout detects a
 * maintenance or out-of-order mode. Renders BEFORE any tenant data
 * fetch — no `/auth/me`, no API calls beyond `/system-mode/current`
 * which is exempt from the middleware blocker.
 *
 * Copy comes from the shared `system` namespace (reused with the public
 * system pages) so it stays bilingual and consistent.
 */
export function SystemModeTakeover({ mode, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const kind = mode.mode as Exclude<SystemModeKind, 'normal' | 'read_only' | 'under_construction'>;
  const ns = kind === 'maintenance' ? 'maintenance' : 'outage';
  const endsAt = mode.endsAt ? new Date(mode.endsAt) : null;
  const illustration =
    kind === 'maintenance' ? 'illustrations/maintenance' : 'illustrations/outage';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-6)',
        background: 'var(--color-surface)',
      }}
    >
      <div style={{ maxWidth: 560, textAlign: 'center' }}>
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Asset name={illustration} width={240} height={180} />
        </div>
        <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: 'var(--sp-2)' }}>
          {t(`system.${ns}.title`)}
        </h1>
        <p
          style={{
            fontSize: 'var(--fs-lg)',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          {t(`system.${ns}.description`, {
            time: endsAt ? endsAt.toLocaleString() : t('system.takeover.soon'),
          })}
        </p>
        {mode.messageMarkdown ? (
          <div
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--color-surface-muted)',
              borderRadius: 'var(--radius-md)',
              whiteSpace: 'pre-wrap',
              textAlign: 'left',
              fontSize: 'var(--fs-sm)',
            }}
          >
            {mode.messageMarkdown}
          </div>
        ) : null}
        <p
          style={{
            marginTop: 'var(--sp-4)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--color-text-muted)',
          }}
        >
          {t('system.takeover.statusRef')}: <code>{mode.eventId ?? 'global'}</code> · {mode.source}
        </p>
      </div>
    </div>
  );
}
