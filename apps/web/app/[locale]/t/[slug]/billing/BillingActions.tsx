'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  canOpenPortal: boolean;
  hasPaidSubscription: boolean;
  cancelAtPeriodEnd: boolean;
};

/**
 * Stripe-mode action row beneath the current-plan card. Three buttons:
 *
 *   - **Open portal** — for paying card details / viewing invoices. Only
 *     enabled once we've created a Stripe customer for this tenant.
 *   - **Cancel at period end** — visible only when there's an active paid
 *     subscription that isn't already canceling. Confirms in a toast then
 *     calls the API.
 *   - **Resume subscription** — replaces "Cancel" once cancelAtPeriodEnd
 *     is true; lets the user undo a pending cancellation.
 *
 * Everything uses optimistic-ish UI through toasts; final state arrives
 * via the page refresh on success.
 */
export function BillingActions({
  slug,
  catalog,
  locale,
  canOpenPortal,
  hasPaidSubscription,
  cancelAtPeriodEnd,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [portalBusy, setPortalBusy] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState(false);

  async function openPortal() {
    setPortalBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/t/${slug}/billing/portal`, {
        method: 'POST',
        body: {},
      });
      window.location.href = url;
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
      setPortalBusy(false);
    }
  }

  async function cancelOrResume(action: 'cancel' | 'resume') {
    setActionBusy(true);
    try {
      await api(`/t/${slug}/billing/${action}`, { method: 'POST', body: {} });
      toast.show({
        severity: 'success',
        title:
          action === 'cancel'
            ? t('billing.actions.cancelSubscription')
            : t('billing.actions.resumeSubscription'),
      });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
      <Button
        variant="secondary"
        disabled={!canOpenPortal}
        loading={portalBusy}
        onClick={openPortal}
      >
        {t('billing.actions.openPortal')}
      </Button>
      {hasPaidSubscription ? (
        cancelAtPeriodEnd ? (
          <Button variant="ghost" loading={actionBusy} onClick={() => cancelOrResume('resume')}>
            {t('billing.actions.resumeSubscription')}
          </Button>
        ) : (
          <Button variant="ghost" loading={actionBusy} onClick={() => cancelOrResume('cancel')}>
            {t('billing.actions.cancelSubscription')}
          </Button>
        )
      ) : null}
    </div>
  );
}
