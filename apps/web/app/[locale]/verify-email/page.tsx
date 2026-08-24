import { notFound } from 'next/navigation';
import { Asset, PoweredBy } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { VerifyEmailClient } from './VerifyEmailClient';

export async function generateMetadata(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const lc = isLocale(locale) ? locale : 'en';
  const t = createTranslator(await loadCatalog(lc), lc);
  return { title: `${t('common.app.name')} · ${t('auth.verifyEmail.pageTitle')}` };
}

/**
 * Email-verification landing page (`/<locale>/verify-email?token=…`). Public —
 * the token is the credential. The client child POSTs it to /auth/verify-email
 * and shows the result. Tenant-agnostic so signup, email-change, and resent
 * links all land here regardless of which library the user belongs to.
 *
 * This is the first screen a new library owner sees after signing up, so it
 * takes the catalogue like every other page: it used to be hardcoded English
 * inside a document declaring `lang="el"`.
 */
export default async function VerifyEmailPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ locale }, { token }] = await Promise.all([props.params, props.searchParams]);
  if (!isLocale(locale)) notFound();

  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-auth-card__heading">{t('auth.verifyEmail.heading')}</h1>
        <VerifyEmailClient token={token ?? null} locale={locale} catalog={catalog} />
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
