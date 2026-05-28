'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, Card, CardBody, CardHeader, Modal, useToast } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type PendingKey = {
  id: string;
  prefix: string;
  generatedAt: string;
  expiresAt: string;
} | null;

type ActiveSession = {
  id: string;
  startedAt: string;
  expiresAt: string;
  admin: { id: string; email: string; fullName: string };
} | null;

type SessionLogEntry = {
  id: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  admin: { email: string; fullName: string };
  actions: Array<{
    id: string;
    ts: string;
    method: string;
    path: string;
    status: number;
    targetType: string | null;
    targetId: string | null;
  }>;
};

type Props = {
  slug: string;
  initialPending: PendingKey;
  initialActive: ActiveSession;
  initialHistory: SessionLogEntry[];
};

type GenerateResponse = {
  id: string;
  code: string;
  prefix: string;
  expiresAt: string;
};

export function SupportAccessPanel({ slug, initialPending, initialActive, initialHistory }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = React.useState(initialPending);
  const [active, setActive] = React.useState(initialActive);
  const [revealedCode, setRevealedCode] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [endSessionOpen, setEndSessionOpen] = React.useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await api<GenerateResponse>(`/t/${slug}/support/keys`, {
        method: 'POST',
        body: {},
      });
      setPending({
        id: res.id,
        prefix: res.prefix,
        generatedAt: new Date().toISOString(),
        expiresAt: res.expiresAt,
      });
      setRevealedCode(res.code);
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

  async function revokeKey() {
    setBusy(true);
    try {
      await api(`/t/${slug}/support/keys/pending`, { method: 'DELETE' });
      setPending(null);
      setRevealedCode(null);
      setRevokeOpen(false);
      toast.show({ severity: 'success', title: 'Code revoked.' });
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

  async function endActive() {
    setBusy(true);
    try {
      await api(`/t/${slug}/support/sessions/active`, { method: 'DELETE' });
      setActive(null);
      setEndSessionOpen(false);
      toast.show({ severity: 'success', title: 'Support access ended.' });
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

  async function copyCode() {
    if (!revealedCode) return;
    try {
      await navigator.clipboard.writeText(revealedCode);
      toast.show({ severity: 'success', title: 'Code copied to clipboard.' });
    } catch {
      toast.show({
        severity: 'warning',
        title: "Couldn't copy automatically. Select + copy by hand.",
      });
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString();

  return (
    <>
      {active ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader title="Libriant support is in your library right now" />
          <CardBody>
            <Banner severity="warning" style={{ marginBottom: 'var(--sp-3)' }}>
              <strong>{active.admin.fullName}</strong> ({active.admin.email}) opened this support
              session at <time>{fmt(active.startedAt)}</time>. It ends automatically at{' '}
              <time>{fmt(active.expiresAt)}</time>.
            </Banner>
            <p style={{ marginTop: 0 }}>
              You can end this access at any time — Libriant will lose their session immediately.
            </p>
            <Button variant="secondary" onClick={() => setEndSessionOpen(true)}>
              End support access
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="One-time support code" />
        <CardBody>
          {revealedCode ? (
            <>
              <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
                Share this code with your Libriant support contact. It can only be used once and
                expires in about an hour.
              </Banner>
              <pre
                style={{
                  fontSize: 'var(--fs-xl)',
                  background: 'var(--color-bg-muted)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius-md)',
                  letterSpacing: '0.1em',
                  margin: 0,
                  textAlign: 'center',
                }}
              >
                {revealedCode}
              </pre>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--sp-2)',
                  marginTop: 'var(--sp-3)',
                  flexWrap: 'wrap',
                }}
              >
                <Button variant="primary" onClick={copyCode}>
                  Copy code
                </Button>
                <Button variant="ghost" onClick={() => setRevealedCode(null)}>
                  Hide
                </Button>
              </div>
            </>
          ) : pending ? (
            <>
              <p style={{ marginTop: 0 }}>
                A code starting with <strong>{pending.prefix}</strong> is waiting to be used. It
                expires at <time>{fmt(pending.expiresAt)}</time>.
              </p>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                If you didn't share it yet — or you don't recognise it — revoke it. You can generate
                a new one anytime.
              </p>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                <Button variant="secondary" loading={busy} onClick={generate}>
                  Generate new code (replaces this one)
                </Button>
                <Button variant="ghost" onClick={() => setRevokeOpen(true)}>
                  Revoke
                </Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                Click below to generate a code. Share it with your Libriant support contact. They'll
                redeem it and get read/write access to your library for up to 4 hours.
              </p>
              <Button variant="primary" loading={busy} onClick={generate}>
                Allow Libriant support to help us
              </Button>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Support session history" />
        <CardBody>
          {initialHistory.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>No support sessions yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
              {initialHistory.map((s) => (
                <details key={s.id}>
                  <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
                    {s.admin.fullName} ({s.admin.email}) — <time>{fmt(s.startedAt)}</time>{' '}
                    {s.endedAt ? (
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        — ended {fmt(s.endedAt)} ({s.endedReason ?? 'unknown'})
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-status-warning)' }}>— still active</span>
                    )}
                  </summary>
                  {s.actions.length === 0 ? (
                    <p
                      style={{
                        color: 'var(--color-text-muted)',
                        marginTop: 'var(--sp-2)',
                      }}
                    >
                      No actions recorded.
                    </p>
                  ) : (
                    <table className="lbr-table" style={{ marginTop: 'var(--sp-2)' }}>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Method</th>
                          <th>Path</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.actions.map((a) => (
                          <tr key={a.id}>
                            <td>
                              <time dateTime={a.ts}>{fmt(a.ts)}</time>
                            </td>
                            <td>
                              <code>{a.method}</code>
                            </td>
                            <td>
                              <code>{a.path}</code>
                            </td>
                            <td>{a.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </details>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        title="Revoke this code?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setRevokeOpen(false)}>
              Keep it
            </Button>
            <Button variant="primary" loading={busy} onClick={revokeKey}>
              Revoke
            </Button>
          </>
        }
      >
        <p>
          The unused code starting with <strong>{pending?.prefix}</strong> will stop working
          immediately. Nobody will be able to redeem it.
        </p>
      </Modal>

      <Modal
        open={endSessionOpen}
        onClose={() => setEndSessionOpen(false)}
        title="End Libriant's support access?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setEndSessionOpen(false)}>
              Keep access
            </Button>
            <Button variant="primary" loading={busy} onClick={endActive}>
              End access now
            </Button>
          </>
        }
      >
        <p>
          Libriant support will lose access to your library immediately. You can grant access again
          later if you need help.
        </p>
      </Modal>
    </>
  );
}
