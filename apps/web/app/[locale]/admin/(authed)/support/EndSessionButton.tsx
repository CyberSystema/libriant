'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

/** Ends the admin's own active support session and clears the impersonation cookie. */
export function EndSessionButton() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function end() {
    setBusy(true);
    try {
      await api('/admin/support/sessions/me/end', { method: 'POST', body: {} });
      toast.show({ severity: 'success', title: 'Support session ended.' });
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
    <Button variant="secondary" loading={busy} onClick={end}>
      End session
    </Button>
  );
}
