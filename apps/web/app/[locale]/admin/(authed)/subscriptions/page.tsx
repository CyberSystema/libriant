import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, HelpButton, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { SubscriptionsToggle, type SubscriptionsStatus } from './SubscriptionsToggle';

export const dynamic = 'force-dynamic';

export default async function AdminSubscriptionsPage(props: {
  params: Promise<{ locale: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let status: SubscriptionsStatus | null = null;
  let error: string | null = null;
  try {
    status = await api<SubscriptionsStatus>('/admin/subscriptions', { cookie });
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle="The master switch for paid plans. While it's off, every library has free, unlimited access and is never asked to pick a plan or enter payment details."
        help={
          <HelpButton title="How the switch works">
            <h3>Off (free for everyone)</h3>
            <p>
              All plan limits and quotas are lifted, Stripe is never involved, and the billing page
              shows a simple &quot;everything&apos;s included&quot; notice. New libraries sign up
              without choosing a plan.
            </p>
            <h3>On (plans enforced)</h3>
            <p>
              Every library that hasn&apos;t explicitly chosen a plan — including all current
              libraries and any new signup — is shown a full-page chooser and can&apos;t use the app
              until they pick one. Free plans apply instantly; paid plans go through Stripe Checkout
              to capture a payment method. Plan limits apply the moment a plan is chosen.
            </p>
            <p>
              This setting lives in the database and takes effect within ~30 seconds — no redeploy.
            </p>
          </HelpButton>
        }
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      {status ? (
        <Card>
          <CardHeader title="Master switch" />
          <CardBody>
            <SubscriptionsToggle initial={status} />
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
