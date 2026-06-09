'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, ConfirmDestructive, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

export type SubscriptionsStatus = {
  billingEnabled: boolean;
  source: 'db' | 'env';
  totalTenants: number;
  awaitingChoice: number;
  updatedAt: string | null;
};

/**
 * The one control on the admin Subscriptions page. Flipping it POSTs to
 * `/admin/subscriptions`; enabling is the high-impact direction (it sends
 * every un-chosen library through the chooser), so both directions ask for a
 * typed confirmation.
 */
export function SubscriptionsToggle({ initial }: { initial: SubscriptionsStatus }) {
  const router = useRouter();
  const toast = useToast();
  const [status, setStatus] = React.useState(initial);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const enabled = status.billingEnabled;
  const next = !enabled;

  async function apply() {
    setBusy(true);
    try {
      const updated = await api<SubscriptionsStatus>('/admin/subscriptions', {
        method: 'POST',
        body: { enabled: next },
      });
      setStatus(updated);
      setConfirming(false);
      toast.show({
        severity: 'success',
        title: next ? 'Subscriptions enabled.' : 'Subscriptions disabled — everything is free.',
      });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <span
          className="lbr-pill"
          data-on={enabled ? 'true' : 'false'}
          style={{
            fontWeight: 600,
            padding: '2px 12px',
            borderRadius: 'var(--radius-pill, 999px)',
            background: enabled
              ? 'var(--color-success-soft, #dcfce7)'
              : 'var(--color-surface-muted)',
            color: enabled ? 'var(--color-success, #15803d)' : 'var(--color-text-muted)',
          }}
        >
          {enabled ? 'ON — plans enforced' : 'OFF — free for everyone'}
        </span>
        <Button
          variant={enabled ? 'secondary' : 'primary'}
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {enabled ? 'Disable subscriptions' : 'Enable subscriptions'}
        </Button>
      </div>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 'var(--sp-4)',
          rowGap: 'var(--sp-1)',
          margin: 'var(--sp-4) 0 0 0',
          fontSize: 'var(--fs-sm)',
        }}
      >
        <dt style={{ color: 'var(--color-text-muted)' }}>Active libraries</dt>
        <dd style={{ margin: 0 }}>{status.totalTenants}</dd>
        <dt style={{ color: 'var(--color-text-muted)' }}>Awaiting a plan choice</dt>
        <dd style={{ margin: 0 }}>{status.awaitingChoice}</dd>
        <dt style={{ color: 'var(--color-text-muted)' }}>Source</dt>
        <dd style={{ margin: 0 }}>
          {status.source === 'db' ? 'Set here (admin panel)' : 'Default (BILLING_ENABLED env)'}
        </dd>
      </dl>

      {next && status.awaitingChoice > 0 ? (
        <Banner severity="warning" style={{ marginTop: 'var(--sp-4)' }}>
          Enabling will immediately send {status.awaitingChoice} librar
          {status.awaitingChoice === 1 ? 'y' : 'ies'} to the plan chooser on their next visit.
        </Banner>
      ) : null}

      <ConfirmDestructive
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={apply}
        busy={busy}
        title={next ? 'Enable subscriptions?' : 'Disable subscriptions?'}
        confirmText={next ? 'enable' : 'disable'}
        confirmLabel={next ? 'Enable subscriptions' : 'Disable subscriptions'}
      >
        {next ? (
          <p style={{ margin: 0 }}>
            Every library that hasn&apos;t chosen a plan ({status.awaitingChoice} right now) will be
            blocked by the plan chooser until they pick one. Paid plans will require a Stripe
            payment method. Type <strong>enable</strong> to confirm.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            All plan limits and Stripe enforcement stop. Every library gets free, unlimited access
            and no one is asked to choose a plan. Existing paid subscriptions are left untouched
            (not cancelled). Type <strong>disable</strong> to confirm.
          </p>
        )}
      </ConfirmDestructive>
    </div>
  );
}
