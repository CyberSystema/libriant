'use client';
import * as React from 'react';
import Link from 'next/link';
import { Banner, Button, FormField, Input } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

/** Mirrors PasswordResetCompleteDto's `@MinLength(12)` — the server is the authority. */
const MIN_PASSWORD = 12;

type Credential = { token: string; slug: string | null };

/**
 * Pull the reset credential out of the address bar.
 *
 * THE FRAGMENT IS READ FIRST, AND THAT IS THE POINT (privacy-legal-06). A
 * `?token=` lands in Caddy's site-wide JSON access log as `request.uri`, and
 * `scripts/backup.sh` tars `/var/log/caddy` into the nightly backup — so a
 * query-string reset link is a working credential sitting in a log file and in
 * every backup for as long as the token lives. Everything after `#` is never
 * sent to the server, so a fragment link is spendable only by the person
 * holding it.
 *
 * The query string is still accepted, because links minted before this page
 * existed — and the one `PasswordResetService` composes for e-mail — use it.
 * A token that arrives that way is moved into the fragment immediately (see
 * below): the edge log has already seen it, but the browser history, the
 * address bar and any `Referer` this page emits have not.
 */
function readCredential(): Credential | null {
  if (typeof window === 'undefined') return null;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromQuery = new URLSearchParams(window.location.search);
  const token = fromHash.get('token') ?? fromQuery.get('token');
  if (!token) return null;
  return { token, slug: fromHash.get('slug') ?? fromQuery.get('slug') };
}

type State =
  | { kind: 'form' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'no-token' }
  | { kind: 'dead'; message: string };

/**
 * Completes a password reset (`POST /auth/password-reset/complete`).
 *
 * WHY THIS PAGE EXISTS AT ALL — launch-readiness-01. Libriant ships with
 * `EMAIL_DRIVER=console`: nothing is delivered. The operator's escape hatch is
 * `POST /admin/account-recovery/users/:id/reset-link`, which returns a URL the
 * operator reads back to the librarian on the phone. That URL pointed here for
 * two rounds of remediation and THIS ROUTE DID NOT EXIST — the librarian got a
 * Next.js 404, and the only way to spend a valid token was a hand-built curl
 * that no document described. The recovery path that exists *because* mail is
 * not delivered was itself a dead end.
 *
 * Opened without a token it is the "I can't sign in" self-help page instead.
 * It deliberately does NOT offer to e-mail a link: with the console driver
 * that request succeeds, sends nothing, and leaves the reader waiting on a
 * message that will never arrive.
 */
