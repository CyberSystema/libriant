import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { RedeemForm } from './RedeemForm';

export const dynamic = 'force-dynamic';

export default async function AdminRedeemPage(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  return (
    <>
      <PageHeader
        title="Redeem a support key"
        subtitle="Enter the code the library shared with you, plus the current 6-digit code from your authenticator."
      />
      <RedeemForm locale={params.locale} />
    </>
  );
}
