'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormField, Input, Textarea, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';
import { type SystemModeKind, MODE_DESCRIPTION } from './types';

const NON_NORMAL_MODES: Exclude<SystemModeKind, 'normal'>[] = [
  'maintenance',
  'read_only',
  'out_of_order',
  'under_construction',
];

export function OpenGlobalModeForm(_props: { locale: string }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = React.useState<Exclude<SystemModeKind, 'normal'>>('maintenance');
  const [message, setMessage] = React.useState('');
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [allowAdminBypass, setAllowAdminBypass] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/admin/system-mode/global', {
        method: 'POST',
        body: {
          mode,
          messageMarkdown: message || null,
          startsAt: startsAt ? new Date(startsAt).toISOString() : null,
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          allowAdminBypass,
        },
      });
      toast.show({ severity: 'success', title: 'System mode event created.' });
      setMessage('');
      setStartsAt('');
      setEndsAt('');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-3)' }}>
          {error}
        </Banner>
      ) : null}

      <FormField id="mode" label="Mode">
        <select
          className="lbr-input"
          value={mode}
          onChange={(e) => setMode(e.currentTarget.value as Exclude<SystemModeKind, 'normal'>)}
        >
          {NON_NORMAL_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </FormField>
      <p
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--color-text-muted)',
          marginTop: 'calc(var(--sp-1) * -1)',
        }}
      >
        {MODE_DESCRIPTION[mode]}
      </p>

      <FormField id="message" label="Message (optional)" hint="Shown on the takeover / banner.">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          rows={3}
          maxLength={2000}
        />
      </FormField>

      <div
        style={{
          display: 'grid',
          // Side-by-side when there's room for a full date+time field (~15rem),
          // otherwise stack so neither the day nor the time picker is clipped.
          // `min(100%, …)` keeps it from overflowing on very narrow screens.
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',
          gap: 'var(--sp-2)',
        }}
      >
        <FormField id="startsAt" label="Starts at" hint="Blank = now.">
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.currentTarget.value)}
          />
        </FormField>
        <FormField id="endsAt" label="Ends at" hint="Blank = open-ended.">
          <Input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.currentTarget.value)}
          />
        </FormField>
      </div>

      <label style={{ display: 'block', marginBottom: 'var(--sp-3)' }}>
        <input
          type="checkbox"
          checked={allowAdminBypass}
          onChange={(e) => setAllowAdminBypass(e.currentTarget.checked)}
        />{' '}
        Allow admin bypass (keep /admin/* + /auth/admin/* reachable)
      </label>

      <Button type="submit" variant="primary" loading={busy}>
        Open window
      </Button>
    </form>
  );
}
