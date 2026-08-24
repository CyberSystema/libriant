'use client';
import * as React from 'react';
import Link from 'next/link';
import { Banner } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type State =
  | { kind: 'verifying' }
  | { kind: 'done'; mode: 'signup' | 'change'; slug: string | null }
  | { kind: 'error'; message: string };

/**
 * Lands the email-verification link. POSTs the token once on mount, then shows
 * success (with a way back into the library) or an invalid/expired message.
 *
 * The failure branch offers a support address as well as a sign-in link: with
 * no mail provider configured the emailed link may never arrive at all, and a
 * screen that only says "sign in and resend it" would then be a loop with no
 * exit. Writing to a human is the exit.
 */
export function VerifyEmailClient({
  token,
  locale,
  catalog,
}: {
  token: string | null;
  locale: Locale;
  catalog: Catalog;
}) {
  const t = createTranslator(catalog, locale);
  const [state, setState] = React.useState<State>(
    token ? { kind: 'verifying' } : { kind: 'error', message: t('auth.verifyEmail.missingToken') },
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
        setState({ kind: 'error', message: translateApiError(err, t) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the token alone: `t` is rebuilt every render from a
    // stable catalog, and depending on it would re-POST the token.
  }, [token]);

  if (state.kind === 'verifying') {
    return <p className="lbr-auth-card__subtitle">{t('auth.verifyEmail.verifying')}</p>;
  }

  if (state.kind === 'error') {
    return (
      <>
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {state.message}
        </Banner>
        <p className="lbr-auth-card__subtitle">{t('auth.verifyEmail.failedHelp')}</p>
        {/* A styled anchor, not <Link><Button>: a <button> inside an <a> is
            invalid HTML and gives keyboard users two stops where the inner one
            doesn't navigate. */}
        <Link
          href={`/${locale}/login`}
          className="lbr-btn lbr-btn--primary lbr-btn--lg"
          style={{ width: '100%', textDecoration: 'none' }}
        >
          {t('auth.verifyEmail.goSignIn')}
        </Link>
        <p style={{ marginTop: 'var(--sp-3)', textAlign: 'center' }}>
          <a href="mailto:hello@libriant.com">{t('auth.verifyEmail.contactSupport')}</a>
        </p>
      </>
    );
  }

  const dest = state.slug ? `/${locale}/t/${state.slug}` : `/${locale}/login`;
  return (
    <>
      <Banner severity="success" style={{ marginBottom: 'var(--sp-4)' }}>
        {state.mode === 'change'
          ? t('auth.verifyEmail.doneChange')
          : t('auth.verifyEmail.doneSignup')}
      </Banner>
      <Link
        href={dest}
        className="lbr-btn lbr-btn--primary lbr-btn--lg"
        style={{ width: '100%', textDecoration: 'none' }}
      >
        {state.slug ? t('auth.verifyEmail.goLibrary') : t('auth.verifyEmail.goSignIn')}
      </Link>
    </>
  );
}
