import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Asset, PoweredBy } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession } from '@/lib/session';
import { LoginForm } from './LoginForm';

export const metadata = {
  title: 'Sign in · Libriant',
};

export default async function LoginPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();

  // Already signed in? Send them straight to their library — saves them a
  // confused "I'm already logged in" loop.
  const session = await currentSession();
  if (session) redirect(`/${params.locale}/t/${session.tenant.slug}`);

  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-auth-card__heading">{t('auth.signIn.title')}</h1>
        <p className="lbr-auth-card__subtitle">{t('auth.signIn.subtitle')}</p>

        <LoginForm catalog={catalog} locale={params.locale} />

        <p className="lbr-auth-card__footer">
          {t('auth.signIn.dontHaveAccount')}{' '}
          <Link href={`/${params.locale}/signup`}>{t('common.actions.signUp')}</Link>
        </p>
      </div>
      <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
        <PoweredBy />
      </div>
    </main>
  );
}
