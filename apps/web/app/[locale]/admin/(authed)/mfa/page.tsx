import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { MfaEnrollForm } from './MfaEnrollForm';

export const dynamic = 'force-dynamic';

export default async function AdminMfaPage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let mfaEnabled = false;
  let error: string | null = null;
  try {
    const res = await api<{ mfaEnabled: boolean }>('/admin/mfa/status', { cookie });
    mfaEnabled = res.mfaEnabled;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Authenticator (MFA)"
        subtitle="Required before you can redeem a library's support key. Use any TOTP app (Google Authenticator, 1Password, Bitwarden, Authy, …)."
      />
      <MfaEnrollForm initialEnabled={mfaEnabled} initialError={error} />
    </>
  );
}
