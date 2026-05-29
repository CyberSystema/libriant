import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, HelpButton, PageHeader } from '@libriant/ui';
import { isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { requestCookieHeader } from '@/lib/admin-session';
import { type AdminEventRow, type ResolvedSystemMode, MODE_LABEL } from './types';
import { OpenGlobalModeForm } from './OpenGlobalModeForm';
import { EventTable } from './EventTable';

export const dynamic = 'force-dynamic';

export default async function SystemModePage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  const cookie = await requestCookieHeader();

  let current: ResolvedSystemMode | null = null;
  let active: AdminEventRow[] = [];
  let scheduled: AdminEventRow[] = [];
  let history: AdminEventRow[] = [];
  let error: string | null = null;
  try {
    const [cur, sched, hist] = await Promise.all([
      api<{ global: ResolvedSystemMode; active: AdminEventRow[] }>('/admin/system-mode/current', {
        cookie,
      }),
      api<{ scheduled: AdminEventRow[] }>('/admin/system-mode/scheduled', { cookie }),
      api<{ history: AdminEventRow[] }>('/admin/system-mode/history?limit=25', { cookie }),
    ]);
    current = cur.global;
    active = cur.active;
    scheduled = sched.scheduled;
    history = hist.history;
  } catch (err) {
    error = err instanceof ApiError ? err.message : 'Something went wrong.';
  }

  return (
    <>
      <PageHeader
        title="System mode"
        subtitle="Take the whole platform — or a single library — into maintenance, read-only, outage, or under-construction state."
        help={
          <HelpButton title="System mode reference">
            <h3>The four modes</h3>
            <ul>
              <li>
                <strong>maintenance</strong> — full takeover. Tenant routes return 503; users see
                the branded takeover page. <code>/admin/*</code> + <code>/healthz</code> stay open.
              </li>
              <li>
                <strong>read_only</strong> — GETs pass through; POST / PATCH / PUT / DELETE return
                503 with a structured payload the UI uses to show a banner.
              </li>
              <li>
                <strong>out_of_order</strong> — same enforcement as maintenance, different branding
                (emergency outage).
              </li>
              <li>
                <strong>under_construction</strong> — no blocking; renders a persistent banner.
              </li>
            </ul>
            <h3>Stricter wins</h3>
            <p>
              A global event + a per-tenant event both in flight resolve to whichever is stricter (
              <code>
                normal &lt; under_construction &lt; read_only &lt; out_of_order = maintenance
              </code>
              ). Ties go to the per-tenant event.
            </p>
            <h3>The escape hatch</h3>
            <p>
              Even with <code>allowAdminBypass=false</code>, <code>/admin/system-mode/*</code> stays
              open. You cannot lock yourself out of the lever you need to recover.
            </p>
            <h3>Scheduling</h3>
            <p>
              Future windows resolve at read-time — no worker flips state at the boundary. Cancel a
              scheduled window any time before it starts; use <strong>End now</strong> once
              it&rsquo;s active.
            </p>
          </HelpButton>
        }
      />

      {error ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {error}
        </Banner>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Current global mode" />
        <CardBody>
          {current ? (
            current.mode === 'normal' ? (
              <Banner severity="success">All systems normal.</Banner>
            ) : (
              <Banner
                severity={
                  current.mode === 'maintenance' || current.mode === 'out_of_order'
                    ? 'critical'
                    : 'warning'
                }
              >
                <div>
                  <strong>{MODE_LABEL[current.mode]}</strong>
                  {current.endsAt
                    ? ` — ends ${new Date(current.endsAt).toLocaleString()}`
                    : ' — open-ended'}
                  {current.allowAdminBypass ? ' (admin bypass on)' : ' (admin bypass OFF)'}
                </div>
                {current.messageMarkdown ? (
                  <pre style={{ whiteSpace: 'pre-wrap', marginTop: 'var(--sp-2)' }}>
                    {current.messageMarkdown}
                  </pre>
                ) : null}
              </Banner>
            )
          ) : (
            <p>Loading…</p>
          )}
        </CardBody>
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gap: 'var(--sp-4)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <Card>
          <CardHeader
            title="Active windows"
            subtitle="Anything currently in effect — global or per-tenant."
          />
          <CardBody>
            <EventTable
              rows={active}
              emptyMessage="No active windows."
              showEndAction
              locale={params.locale}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Open a global window" />
          <CardBody>
            <OpenGlobalModeForm locale={params.locale} />
          </CardBody>
        </Card>
      </div>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Scheduled" subtitle="Windows that haven't started yet." />
        <CardBody>
          <EventTable
            rows={scheduled}
            emptyMessage="Nothing scheduled."
            showCancelAction
            locale={params.locale}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="History" subtitle="Last 25 ended or expired events." />
        <CardBody>
          <EventTable rows={history} emptyMessage="No history yet." locale={params.locale} />
        </CardBody>
      </Card>
    </>
  );
}
