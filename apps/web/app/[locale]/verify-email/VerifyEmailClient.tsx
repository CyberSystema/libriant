'use client';
import * as React from 'react';
import Link from 'next/link';
import { Banner, Button } from '@libriant/ui';
import type { Locale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

type State =
  | { kind: 'verifying' }
  | { kind: 'done'; mode: 'signup' | 'change'; slug: string | null }
  | { kind: 'error'; message: string };

/**
 * Lands the email-verification link. POSTs the token once on mount, then shows
 * success (with a way back into the library) or an invalid/expired message.
 */
export function VerifyEmailClient({ token, locale }: { token: string | null; locale: Locale }) {
  const [state, setState] = React.useState<State>(
    token ? { kind: 'verifying' } : { kind: 'error', message: 'This link is missing its token.' },
  );

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ ok: boolean; mode: 'signup' | 'change'; slug: string | null }>(
          '/auth/verify-email',
          { method: 'POST', body: { token } },
        );
        if (!cancelled) setState({ kind: 'done', mode: res.mode, slug: res.slug });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message:
            err instanceof ApiError ? err.message : 'Could not verify right now. Please try again.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === 'verifying') {
    return <p className="lbr-auth-card__subtitle">Verifying your email…</p>;
  }

  if (state.kind === 'error') {
    return (
      <>
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {state.message}
        </Banner>
        <p className="lbr-auth-card__subtitle">
          The link may have expired or already been used. Sign in and resend it from the banner in
          your library.
        </p>
        <Link href={`/${locale}/login`}>
          <Button variant="primary" size="lg" style={{ width: '100%' }}>
            Go to sign in
          </Button>
        </Link>
      </>
    );
  }

  const dest = state.slug ? `/${locale}/t/${state.slug}` : `/${locale}/login`;
  return (
    <>
      <Banner severity="success" style={{ marginBottom: 'var(--sp-4)' }}>
        {state.mode === 'change'
          ? 'Your new email address is confirmed.'
          : 'Your email is verified — thank you!'}
      </Banner>
      <Link href={dest}>
        <Button variant="primary" size="lg" style={{ width: '100%' }}>
          {state.slug ? 'Go to your library' : 'Go to sign in'}
        </Button>
      </Link>
    </>
  );
}
