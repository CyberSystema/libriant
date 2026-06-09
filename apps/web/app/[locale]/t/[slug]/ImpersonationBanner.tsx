'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Props = {
  tenantName: string;
  expiresAt: string;
};

/**
 * Sticky banner displayed at the top of every tenant page while the admin
 * holds an active impersonation cookie. Provides one-click "End session"
 * and a non-fluffy reminder that every action is being audited.
 */
export function ImpersonationBanner({ tenantName, expiresAt }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function end() {
    setBusy(true);
    try {
      await api('/admin/support/sessions/me/end', { method: 'POST', body: {} });
      toast.show({ severity: 'success', title: 'Support session ended.' });
      router.push(`/admin/support`);
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
    <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--sp-3)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <strong>Support session active.</strong> You are viewing <strong>{tenantName}</strong> as
          Libriant support. Every action is logged. Session ends{' '}
          <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time>.
        </div>
        <Button variant="secondary" size="sm" loading={busy} onClick={end}>
          End session
        </Button>
      </div>
    </Banner>
  );
}
