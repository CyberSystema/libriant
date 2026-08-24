import { notFound } from 'next/navigation';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { requestCookieHeader } from '@/lib/session';
import { SupportAccessPanel } from './SupportAccessPanel';

export const dynamic = 'force-dynamic';

type PendingKey = { id: string; prefix: string; generatedAt: string; expiresAt: string } | null;
type ActiveSession = {
  id: string;
  startedAt: string;
  expiresAt: string;
  admin: { id: string; email: string; fullName: string };
} | null;
type SessionLogEntry = {
  id: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  admin: { email: string; fullName: string };
  actions: Array<{
    id: string;
    ts: string;
    method: string;
    path: string;
    status: number;
    targetType: string | null;
    targetId: string | null;
  }>;
};

export default async function SupportAccessPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();
  const slug = params.slug;

  let pending: PendingKey = null;
  let active: ActiveSession = null;
  let history: SessionLogEntry[] = [];
  let error: string | null = null;
  try {
    const [p, a, l] = await Promise.all([
      api<{ key: PendingKey }>(`/t/${slug}/support/keys/pending`, { cookie }),
      api<{ session: ActiveSession }>(`/t/${slug}/support/sessions/active`, { cookie }),
      api<{ sessions: SessionLogEntry[] }>(`/t/${slug}/support/sessions/log`, { cookie }),
    ]);
    pending = p.key;
    active = a.session;
    history = l.sessions;
  } catch (err) {
    error = translateApiError(err, t, t('errors.generic.title'));
  }

  return (
    <>
      <PageHeader
        title={t('support.title')}
        subtitle={t('support.subtitle')}
        help={
          <HelpButton title={t('support.access.help.title')}>
            <p>{t('support.access.help.intro')}</p>
            <h3>{t('support.access.help.whatTitle')}</h3>
            <ul>
              <li>{t('support.access.help.what1')}</li>
              <li>{t('support.access.help.what2')}</li>
              <li>{t('support.access.help.what3')}</li>
            </ul>
            <h3>{t('support.access.help.offTitle')}</h3>
            <p>{t('support.access.help.offBody')}</p>
            <h3>{t('support.access.help.wontTitle')}</h3>
            <p>{t('support.access.help.wontBody')}</p>
          </HelpButton>
        }
      />
      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}
      <SupportAccessPanel
        slug={slug}
        catalog={catalog}
        locale={params.locale}
        initialPending={pending}
        initialActive={active}
        initialHistory={history}
      />
    </>
  );
}
