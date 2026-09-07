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
  FormError,
  FormField,
  Input,
} from '@libriant/ui';
import { findCountry } from '@libriant/shared/countries';
import { ApiError, api } from '@/lib/api';
import { dataPort } from '@/lib/ports';

export type ApplicationStatus = 'new' | 'contacted' | 'accepted' | 'rejected';

export type Application = {
  id: string;
  createdAt: string;
  libraryName: string;
  libraryType: string;
  city: string;
  country: string | null;
  contactName: string;
  contactEmail: string;
  phone: string | null;
  collectionSize: string | null;
  currentSystem: string | null;
  message: string | null;
  notified: boolean;
  notifyError: string | null;
  status: ApplicationStatus;
  decisionNote: string | null;
  reviewedAt: string | null;
};

export type ApplicationsList = {
  applications: Application[];
  counts: Record<ApplicationStatus, number>;
  offer: { total: number; taken: number; open: boolean };
};

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  new: 'Unread',
  contacted: 'Answered',
  accepted: 'Given a place',
  rejected: 'Declined',
};

const muted = 'var(--color-text-muted)';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/**
 * Twelve months from the day the place was given, as an ISO date.
 *
 * Derived from `reviewedAt` — a value the server sent — rather than from the
 * browser clock, so the string is the same in the server render and after
 * hydration.
 */
