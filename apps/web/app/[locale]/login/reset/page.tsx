import { notFound } from 'next/navigation';
import { Asset, PoweredBy } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { ResetPasswordClient } from './ResetPasswordClient';

export async function generateMetadata(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const lc = isLocale(locale) ? locale : 'en';
  const t = createTranslator(await loadCatalog(lc), lc);
  return {
    title: `${t('auth.resetPassword.pageTitle')} · Libriant`,
    // A reset URL must never be crawled, cached or summarised by anything.
    robots: { index: false, follow: false },
  };
}

/**
 * `/<locale>/login/reset` — where a password-reset link lands.
 *
 * launch-readiness-01: this is the landing page for the URL that
 * `POST /admin/account-recovery/users/:id/reset-link` mints and that
 * `PasswordResetService` composes into the reset e-mail. It did not exist for
 * two rounds of remediation, so the operator's break-glass procedure ended in a
 * 404 — see ResetPasswordClient for the full history and for why the token is
 * read in the browser rather than from `searchParams` here.
 *
 * Public and NOT session-gated, deliberately. `/login` bounces a signed-in
 * visitor to their library; this page must not, because the commonest reason to
 * be here is a stale session on a shared circulation-desk machine.
 */
export default async function ResetPasswordPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  if (!isLocale(locale)) notFound();

  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        {/* The page title, not "choose a new password": the same card also
            renders the "you have no link — here is how to get one" panel, and
            a heading that assumed the happy path sat over prose contradicting
            it. The form states its own instruction in the subtitle. */}
        <h1 className="lbr-auth-card__heading">{t('auth.resetPassword.pageTitle')}</h1>
        <ResetPasswordClient locale={locale} catalog={catalog} />
      </div>
      <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
        <LocaleSwitcher locale={locale} label={t('shell.locale.label')} />
      </div>
      <div style={{ marginTop: 'var(--sp-3)', textAlign: 'center' }}>
        <PoweredBy />
      </div>
    </main>
  );
}
