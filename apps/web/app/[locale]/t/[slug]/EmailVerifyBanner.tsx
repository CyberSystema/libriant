'use client';
import * as React from 'react';
import { Banner, Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

/**
 * Soft email-verification nudge. Shown in the tenant shell while the signed-in
 * user's email is unverified (`/auth/me` → `user.emailVerified === false`).
 * The owner can still use the library; verification-sensitive actions (inviting
 * staff, …) are blocked by the API until they click the link. The button
 * re-sends it. Mirrors the API's soft-gate decision.
 *
 * Two things this must not do, because with `EMAIL_DRIVER=console` the mail
 * only reaches the server log: promise the owner that a message landed in their
 * inbox, and pin an un-closable warning to every page for the rest of their
 * working life. So the copy names the fallback (write to us and we'll confirm
 * the address) and the banner can be dismissed for the session — it comes back
 * on the next sign-in, which is nagging enough.
 */
export function EmailVerifyBanner({
  email,
  catalog,
  locale,
}: {
  email: string | null;
  catalog: Catalog;
  locale: Locale;
}) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);

  async function resend() {
    setBusy(true);
    try {
      await api('/auth/verify-email/resend', { method: 'POST' });
      setSent(true);
      toast.show({
        severity: 'success',
        title: email
          ? t('auth.verifyEmail.banner.resentToast', { email })
          : t('auth.verifyEmail.banner.resentToastNoEmail'),
      });
    } catch (err) {
      toast.show({ severity: 'critical', title: translateApiError(err, t) });
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  return (
    <Banner
      severity="warning"
      style={{ marginBottom: 'var(--sp-3)' }}
      onDismiss={() => setHidden(true)}
      dismissLabel={t('auth.verifyEmail.banner.dismiss')}
    >
      <span>
        <strong>{t('auth.verifyEmail.banner.title')}</strong>{' '}
        {email
          ? t('auth.verifyEmail.banner.body', { email })
          : t('auth.verifyEmail.banner.bodyNoEmail')}{' '}
        {t('auth.verifyEmail.banner.fallback')}
      </span>{' '}
      <Button variant="ghost" size="sm" loading={busy} disabled={sent} onClick={resend}>
        {sent ? t('auth.verifyEmail.banner.resent') : t('auth.verifyEmail.banner.resend')}
      </Button>{' '}
      <a href="mailto:hello@libriant.com">{t('auth.verifyEmail.contactSupport')}</a>
    </Banner>
  );
}
