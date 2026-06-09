'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { type AdminEventRow, MODE_LABEL } from './types';

type Props = {
  rows: AdminEventRow[];
  emptyMessage: string;
  showEndAction?: boolean;
  showCancelAction?: boolean;
};

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export function EventTable({ rows, emptyMessage, showEndAction, showCancelAction }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = React.useState<string | null>(null);

  async function endNow(id: string) {
    setPending(id);
    try {
      await api(`/admin/system-mode/events/${id}/end`, { method: 'POST', body: {} });
      toast.show({ severity: 'success', title: 'Window ended.' });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPending(null);
    }
  }

  async function cancel(id: string) {
    setPending(id);
    try {
      await api(`/admin/system-mode/events/${id}`, { method: 'DELETE' });
      toast.show({ severity: 'success', title: 'Scheduled window cancelled.' });
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setPending(null);
    }
  }

  if (rows.length === 0) {
    return <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>{emptyMessage}</p>;
  }

  return (
    <table className="lbr-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th>Mode</th>
          <th>Window</th>
          <th>Bypass?</th>
          <th>By</th>
          {showEndAction || showCancelAction ? <th>Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              {r.scope === 'global' ? (
                <strong>Global</strong>
              ) : r.tenant ? (
                <Link href={`/admin/tenants/${r.tenant.id}`}>{r.tenant.name}</Link>
              ) : (
                'tenant (deleted)'
              )}
            </td>
            <td>{MODE_LABEL[r.mode]}</td>
            <td>
              <div>
                <small>starts:</small> {fmt(r.startsAt)}
              </div>
              <div>
                <small>ends:</small> {r.endsAt ? fmt(r.endsAt) : 'open-ended'}
              </div>
              {r.endedAt ? (
                <div style={{ color: 'var(--color-text-muted)' }}>
                  <small>ended:</small> {fmt(r.endedAt)}
                </div>
              ) : null}
            </td>
            <td>{r.allowAdminBypass ? 'yes' : 'no'}</td>
            <td>
              <div>{r.createdBy.fullName}</div>
              <small style={{ color: 'var(--color-text-muted)' }}>{r.createdBy.email}</small>
            </td>
            {showEndAction || showCancelAction ? (
              <td>
                {showEndAction ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={pending === r.id}
                    onClick={() => endNow(r.id)}
                  >
                    End now
                  </Button>
                ) : null}
                {showCancelAction ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending === r.id}
                    onClick={() => cancel(r.id)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
