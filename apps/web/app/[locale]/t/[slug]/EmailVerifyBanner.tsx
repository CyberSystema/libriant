'use client';
import * as React from 'react';
import { Banner, Button, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Soft email-verification nudge. Shown in the tenant shell while the signed-in
 * user's email is unverified (`/auth/me` → `user.emailVerified === false`).
 * The owner can still use the library; verification-sensitive actions (inviting
 * staff, …) are blocked by the API until they click the link. The button
 * re-sends it. Mirrors the API's soft-gate decision.
 */
export function EmailVerifyBanner({ email }: { email: string | null }) {
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function resend() {
    setBusy(true);
    try {
      await api('/auth/verify-email/resend', { method: 'POST' });
      setSent(true);
      toast.show({ severity: 'success', title: 'Verification email sent — check your inbox.' });
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Could not resend right now.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
      <span>
        <strong>Verify your email.</strong> We sent a confirmation link
        {email ? ` to ${email}` : ''}. Some actions (like inviting staff) stay locked until you
        confirm it.
      </span>{' '}
      <Button variant="ghost" size="sm" loading={busy} disabled={sent} onClick={resend}>
        {sent ? 'Sent' : 'Resend link'}
      </Button>
    </Banner>
  );
}
