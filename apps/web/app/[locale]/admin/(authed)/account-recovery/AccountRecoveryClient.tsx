'use client';
import * as React from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormField,
  Input,
} from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type FoundUser = {
  id: string;
  email: string | null;
  username: string | null;
  fullName: string;
  role: string;
  status: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  locked: boolean;
  archived: boolean;
  tenantSlug: string;
  tenantName: string;
};

type IssuedLink = {
  url: string;
  expiresAt: string;
  userId: string;
  identity: string;
};

const muted = 'var(--color-text-muted)';

export function AccountRecoveryClient() {
  const [q, setQ] = React.useState('');
  const [tenant, setTenant] = React.useState('');
  const [users, setUsers] = React.useState<FoundUser[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<IssuedLink | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (tenant.trim()) params.set('tenant', tenant.trim());
      const res = await api<{ users: FoundUser[] }>(`/admin/account-recovery/users?${params}`);
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not search.');
    } finally {
      setSearching(false);
    }
  }

  async function verify(user: FoundUser) {
    setBusy(`${user.id}:verify`);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ alreadyVerified: boolean; email: string }>(
        `/admin/account-recovery/users/${user.id}/verify-email`,
        { method: 'POST' },
      );
      setNotice(
        res.alreadyVerified
          ? `${res.email} was already confirmed — nothing changed.`
          : `${res.email} is now confirmed. They can invite staff straight away.`,
      );
      setUsers(
        (prev) => prev?.map((u) => (u.id === user.id ? { ...u, emailVerified: true } : u)) ?? prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm that address.');
    } finally {
      setBusy(null);
    }
  }

  async function issueLink(user: FoundUser) {
    setBusy(`${user.id}:link`);
    setError(null);
    setNotice(null);
    setLink(null);
    try {
      setLink(
        await api<IssuedLink>(`/admin/account-recovery/users/${user.id}/reset-link`, {
          method: 'POST',
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue a reset link.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {/*
        Say what these buttons really are. Both of them hand whoever holds the
        result control of somebody's library account, and the operator using
        this page is usually mid-phone-call and in a hurry.
      */}
      <Banner severity="warning">
        <strong>Break-glass.</strong> Confirming an address bypasses the proof that the person owns
        it, and a reset link is a working credential for their account until it is used or expires.
        Verify who you are talking to first. Every action here is written to the platform audit log
        with your name on it.
      </Banner>

      <Card>
        <CardBody>
          <div className="lbr-form-grid">
            <FormField id="rec-q" label="Name, email or username">
              <Input
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search();
                }}
                placeholder="maria@example.gr"
              />
            </FormField>
            <FormField id="rec-tenant" label="Library slug (optional)">
              <Input
                value={tenant}
                onChange={(e) => setTenant(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void search();
                }}
                placeholder="demo-library"
              />
            </FormField>
          </div>
          <Button loading={searching} onClick={() => void search()}>
            Find the account
          </Button>
        </CardBody>
      </Card>

      {error ? <Banner severity="critical">{error}</Banner> : null}
      {notice ? <Banner severity="success">{notice}</Banner> : null}

      {link ? (
        <Card>
          <CardHeader
            title="One-time reset link"
            subtitle={`For ${link.identity} · expires ${new Date(link.expiresAt).toLocaleString()}`}
          />
          <CardBody>
            <Banner severity="warning">
              This link sets a new password on the account. Give it to the account holder and nobody
              else — not a ticket, not a chat log, not a screenshot. It is shown here once; re-issue
              it if you lose it.
            </Banner>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--color-surface-muted, #f6f7f9)',
                padding: 'var(--sp-3)',
                borderRadius: 'var(--radius-md, 6px)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {link.url}
            </pre>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              <Button
                variant="ghost"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(link.url)
                    .then(() => setNotice('Link copied.'))
                    .catch(() => setError('Could not copy — select the text and copy by hand.'));
                }}
              >
                Copy link
              </Button>
              <Button variant="ghost" onClick={() => setLink(null)}>
                Hide
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {users === null ? null : users.length === 0 ? (
        <EmptyState
          title="No matching account"
          description="Try the email address they sign in with, or narrow it by library slug."
        />
      ) : (
        <div className="lbr-table-wrap">
          <table className="lbr-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Signs in with</th>
                <th>Library</th>
                <th>Role</th>
                <th>Email confirmed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.fullName}
                    {u.status !== 'active' || u.locked || u.archived ? (
                      <div style={{ fontSize: 'var(--fs-xs)', color: muted }}>
                        {[u.status, u.locked ? 'locked' : null, u.archived ? 'archived' : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    ) : null}
                  </td>
                  <td>{u.email ?? u.username ?? '—'}</td>
                  <td>
                    {u.tenantName}
                    <div style={{ fontSize: 'var(--fs-xs)', color: muted }}>{u.tenantSlug}</div>
                  </td>
                  <td>{u.role}</td>
                  <td>
                    {u.email === null ? 'n/a — username account' : u.emailVerified ? 'yes' : 'no'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                      {u.email && !u.emailVerified ? (
                        <Button
                          size="sm"
                          loading={busy === `${u.id}:verify`}
                          onClick={() => void verify(u)}
                        >
                          Confirm address
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `${u.id}:link`}
                        onClick={() => void issueLink(u)}
                      >
                        Issue reset link
                      </Button>
                    </div>
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
