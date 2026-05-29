import { notFound } from 'next/navigation';
import { Banner, HelpButton, PageHeader } from '@libriant/ui';
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

export default async function SupportAccessPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
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
        help={
          <HelpButton title="How support access works">
            <p>
              Libriant staff <strong>cannot see your library&rsquo;s data by default</strong>. To
              help you with something specific, we need a one-time code you generate here.
            </p>
            <h3>What the code does</h3>
            <ul>
              <li>
                Lasts <strong>1 hour</strong> from generation, and is usable exactly once.
              </li>
              <li>
                When a Libriant engineer redeems it with their two-factor app, it opens a{' '}
                <strong>4-hour session</strong> where they can see and change your data.
              </li>
              <li>
                Every action they take is logged below — you can read it live, or after the fact.
              </li>
            </ul>
            <h3>If something feels off</h3>
            <p>
              You can end the support session immediately with <strong>End support access</strong> —
              the engineer&rsquo;s next click will be blocked. You can also revoke a pending code
              before it&rsquo;s used.
            </p>
            <h3>What we will not do during a session</h3>
            <p>
              Change your billing plan or delete your library — those still require you to act from
              your own account.
            </p>
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
        initialPending={pending}
        initialActive={active}
        initialHistory={history}
      />
    </>
  );
}
