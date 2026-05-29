import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { EndSessionButton } from './EndSessionButton';

export const dynamic = 'force-dynamic';

type ActiveSession = {
  id: string;
  tenant: { id: string; slug: string; name: string };
  startedAt: string;
  expiresAt: string;
} | null;

export default async function AdminSupportHome(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let mfaEnabled = false;
  let session: ActiveSession = null;
  let error: string | null = null;
  try {
    const [mfa, me] = await Promise.all([
      api<{ mfaEnabled: boolean }>('/admin/mfa/status', { cookie }),
      api<{ session: ActiveSession }>('/admin/support/sessions/me', { cookie }),
    ]);
    mfaEnabled = mfa.mfaEnabled;
    session = me.session;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Support access"
        subtitle="Redeem a library's one-time support key to open a 4-hour impersonation session."
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      {!mfaEnabled ? (
        <Banner severity="warning" style={{ marginBottom: 'var(--sp-4)' }}>
          You need an authenticator before you can redeem a key.{' '}
          <Link href={`/${params.locale}/admin/mfa`}>Set one up →</Link>
        </Banner>
      ) : null}

      {session ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader title="Active support session" />
          <CardBody>
            <p style={{ marginTop: 0 }}>
              You are currently impersonating <strong>{session.tenant.name}</strong> (
              <code>{session.tenant.slug}</code>).
            </p>
            <p>
              Started{' '}
              <time dateTime={session.startedAt}>
                {new Date(session.startedAt).toLocaleString()}
              </time>
              ; ends{' '}
              <time dateTime={session.expiresAt}>
                {new Date(session.expiresAt).toLocaleString()}
              </time>
              .
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
              <Link
                href={`/${params.locale}/t/${session.tenant.slug}`}
                className="lbr-btn lbr-btn--primary"
              >
                Open library
              </Link>
              <EndSessionButton />
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Redeem a support key" />
        <CardBody>
          <p style={{ marginTop: 0 }}>
            The librarian will share a code that looks like <code>SUPPORT-XXXXXX</code>. You'll also
            need a fresh 6-digit code from your authenticator.
          </p>
          {mfaEnabled ? (
            <Link
              href={`/${params.locale}/admin/support/redeem`}
              className="lbr-btn lbr-btn--primary"
            >
              Redeem a key
            </Link>
          ) : (
            <span
              className="lbr-btn lbr-btn--primary"
              aria-disabled="true"
              style={{ opacity: 0.6 }}
            >
              Redeem a key
            </span>
          )}
        </CardBody>
      </Card>
    </>
  );
}
