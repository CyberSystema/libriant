'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Asset } from '@libriant/ui';
import { safeLocale, staticTranslator } from '@/lib/static-catalog';

/**
 * Error boundary for every locale-prefixed route — the tenant workspace, the
 * auth cards, the admin plane, the legal pages.
 *
 * Before this existed, any throw from a server component escaped to Next's
 * built-in `DefaultGlobalError`, which is an unstyled English page reading
 * "This page couldn't load" with no branding, no Greek and no way back. That
 * was reachable in normal operation: `currentSession()` rethrows anything that
 * is not a 401/403/404, so a librarian whose browser carried a session cookie
 * got a bare 500 on /login the moment the API was unreachable.
 *
 * Recoverable on purpose: the retry button calls `reset()`, which re-renders
 * the segment without a full reload, and the link beside it always works
 * because it is a Next route rather than an API call.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const locale = safeLocale(params?.locale);
  const t = staticTranslator(locale);

  React.useEffect(() => {
    // The digest is all the client is given; the stack is on the server. Log it
    // so the reference the user reads out matches something we can grep for.
    console.error('[libriant] render failed', error.digest ?? error.message);
  }, [error]);

  return (
    <main
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
          <Asset name="illustrations/outage" width={240} height={180} />
        </div>
        <h1 style={{ fontSize: 'var(--fs-2xl)', marginBottom: 'var(--sp-2)' }}>
          {t('system.crash.title')}
        </h1>
        <p
          style={{
            fontSize: 'var(--fs-lg)',
            color: 'var(--color-text-muted)',
            marginBottom: 'var(--sp-5)',
          }}
        >
          {t('system.crash.description')}
        </p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-2)',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button type="button" className="lbr-btn lbr-btn--primary lbr-btn--md" onClick={reset}>
            {t('system.crash.retry')}
          </button>
          <Link href={`/${locale}`} className="lbr-btn lbr-btn--secondary lbr-btn--md">
            {t('system.crash.home')}
          </Link>
        </div>
        {error.digest ? (
          <p
            style={{
              marginTop: 'var(--sp-5)',
              fontSize: 'var(--fs-xs)',
              color: 'var(--color-text-muted)',
            }}
          >
            {t('system.crash.reference')}: <code>{error.digest}</code>
            {' · '}
            <a href={`mailto:hello@libriant.com?subject=${encodeURIComponent(error.digest)}`}>
              {t('system.crash.support')}
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}
