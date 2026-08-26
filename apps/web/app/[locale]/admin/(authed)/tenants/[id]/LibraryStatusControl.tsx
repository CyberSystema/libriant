'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  FormError,
  FormField,
  Input,
  Modal,
  Textarea,
  useToast,
} from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Pause / resume a library, from the page an operator is already on.
 *
 * tenant-isolation-05 was answered once by adding `PUT /admin/tenants/:id/status`
 * — mounted, guarded, audited, and requested by nobody. The finding's harm was
 * "an operator runs `UPDATE tenants SET status='suspended'` by hand", and an
 * endpoint with no control in front of it only changes which hand-written
 * command they reach for. So this is the caller, and it is the half that closes
 * the finding.
 *
 * Pausing answers 403 to every request the library makes — mid-shift, at the
 * desk — so it asks for the slug to be typed, exactly as the delete below it
 * does: on a list of 133 libraries the realistic mistake is not "meant to pause
 * nothing", it is "paused the wrong one". Resuming needs no ceremony; nobody
 * was ever harmed by a library working.
 *
 * That typing is done here rather than with the shared `ConfirmDestructive`,
 * which was tried first: its standing warning strip reads "This cannot be
 * undone." That sentence is the whole point of the component, and it is FALSE
 * for a pause — the resume button is two lines below it. An operator who is
 * told a reversible action is permanent does the reversible thing by hand
 * instead, which is the habit this control exists to end.
 *
 * `archived` is deliberately absent, matching the endpoint, which refuses it in
 * either direction: archival answers 410 Gone and carries a retention decision,
 * and un-archiving as a side effect of a resume button would bring back records
 * someone put beyond use on purpose.
 */
export function LibraryStatusControl({
  tenantId,
  slug,
  name,
  status,
  canPause,
}: {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  /** Only a platform owner-admin may write this; support admins get 403. */
  canPause: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  async function setStatus(next: 'suspended' | 'active') {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/tenants/${tenantId}/status`, {
        method: 'PUT',
        body: { status: next, reason: reason.trim() || undefined },
      });
      toast.show({
        severity: 'success',
        title: next === 'suspended' ? `Paused “${name}”.` : `Resumed “${name}”.`,
      });
      setReason('');
      closeConfirm();
      // The API invalidated the resolver cache, so the next request everywhere
      // already sees this. Re-read the page so the status above agrees.
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      closeConfirm();
    } finally {
      setBusy(false);
    }
  }

  function closeConfirm() {
    setConfirming(false);
    setTyped('');
  }

  if (status === 'archived') {
    return (
      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        This library is <strong>archived</strong> — every request it makes answers 410 Gone.
        Archiving and un-archiving are a separate, deliberate act and are not done from here.
      </p>
    );
  }

  const suspended = status === 'suspended';
  const armed = typed.trim().toLowerCase() === slug.trim().toLowerCase();

  return (
    <>
      <FormError style={{ marginBottom: 'var(--sp-3)' }}>{error}</FormError>

      {suspended ? (
        <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
          This library is <strong>paused</strong>. Every request from its staff and its public
          catalogue is refused with 403 until it is resumed.
        </Banner>
      ) : (
        <p style={{ marginTop: 0 }}>
          This library is <strong>running normally</strong>. Pausing it refuses every request it
          makes — staff and public catalogue alike — until you resume it. Nothing is deleted.
        </p>
      )}

      {!canPause ? (
        <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
          Only a platform owner can pause or resume a library.
        </p>
      ) : suspended ? (
        <Button loading={busy} onClick={() => void setStatus('active')}>
          Resume this library
        </Button>
      ) : (
        <>
          <FormField
            id="pause-reason"
            label="Reason (optional)"
            hint="Recorded on the audit trail so the next operator can see why."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              rows={2}
              maxLength={500}
            />
          </FormField>
          <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
            Pause this library
          </Button>
          <Modal
            open={confirming}
            onClose={closeConfirm}
            role="alertdialog"
            title={`Pause “${name}”?`}
            actions={
              <>
                <Button variant="secondary" onClick={closeConfirm} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={!armed}
                  onClick={() => void setStatus('suspended')}
                >
                  Pause this library
                </Button>
              </>
            }
          >
            <p style={{ marginTop: 0 }}>
              Every request from <strong>{name}</strong> will be refused until you resume it —
              including staff at the desk mid-loan. Nothing is deleted, and the resume button
              appears here the moment it is paused.
            </p>
            <FormField
              id="pause-confirm"
              label={`Type the library slug ${slug} to confirm`}
              hint="So a mis-click on the wrong library in a long list cannot pause it."
            >
              <Input
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                autoComplete="off"
              />
            </FormField>
          </Modal>
        </>
      )}
    </>
  );
}
