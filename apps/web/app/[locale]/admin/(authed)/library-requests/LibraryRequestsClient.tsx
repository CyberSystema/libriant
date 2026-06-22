'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
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

export type LibraryRequest = {
  id: string;
  status: string;
  proposedJson: Record<string, unknown>;
  beforeJson: Record<string, unknown>;
  requestNote: string | null;
  createdAt: string;
  tenant: { slug: string; name: string } | null;
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export function LibraryRequestsClient({ initial }: { initial: LibraryRequest[] }) {
  const router = useRouter();
  const [requests, setRequests] = React.useState(initial);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusy(`${id}:${action}`);
    setError(null);
    try {
      await api(`/admin/library-requests/${id}/${action}`, {
        method: 'POST',
        body: { decisionNote: notes[id] || undefined },
      });
      setRequests((r) => r.filter((x) => x.id !== id));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  if (requests.length === 0) {
    return <EmptyState title="No pending requests" description="You're all caught up." />;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {error ? <Banner severity="critical">{error}</Banner> : null}
      {requests.map((req) => {
        const fields = Object.keys(req.proposedJson);
        return (
          <Card key={req.id}>
            <CardHeader
              title={req.tenant ? `${req.tenant.name} (${req.tenant.slug})` : 'Unknown library'}
              subtitle={`Requested ${new Date(req.createdAt).toLocaleString()}`}
            />
            <CardBody>
              <div className="lbr-table-wrap">
                <table className="lbr-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Current</th>
                      <th>Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((f) => (
                      <tr key={f}>
                        <td>{f}</td>
                        <td>{show(req.beforeJson[f])}</td>
                        <td>
                          <strong>{show(req.proposedJson[f])}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {req.requestNote ? (
                <p style={{ marginTop: 'var(--sp-2)' }}>
                  <strong>Requester note:</strong> {req.requestNote}
                </p>
              ) : null}
              <FormField id={`note-${req.id}`} label="Decision note (optional)">
                <Input
                  value={notes[req.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [req.id]: e.currentTarget.value }))}
                />
              </FormField>
              <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                <Button
                  loading={busy === `${req.id}:approve`}
                  onClick={() => decide(req.id, 'approve')}
                >
                  Approve &amp; apply
                </Button>
                <Button
                  variant="ghost"
                  loading={busy === `${req.id}:reject`}
                  onClick={() => decide(req.id, 'reject')}
                >
                  Reject
                </Button>
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
