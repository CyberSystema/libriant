import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
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

export default async function SupportAccessPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
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
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Get help from Libriant"
        subtitle="Give our team time-limited access so we can help you fix something. You can end access at any time."
      />
      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}
      <SupportAccessPanel
        slug={slug}
        initialPending={pending}
        initialActive={active}
        initialHistory={history}
      />
    </>
  );
}
