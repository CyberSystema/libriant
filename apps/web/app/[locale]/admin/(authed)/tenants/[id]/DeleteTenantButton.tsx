'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDestructive, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Owner break-glass: permanently delete a library. Typed-slug confirmation
 * (ConfirmDestructive) → POST /admin/tenants/:id/delete → back to the list.
 * This drops the tenant's database and every record it holds — no undo.
 */
export function DeleteTenantButton({
  tenantId,
  slug,
  name,
}: {
  tenantId: string;
  slug: string;
  name: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function confirmDelete() {
    setBusy(true);
    try {
      await api(`/admin/tenants/${tenantId}/delete`, {
        method: 'POST',
        body: { confirmSlug: slug },
      });
      toast.show({ severity: 'success', title: `Deleted “${name}”.` });
      router.push('/admin/tenants');
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Delete failed.',
      });
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} disabled={busy}>
        Delete this library
      </Button>
      <ConfirmDestructive
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirmDelete}
        busy={busy}
        title={`Delete “${name}”?`}
        confirmText={slug}
        confirmLabel="Delete library forever"
      >
        <p style={{ margin: 0 }}>
          This permanently deletes <strong>{name}</strong> — its database, all its books, members,
          loans, staff accounts, and billing records. <strong>There is no undo.</strong> Type the
          library slug <code style={{ fontFamily: 'var(--font-mono)' }}>{slug}</code> to confirm.
        </p>
      </ConfirmDestructive>
    </>
  );
}
