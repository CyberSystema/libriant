import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Asset, PoweredBy } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { optionalSession } from '@/lib/session';
import { LoginForm } from './LoginForm';

export async function generateMetadata(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const lc = isLocale(locale) ? locale : 'en';
  const t = createTranslator(await loadCatalog(lc), lc);
  return { title: `${t('common.actions.signIn')} · Libriant` };
}

export default async function LoginPage(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ slug?: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();

  // Already signed in? Send them straight to their library — saves them a
  // confused "I'm already logged in" loop.
  const session = await optionalSession();
  if (session) redirect(`/${params.locale}/t/${session.tenant.slug}`);

  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  // `?slug=` is how /login/reset hands the reader back after they have set a
  // new password: they have just proved who they are, and being asked for a
  // library address they may never have typed is where that journey stalls.
  const { slug } = await props.searchParams;

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-auth-card__heading">{t('auth.signIn.title')}</h1>
        <p className="lbr-auth-card__subtitle">{t('auth.signIn.subtitle')}</p>

        <LoginForm catalog={catalog} locale={params.locale} initialSlug={slug ?? ''} />

        {/* launch-readiness-01: there was no way out of a forgotten password
            anywhere in the UI — no link, no page. This one goes to
            /login/reset, which lands a break-glass link when the reader has
            one and explains how to get one when they don't. It deliberately
            does not offer to send an e-mail: with EMAIL_DRIVER=console
            nothing is delivered. */}
        <p className="lbr-auth-card__footer">
          <Link href={`/${params.locale}/login/reset`}>{t('auth.signIn.forgot')}</Link>
        </p>

        <p className="lbr-auth-card__footer">
          {t('auth.signIn.dontHaveAccount')}{' '}
          <Link href={`/${params.locale}/signup`}>{t('common.actions.signUp')}</Link>
        </p>
      </div>
      <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
        {/* Reachable before sign-in: a librarian sent here by an en-US browser
            should be able to switch to Greek without editing the URL. */}
        <LocaleSwitcher locale={params.locale} label={t('shell.locale.label')} />
      </div>
      <div style={{ marginTop: 'var(--sp-3)', textAlign: 'center' }}>
        <PoweredBy />
      </div>
    </main>
  );
}
