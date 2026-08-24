import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { AccountRecoveryClient } from './AccountRecoveryClient';

export const dynamic = 'force-dynamic';

/**
 * launch-readiness-01 — get a librarian back into their library when the email
 * that was meant to do it is sitting undelivered in the outbox.
 *
 * Two things live here, and both exist because `EMAIL_DRIVER=console` means no
 * emailed link ever arrives:
 *
 *   • Confirm an address without the link. `EmailVerifiedGuard` sits on
 *     `POST /t/:slug/staff`, so an owner whose `emailVerifiedAt` is NULL can
 *     never add a second librarian — signup → invite a colleague terminated in
 *     a 403 with no exit.
 *   • Issue a one-time password-reset link and read it back to the person.
 *     Staff have an in-app reset (their admin can mint a temp password); the
 *     library OWNER has nothing else.
 *
 * Owner-admin only and fully audited — see admin-outbox.controller.ts.
 * Admin panel is English-only by convention.
 */
export default async function AdminAccountRecoveryPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();

  return (
    <>
      <PageHeader
        title="Account recovery"
        subtitle="Confirm an address or issue a reset link when the email never arrives."
      />
      <AccountRecoveryClient />
    </>
  );
}
