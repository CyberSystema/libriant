'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDestructive, Modal, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Props = {
  id: string;
  title: string;
  isExpired: boolean;
  isArchived: boolean;
  locale: string;
};

export function AnnouncementActions({ id, title, isExpired, isArchived, locale }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [expireOpen, setExpireOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);

  async function expire() {
    setBusy(true);
    try {
      await api(`/admin/announcements/${id}/expire`, { method: 'POST', body: {} });
      toast.show({ severity: 'success', title: 'Announcement expired.' });
      setExpireOpen(false);
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

  async function archive() {
    setBusy(true);
    try {
      await api(`/admin/announcements/${id}`, { method: 'DELETE' });
      toast.show({ severity: 'success', title: 'Announcement archived.' });
      router.push(`/${locale}/admin/announcements?status=archived`);
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      {!isExpired && !isArchived ? (
        <Button variant="secondary" onClick={() => setExpireOpen(true)}>
          Expire now
        </Button>
      ) : null}
      {!isArchived ? (
        <Button variant="ghost" onClick={() => setArchiveOpen(true)}>
          Archive
        </Button>
      ) : null}

      <Modal
        open={expireOpen}
        onClose={() => setExpireOpen(false)}
        title="Expire this announcement?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setExpireOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={expire}>
              Expire now
            </Button>
          </>
        }
      >
        <p>
          The banner will disappear from every library that hasn't already dismissed it. Existing
          delivery rows + dismissals/acks stay in the audit trail.
        </p>
      </Modal>

      <ConfirmDestructive
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={archive}
        busy={busy}
        title="Archive this announcement?"
        confirmText={title}
        confirmLabel="Archive forever"
      >
        <p>
          Hidden from the active and expired lists. Delivery + acknowledgement history stays in the
          database for audit.
        </p>
      </ConfirmDestructive>
    </div>
  );
}
