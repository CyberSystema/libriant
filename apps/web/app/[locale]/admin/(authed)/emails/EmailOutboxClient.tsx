'use client';
import * as React from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormError,
  FormField,
  Input,
} from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

export type OutboxMessage = {
  id: string;
  kind: string;
  toEmail: string;
  subject: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduledFor: string;
  deliveredAt: string | null;
  createdAt: string;
  tenantSlug: string | null;
  tenantName: string | null;
};

export type OutboxList = {
  driver: string;
  delivering: boolean;
  messages: OutboxMessage[];
};

type OutboxDetail = OutboxMessage & {
  body: string;
  /** `live` = the one-time link in this body still resolves; `expired` = it doesn't. */
  linkState: 'none' | 'live' | 'expired';
  fromEmail: string | null;
  replyToEmail: string | null;
  providerId: string | null;
};

const muted = 'var(--color-text-muted)';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function EmailOutboxClient({
  initial,
  initialFilters,
}: {
  initial: OutboxList;
  initialFilters: { q?: string; status?: string; kind?: string; tenant?: string };
}) {
  const [list, setList] = React.useState(initial);
  const [q, setQ] = React.useState(initialFilters.q ?? '');
  const [tenant, setTenant] = React.useState(initialFilters.tenant ?? '');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<OutboxDetail | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (tenant.trim()) params.set('tenant', tenant.trim());
      const qs = params.toString();
      setList(await api<OutboxList>(`/admin/outbox${qs ? `?${qs}` : ''}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the outbox.');
    } finally {
      setLoading(false);
    }
  }

  async function openMessage(id: string) {
    setOpening(id);
    setError(null);
    setCopied(false);
    try {
      setOpen(await api<OutboxDetail>(`/admin/outbox/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that message.');
    } finally {
      setOpening(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {/*
        The single most important sentence on the page. A row that says
        "delivered" with a provider id looks exactly like a delivered email;
        under the console driver it means the opposite. Say so above the table,
        not in a footnote.
      */}
      {!list.delivering ? (
        <Banner severity="warning">
          <strong>Nothing on this page was delivered.</strong> EMAIL_DRIVER is{' '}
          <code>{list.driver}</code>, so messages are composed and stored but never sent — the
          &ldquo;delivered&rdquo; status and provider id below are fabricated by the console driver.
          Open a message to read what the recipient would have seen, and pass it on yourself.
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          <div className="lbr-form-grid">
            <FormField id="outbox-q" label="Search recipient or subject">
              <Input
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void reload();
                }}
                placeholder="maria@example.gr"
              />
            </FormField>
            <FormField id="outbox-tenant" label="Library slug">
              <Input
                value={tenant}
                onChange={(e) => setTenant(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void reload();
                }}
                placeholder="demo-library"
              />
            </FormField>
          </div>
          <Button loading={loading} onClick={() => void reload()}>
            Search
          </Button>
        </CardBody>
      </Card>

      <FormError>{error}</FormError>

      {open ? (
        <Card>
          <CardHeader
            title={open.subject}
            subtitle={`${open.kind} → ${open.toEmail}${
              open.tenantSlug ? ` · ${open.tenantSlug}` : ''
            }`}
          />
          <CardBody>
            {open.linkState === 'expired' ? (
              <Banner severity="warning">
                The one-time link in this message has expired and cannot be recovered — the token it
                pointed at is dead too. Issue a fresh one from <strong>Account recovery</strong>.
              </Banner>
            ) : null}
            {open.linkState === 'live' ? (
              <Banner severity="info">
                This message contains a <strong>live one-time link</strong>. Anyone who has it can
                take over the account. Read it out or paste it to the account holder only, and never
                into a ticket, a chat log or a screenshot.
              </Banner>
            ) : null}
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--color-surface-muted, #f6f7f9)',
                padding: 'var(--sp-3)',
                borderRadius: 'var(--radius-md, 6px)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {open.body}
            </pre>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              <Button
                variant="ghost"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(open.body)
                    .then(() => setCopied(true))
                    .catch(() => setError('Could not copy — select the text and copy by hand.'));
                }}
              >
                {copied ? 'Copied' : 'Copy body'}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Close
              </Button>
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: muted, marginTop: 'var(--sp-2)' }}>
              Created {when(open.createdAt)} · status {open.status} · attempts {open.attempts}/
              {open.maxAttempts}
              {open.lastError ? ` · last error: ${open.lastError}` : ''}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {list.messages.length === 0 ? (
        <EmptyState title="No messages" description="Nothing matches those filters." />
      ) : (
        <div className="lbr-table-wrap">
          <table className="lbr-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Kind</th>
                <th>To</th>
                <th>Subject</th>
                <th>Library</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.messages.map((m) => (
                <tr key={m.id}>
                  <td>{when(m.createdAt)}</td>
                  <td>{m.kind}</td>
                  <td>{m.toEmail}</td>
                  <td>{m.subject}</td>
                  <td>{m.tenantSlug ?? '—'}</td>
                  <td>
                    {m.status}
                    {m.lastError ? (
                      <div style={{ fontSize: 'var(--fs-xs)', color: muted }}>{m.lastError}</div>
                    ) : null}
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={opening === m.id}
                      onClick={() => void openMessage(m.id)}
                    >
                      Read
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