export function ResetPasswordClient({ locale, catalog }: { locale: Locale; catalog: Catalog }) {
  const t = createTranslator(catalog, locale);
  const [credential, setCredential] = React.useState<Credential | null>(null);
  // Starts on the form, not on a spinner: a fragment is invisible to the
  // server, so the first paint cannot know whether there is a token, and
  // arriving WITH a link is what this page is for. The effect below switches
  // to the self-help panel within the same frame when there isn't one.
  const [state, setState] = React.useState<State>({ kind: 'form' });
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [fieldError, setFieldError] = React.useState<{ password?: string; confirm?: string }>({});

  // The token is read in an effect, not from `searchParams` on the server,
  // for two reasons: a fragment is invisible to the server by definition, and
  // a token passed through a server render would be baked into the HTML.
  React.useEffect(() => {
    function pickUpLink() {
      const found = readCredential();
      if (!found) {
        // Only downgrade the first, tokenless load. A `hashchange` arriving
        // after a completed reset must not drag the reader back to a form.
        setState((s) => (s.kind === 'form' ? { kind: 'no-token' } : s));
        return;
      }
      setCredential(found);
      setState((s) => (s.kind === 'no-token' || s.kind === 'dead' ? { kind: 'form' } : s));
      // Take the credential out of the query string. `replaceState` (not
      // `push`) so Back does not walk the reader onto the version of this URL
      // that still carries the token.
      if (new URLSearchParams(window.location.search).has('token')) {
        const hash = new URLSearchParams({ token: found.token });
        if (found.slug) hash.set('slug', found.slug);
        window.history.replaceState(null, '', `${window.location.pathname}#${hash}`);
      }
    }

    pickUpLink();
    // THE HASHCHANGE LISTENER IS NOT DECORATION. The likeliest way this page is
    // reached without a link is the "Forgot your password?" link on /login —
    // and the next thing that happens is the operator reads the break-glass URL
    // out and the reader pastes it into THAT SAME TAB. Only the fragment
    // differs, so the browser fires `hashchange` and navigates nowhere: React
    // never remounts, and without this the reader would go on staring at "you
    // have no link" while holding one.
    window.addEventListener('hashchange', pickUpLink);
    return () => window.removeEventListener('hashchange', pickUpLink);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!credential) return;
    const next: { password?: string; confirm?: string } = {};
    if (password.length < MIN_PASSWORD) {
      next.password = t('auth.errors.passwordTooShort', { min: MIN_PASSWORD });
    }
    if (confirm !== password) next.confirm = t('auth.firstLogin.pwMismatch');
    setFieldError(next);
    if (Object.keys(next).length) return;

    setState({ kind: 'submitting' });
    try {
      await api<{ ok: boolean }>('/auth/password-reset/complete', {
        method: 'POST',
        body: { token: credential.token, newPassword: password },
      });
      // Drop the spent token off the URL: it is single-use (the server GETDELs
      // it), so leaving it in place only invites a confusing second attempt.
      window.history.replaceState(null, '', window.location.pathname);
      setState({ kind: 'done' });
    } catch (err) {
      // The API answers 404 for "consumed, expired, or never existed" — it
      // cannot tell them apart, and neither should we.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        setState({ kind: 'dead', message: t('auth.resetPassword.expired') });
        return;
      }
      setState({ kind: 'dead', message: translateApiError(err, t) });
    }
  }

  const signInHref = credential?.slug
    ? `/${locale}/login?slug=${encodeURIComponent(credential.slug)}`
    : `/${locale}/login`;

  if (state.kind === 'done') {
    return (
      <>
        <Banner severity="success" style={{ marginBottom: 'var(--sp-4)' }}>
          {t('auth.resetPassword.done')}
        </Banner>
        {/* A styled anchor, not <Link><Button>: a <button> inside an <a> is
            invalid HTML and gives keyboard users two stops where the inner one
            doesn't navigate. */}
        <Link
          href={signInHref}
          className="lbr-btn lbr-btn--primary lbr-btn--lg"
          style={{ width: '100%', textDecoration: 'none' }}
        >
          {t('auth.verifyEmail.goSignIn')}
        </Link>
      </>
    );
  }

  if (state.kind === 'no-token' || state.kind === 'dead') {
    return (
      <>
        {state.kind === 'dead' ? (
          <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
            {state.message}
          </Banner>
        ) : null}
        <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 var(--sp-2)' }}>
          {t('auth.resetPassword.help.title')}
        </h2>
        <p className="lbr-auth-card__subtitle">{t('auth.resetPassword.help.staff')}</p>
        <p className="lbr-auth-card__subtitle">{t('auth.resetPassword.help.owner')}</p>
        <p style={{ margin: 'var(--sp-3) 0', textAlign: 'center' }}>
          <a href="mailto:hello@libriant.com">{t('auth.verifyEmail.contactSupport')}</a>
        </p>
        <Link
          href={`/${locale}/login`}
          className="lbr-btn lbr-btn--primary lbr-btn--lg"
          style={{ width: '100%', textDecoration: 'none' }}
        >
          {t('auth.verifyEmail.goSignIn')}
        </Link>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h2 style={{ fontSize: 'var(--fs-md)', margin: '0 0 var(--sp-2)' }}>
        {t('auth.resetPassword.heading')}
      </h2>
      <p className="lbr-auth-card__subtitle">{t('auth.resetPassword.subtitle')}</p>
      {credential?.slug ? (
        <p className="lbr-auth-card__subtitle">
          {t('auth.resetPassword.forLibrary', { slug: credential.slug })}
        </p>
      ) : null}

      <FormField
        id="reset-password"
        label={t('auth.resetPassword.newPassword')}
        hint={t('auth.resetPassword.newPasswordHint', { min: MIN_PASSWORD })}
        required
        error={fieldError.password}
      >
        <Input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </FormField>

      <FormField
        id="reset-confirm"
        label={t('auth.resetPassword.confirm')}
        required
        error={fieldError.confirm}
      >
        <Input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
        />
      </FormField>

      <Button
        type="submit"
        loading={state.kind === 'submitting'}
        style={{ width: '100%' }}
        size="lg"
      >
        {t('auth.resetPassword.submit')}
      </Button>
    </form>
  );
}