function twelveMonthsAfter(iso: string): string {
  const d = new Date(iso);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export function ApplicationsClient({
  initial,
  initialStatus,
}: {
  initial: ApplicationsList;
  initialStatus: string;
}) {
  const router = useRouter();
  const [list, setList] = React.useState(initial);
  const [status, setStatus] = React.useState(initialStatus);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function reload(next: string) {
    setStatus(next);
    setError(null);
    try {
      setList(
        await api<ApplicationsList>(
          `/admin/applications${next ? `?status=${encodeURIComponent(next)}` : ''}`,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the applications.');
    }
  }

  async function decide(id: string, next: ApplicationStatus) {
    setBusy(`${id}:${next}`);
    setError(null);
    try {
      const res = await api<{
        counts: ApplicationsList['counts'];
        offer: ApplicationsList['offer'];
      }>(`/admin/applications/${id}/status`, {
        method: 'POST',
        body: { status: next, decisionNote: notes[id] || undefined },
      });
      setList((l) => ({
        ...l,
        counts: res.counts,
        offer: res.offer,
        applications: l.applications.map((a) =>
          a.id === id ? { ...a, status: next, reviewedAt: new Date().toISOString() } : a,
        ),
      }));
      // Refresh the server components too: the sidebar's unread count is
      // rendered by the admin layout, not by this client island, so without
      // this the badge would still show the old number until a full reload.
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  const { offer, counts } = list;

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      <Banner severity={offer.open ? 'info' : 'warning'}>
        {offer.taken} of {offer.total} launch places given.{' '}
        {offer.open
          ? `The public form at libriant.com is open. Giving the last ${offer.total - offer.taken === 1 ? 'place' : `${offer.total - offer.taken} places`} closes it — no deploy, no commit.`
          : 'The public form is closed: an applicant now gets the waiting-list notice instead of the form. Declining or un-accepting one place opens it again.'}
      </Banner>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => void reload(e.currentTarget.value)}
          className="lbr-input"
          style={{ maxWidth: 220 }}
        >
          <option value="">Everything ({Object.values(counts).reduce((a, b) => a + b, 0)})</option>
          <option value="new">Unread ({counts.new})</option>
          <option value="contacted">Answered ({counts.contacted})</option>
          <option value="accepted">Given a place ({counts.accepted})</option>
          <option value="rejected">Declined ({counts.rejected})</option>
        </select>
        {/* The export existed before this page did and was linked from nowhere
            in the panel, which is half of launch-readiness-03. It is a link,
            not a fetch: the CSV comes back as an attachment. */}
        <a
          className="lbr-btn lbr-btn--secondary lbr-btn--md"
          href={dataPort().resourceUrl('/admin/applications.csv')}
        >
          Download CSV
        </a>
      </div>

      <FormError>{error}</FormError>

      {list.applications.length === 0 ? (
        <EmptyState title="Nothing here" description="No application matches this filter yet." />
      ) : null}

      {list.applications.map((a) => (
        <Card key={a.id}>
          <CardHeader
            title={`${a.libraryName} — ${a.city}`}
            subtitle={`${STATUS_LABEL[a.status]} · received ${when(a.createdAt)}`}
          />
          <CardBody>
            <div className="lbr-table-wrap">
              <table className="lbr-table">
                <tbody>
                  <tr>
                    <th scope="row">Contact</th>
                    <td>
                      {a.contactName} —{' '}
                      <a
                        href={`mailto:${a.contactEmail}?subject=${encodeURIComponent(`Libriant — ${a.libraryName}`)}`}
                      >
                        {a.contactEmail}
                      </a>
                      {a.phone ? (
                        <>
                          {' · '}
                          <a href={`tel:${a.phone}`}>{a.phone}</a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Where</th>
                    {/* The applicant is required to name a country, so it is
                        shown. It was collected and rendered nowhere: the CSV
                        export had it and this panel — the surface an operator
                        actually reads before putting a library on a Data
                        Processing Agreement — did not. Named in Greek, because
                        that is the language of the panel's readers and of the
                        libraries applying. Null only for rows stored before
                        the field existed. */}
                    <td>
                      {a.city}
                      {a.country ? ` · ${findCountry(a.country)?.el ?? a.country}` : ''}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Library</th>
                    <td>
                      {a.libraryType}
                      {a.collectionSize ? ` · about ${a.collectionSize} titles` : ''}
                      {a.currentSystem ? ` · uses ${a.currentSystem} today` : ''}
                    </td>
                  </tr>
                  {a.message ? (
                    <tr>
                      <th scope="row">What they wrote</th>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{a.message}</td>
                    </tr>
                  ) : null}
                  {a.decisionNote ? (
                    <tr>
                      <th scope="row">Your note</th>
                      <td>
                        {a.decisionNote}
                        {a.reviewedAt ? ` (${when(a.reviewedAt)})` : ''}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* Honest about the mail. `notified` is set by the outbox worker on
                real delivery, and under EMAIL_DRIVER=console there is none —
                so an operator reading this card is told that answering it is
                their own mailbox's job, not something already in flight. */}
            <p style={{ color: muted, fontSize: 'var(--fs-xs)', marginTop: 'var(--sp-2)' }}>
              {a.notified
                ? 'A notification e-mail for this application was delivered.'
                : 'No notification e-mail was delivered for this application — answer it from your own mailbox.'}
              {a.notifyError ? ` (${a.notifyError})` : ''}
            </p>

            {a.status === 'accepted' ? (
              <div
                style={{
                  marginTop: 'var(--sp-3)',
                  padding: 'var(--sp-3)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <strong>Provisioning this library</strong>
                <p style={{ color: muted, fontSize: 'var(--fs-xs)', margin: 'var(--sp-1) 0' }}>
                  The free year only ends by itself if the subscription is manually billed with a{' '}
                  <code>paidUntil</code>. The admin panel cannot produce that state — assigning a
                  plan here copies the plan&apos;s own billing mode (<code>stripe</code>), and
                  set-paid-until then refuses. Create the tenant with the mode set from the start:
                </p>
                <pre
                  style={{
                    overflowX: 'auto',
                    background: 'var(--color-surface-sunken, transparent)',
                    padding: 'var(--sp-2)',
                    fontSize: 'var(--fs-xs)',
                  }}
                >
                  {`pnpm tenant:create --slug=<slug> --name=${JSON.stringify(a.libraryName)} \\
  --owner-email=${a.contactEmail} --owner-name=${JSON.stringify(a.contactName)} \\
  --plan=municipal --billing-mode=manual \\
  --paid-until=${a.reviewedAt ? twelveMonthsAfter(a.reviewedAt) : '<twelve months out>'}`}
                </pre>
                <p style={{ color: muted, fontSize: 'var(--fs-xs)', margin: 0 }}>
                  Twelve months from the day you gave them the place. See docs/RUNBOOK.md §6.6 for
                  the library that has already signed itself up.
                </p>
              </div>
            ) : null}

            <FormField id={`note-${a.id}`} label="Note (optional — what you decided, and why)">
              <Input
                value={notes[a.id] ?? a.decisionNote ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.currentTarget.value }))}
              />
            </FormField>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              <Button
                variant="ghost"
                loading={busy === `${a.id}:contacted`}
                disabled={a.status === 'contacted'}
                onClick={() => void decide(a.id, 'contacted')}
              >
                Mark answered
              </Button>
              <Button
                loading={busy === `${a.id}:accepted`}
                disabled={a.status === 'accepted'}
                onClick={() => void decide(a.id, 'accepted')}
              >
                Give a place
              </Button>
              <Button
                variant="ghost"
                loading={busy === `${a.id}:rejected`}
                disabled={a.status === 'rejected'}
                onClick={() => void decide(a.id, 'rejected')}
              >
                Decline
              </Button>
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
