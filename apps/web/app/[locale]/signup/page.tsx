import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Asset, PoweredBy } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession } from '@/lib/session';
import { SignupForm } from './SignupForm';

export async function generateMetadata(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const lc = isLocale(locale) ? locale : 'en';
  const t = createTranslator(await loadCatalog(lc), lc);
  return { title: `${t('common.actions.signUp')} · Libriant` };
}

export default async function SignupPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();

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
        <h1 className="lbr-auth-card__heading">{t('auth.signUp.title')}</h1>
        <p className="lbr-auth-card__subtitle">{t('auth.signUp.subtitle')}</p>

        <SignupForm catalog={catalog} locale={params.locale} />

        <p className="lbr-auth-card__footer">
          {t('auth.signUp.alreadyHaveAccount')}{' '}
          <Link href={`/${params.locale}/login`}>{t('common.actions.signIn')}</Link>
        </p>
      </div>
      <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
        <PoweredBy />
      </div>
    </main>
  );
}
