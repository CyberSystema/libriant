'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormField, Input, Textarea, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type SystemModeKind =
  | 'normal'
  | 'maintenance'
  | 'read_only'
  | 'out_of_order'
  | 'under_construction';

const NON_NORMAL: Exclude<SystemModeKind, 'normal'>[] = [
  'maintenance',
  'read_only',
  'out_of_order',
  'under_construction',
];

type Active = {
  id: string;
  mode: SystemModeKind;
  endsAt: string | null;
  endedAt: string | null;
  messageMarkdown: string | null;
  allowAdminBypass: boolean;
} | null;

type Props = {
  tenantId: string;
  initialActive: Active;
};

/**
 * Per-tenant system mode panel on the tenant detail page. Lets an admin
 * isolate one library (migrating between cells, debugging a specific
 * outage, etc.) without touching global state.
 */
export function TenantSystemModePanel({ tenantId, initialActive }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = React.useState<Exclude<SystemModeKind, 'normal'>>('read_only');
  const [message, setMessage] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/system-mode/tenants/${tenantId}`, {
        method: 'POST',
        body: {
          mode,
          messageMarkdown: message || null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          allowAdminBypass: true,
        },
      });
      toast.show({ severity: 'success', title: 'Per-tenant window opened.' });
      setMessage('');
      setEndsAt('');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function endNow() {
    if (!initialActive) return;
    setBusy(true);
    try {
      await api(`/admin/system-mode/events/${initialActive.id}/end`, {
        method: 'POST',
        body: {},
      });
      toast.show({ severity: 'success', title: 'Tenant window ended.' });
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
    <>
      {initialActive ? (
        <>
          <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
            This tenant is currently in <strong>{initialActive.mode}</strong> mode
            {initialActive.endsAt
              ? `, ending ${new Date(initialActive.endsAt).toLocaleString()}`
              : ' (open-ended)'}
            .
          </Banner>
          {initialActive.messageMarkdown ? (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                background: 'var(--color-bg-muted)',
                padding: 'var(--sp-2)',
                borderRadius: 'var(--radius-sm)',
                marginBottom: 'var(--sp-3)',
              }}
            >
              {initialActive.messageMarkdown}
            </pre>
          ) : null}
          <Button variant="secondary" loading={busy} onClick={endNow}>
            End tenant window now
          </Button>
        </>
      ) : (
        <>
          {error ? (
            <Banner severity="critical" style={{ marginBottom: 'var(--sp-3)' }}>
              {error}
            </Banner>
          ) : null}
          <FormField id="t-mode" label="Mode">
            <select
              className="lbr-input"
              value={mode}
              onChange={(e) => setMode(e.currentTarget.value as Exclude<SystemModeKind, 'normal'>)}
            >
              {NON_NORMAL.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="t-message" label="Message (optional)">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.currentTarget.value)}
              rows={3}
              maxLength={2000}
            />
          </FormField>
          <FormField id="t-ends" label="Ends at" hint="Blank = open-ended.">
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.currentTarget.value)}
            />
          </FormField>
          <Button variant="primary" loading={busy} onClick={open}>
            Open tenant window
          </Button>
        </>
      )}
    </>
  );
}
