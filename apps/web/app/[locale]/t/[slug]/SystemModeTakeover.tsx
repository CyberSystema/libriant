import { Asset, Banner } from '@libriant/ui';
import type { ResolvedSystemMode, SystemModeKind } from '@/lib/system-mode';

type Props = {
  mode: ResolvedSystemMode;
};

const COPY: Record<
  'maintenance' | 'out_of_order',
  {
    title: string;
    lead: string;
    illustration: 'illustrations/maintenance' | 'illustrations/outage';
  }
> = {
  maintenance: {
    title: "We're upgrading Libriant",
    lead: "We're making things better behind the scenes. Your library will be back shortly.",
    illustration: 'illustrations/maintenance',
  },
  out_of_order: {
    title: 'Libriant is temporarily unavailable',
    lead: 'Something unexpected came up. Our team is on it.',
    illustration: 'illustrations/outage',
  },
};

/**
 * Brand-aware takeover served when the tenant layout detects a
 * maintenance or out-of-order mode. Renders BEFORE any tenant data
 * fetch — no `/auth/me`, no API calls beyond `/system-mode/current`
 * which is exempt from the middleware blocker.
 */
export function SystemModeTakeover({ mode }: Props) {
  const kind = mode.mode as Exclude<SystemModeKind, 'normal' | 'read_only' | 'under_construction'>;
  const copy = COPY[kind];
  const endsAt = mode.endsAt ? new Date(mode.endsAt) : null;

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
          <Asset name={copy.illustration} width={240} height={180} />
        </div>
        <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: 'var(--sp-2)' }}>{copy.title}</h1>
        <p
          style={{
            fontSize: 'var(--fs-lg)',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          {copy.lead}
        </p>
        {endsAt ? (
          <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
            Expected back online by{' '}
            <strong>
              <time dateTime={endsAt.toISOString()}>{endsAt.toLocaleString()}</time>
            </strong>
            .
          </Banner>
        ) : null}
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
          Status reference: <code>{mode.eventId ?? 'global'}</code> · {mode.source}
        </p>
      </div>
    </div>
  );
}
