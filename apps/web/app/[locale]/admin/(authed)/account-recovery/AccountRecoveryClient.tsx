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

      {/*
        The procedure lives on the page that performs it. The audit that
        produced this feature found the escape hatch documented in no runbook —
        docs/RUNBOOK.md still told the operator there was "no operator recovery
        path" — and an operator mid-phone-call does not go looking through
        docs/ for the steps. Keep this list in step with the buttons below.
      */}
      <Card>
        <CardHeader
          title="How a recovery call goes"
          subtitle="No mail is delivered (EMAIL_DRIVER=console), so this page is the whole recovery path."
        />
        <CardBody>
          <ol style={{ margin: 0, paddingInlineStart: 'var(--sp-4)', lineHeight: 1.7 }}>
            <li>
              Satisfy yourself that the caller is who they say they are. Everything below hands over
              their library account.
            </li>
            <li>Find the account by the address or username they sign in with.</li>
            <li>
              <strong>They can&apos;t add a colleague</strong> (&ldquo;confirm your email
              first&rdquo;) → <em>Confirm address</em>. They can invite staff immediately
              afterwards.
            </li>
            <li>
              <strong>They&apos;ve forgotten their password</strong> → <em>Issue reset link</em>,
              and read out or paste the whole address. It opens a page where they choose a new
              password; it works once and expires after 60 minutes.
            </li>
            <li>
              <strong>Staff accounts (a username such as staff_3) don&apos;t need this page</strong>{' '}
              — the library&apos;s own owner or admin resets them from Staff, and sees the temporary
              password on screen.
            </li>
          </ol>
        </CardBody>
      </Card>

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
            {/*
              The credential is the part after the `#`, and it is there on
              purpose: a fragment is never sent to our servers, so it stays out
              of the Caddy access log and out of the nightly backup of that log
              (privacy-legal-06). The cost is that a truncated copy/paste looks
              like a working URL and isn't, so say so where it will be read.
            */}
            <p style={{ fontSize: 'var(--fs-sm)', color: muted }}>
              Pass on the <strong>whole address, including everything after the “#”</strong>. That
              tail is the link — without it the page opens and asks the reader for a link they
              haven&apos;t got. It opens the &ldquo;choose a new password&rdquo; page in their
              browser; they set the password themselves and you never see it.
            </p>
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
