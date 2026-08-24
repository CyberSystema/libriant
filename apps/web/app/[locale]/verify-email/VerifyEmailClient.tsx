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
 * The verification token, from the URL fragment first and the query string
 * second.
 *
 * privacy-legal-06: `?token=` is recorded verbatim by Caddy's site-wide JSON
 * access log (`request.uri`) and `scripts/backup.sh` tars that directory into
 * the nightly backup — so a query-string verification link is a live
 * credential (24 h TTL) sitting in a log file. Everything after `#` is never
 * transmitted. The query form is still honoured because that is what
 * `EmailVerificationService` composes into the message body today; a token
 * that arrives that way is moved into the fragment straight away, which cannot
 * un-log it at the edge but does keep it out of the address bar, the browser
 * history and any `Referer` this page emits.
 *
 * The same two-source read lives in login/reset/ResetPasswordClient.tsx. Kept
 * duplicated rather than shared: these are the only two credential landings in
 * the app, and each one is a few lines whose reasoning belongs next to it.
 */
function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (fromHash) return fromHash;
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery) {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}#${new URLSearchParams({ token: fromQuery })}`,
    );
  }
  return fromQuery;
}

/**
 * Lands the email-verification link. POSTs the token once on mount, then shows
 * success (with a way back into the library) or an invalid/expired message.
 *
 * The failure branch offers a support address as well as a sign-in link: with
 * no mail provider configured the emailed link may never arrive at all, and a
 * screen that only says "sign in and resend it" would then be a loop with no
 * exit. Writing to a human is the exit.
 */
export function VerifyEmailClient({ locale, catalog }: { locale: Locale; catalog: Catalog }) {
  const t = createTranslator(catalog, locale);
  // Starts as "verifying" because the token can only be read in the browser
  // (a fragment never reaches the server), so the first paint cannot know yet
  // whether there is one. The effect below settles it on the same tick.
  const [state, setState] = React.useState<State>({ kind: 'verifying' });

  React.useEffect(() => {
    let cancelled = false;
    // Every token this mount has already spent. A `hashchange` that carries
    // the same one must not POST it a second time — the endpoint consumes it
    // on first use, so the replay would report "invalid or expired" over a
    // verification that had just succeeded.
    const attempted = new Set<string>();

    async function redeem() {
      const token = readToken();
      if (!token) {
        setState({ kind: 'error', message: t('auth.verifyEmail.missingToken') });
        return;
      }
      if (attempted.has(token)) return;
      attempted.add(token);
      setState({ kind: 'verifying' });
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
    }

    void redeem();
    // Pasting a link into the address bar of a tab already on this page changes
    // only the fragment: `hashchange`, no navigation, no remount. Without this
    // the reader would sit on "this link is missing its confirmation code"
    // while holding a perfectly good link.
    const onHashChange = () => void redeem();
    window.addEventListener('hashchange', onHashChange);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHashChange);
    };
    // Runs exactly once. `t` is rebuilt every render from a stable catalog, so
    // depending on it would re-POST a single-use token on every re-render.
  }, []);

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
