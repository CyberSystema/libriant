import { describe, expect, it } from 'vitest';
import { renderScheduledJobMetrics, toScheduledJobResult } from './scheduled-jobs.runner.js';

/**
 * SCHEDULED-TENANTSFAILED-DISCARDED (reliability-07): the runner stored
 * `{ message, ok: true }` and threw `result.counts` away. Every multi-tenant
 * sweep catches per-tenant errors and keeps going, so a run in which all 49
 * tenants failed still resolved — and the worker's /healthz showed
 * `ok: true, "49 tenant(s) scanned; no member reminders due"`. That is what
 * hid a member-notifications job which had never once succeeded.
 */
describe('toScheduledJobResult', () => {
  it('marks the run NOT ok when any tenant failed', () => {
    const row = toScheduledJobResult({
      message: '49 tenant(s) scanned; no member reminders due',
      counts: { dueSoon: 0, overdue: 0, holdReady: 0, tenantsScanned: 49, tenantsFailed: 49 },
    });

    expect(row.ok).toBe(false);
  });

  it('says so in the message, which is all an operator reads', () => {
    const row = toScheduledJobResult({
      message: '3 tenant(s) scanned; no fines to accrue',
      counts: { fines: 0, tenantsScanned: 3, tenantsFailed: 1 },
    });

    expect(row.message).toBe('3 tenant(s) scanned; no fines to accrue; FAILED — tenantsFailed=1');
  });

  it('keeps the handler counts instead of dropping them', () => {
    const counts = { removed: 0, tenantsScanned: 3, tenantsFailed: 2 };

    expect(toScheduledJobResult({ message: 'swept', counts }).counts).toEqual(counts);
  });

  it('flags a per-row failure counter too, not just tenants', () => {
    // The tenant loop was only half the lie: reservation-expiry swallowed every
    // per-reservation error one level down, so a tenant in which EVERY expiry
    // threw still reported "no pickups to expire".
    expect(
      toScheduledJobResult({ message: 'no pickups to expire', counts: { rowsFailed: 3 } }).ok,
    ).toBe(false);
    // export-file-cleanup names its per-run failure counter plain `failed`.
    expect(toScheduledJobResult({ message: 'purged 4', counts: { failed: 1 } }).ok).toBe(false);
  });

  it('counts any `…Failed` key, including one no list has ever heard of', () => {
    // The point of the suffix convention: the old hard-coded list was opt-in,
    // so a new sweep left the health signal just by picking a name nobody had
    // added to it — which is the same class of bug as reliability-07 itself.
    const row = toScheduledJobResult({ message: 'swept', counts: { widgetsFailed: 7 } });

    expect(row.ok).toBe(false);
    expect(row.message).toBe('swept; FAILED — widgetsFailed=7');
  });

  it('reports a drained-nothing backlog without calling the run a failure', () => {
    // One poisoned stripe_webhook_events row used to pin stripe-webhook-retry
    // at ok:false every five minutes forever. Permanently red is exactly as
    // uninformative as permanently green, so a known-stuck pile the sweep has
    // stopped retrying is reported, not alarmed on.
    const row = toScheduledJobResult({
      message: 'no failed events to retry',
      counts: { retried: 0, abandoned: 2 },
    });

    expect(row.ok).toBe(true);
    expect(row.message).toBe('no failed events to retry; backlog — abandoned=2');
  });

  it('a live retry failure is still a failure, backlog or no backlog', () => {
    const row = toScheduledJobResult({
      message: 'retried 3',
      counts: { succeeded: 1, retryFailed: 2, abandoned: 5 },
    });

    expect(row.ok).toBe(false);
    expect(row.message).toBe('retried 3; FAILED — retryFailed=2; backlog — abandoned=5');
  });

  it('leaves a genuinely clean run alone', () => {
    const row = toScheduledJobResult({
      message: '3 tenant(s) scanned; no fines to accrue',
      counts: { fines: 0, tenantsScanned: 3, tenantsFailed: 0 },
    });

    expect(row.ok).toBe(true);
    expect(row.message).toBe('3 tenant(s) scanned; no fines to accrue');
  });

  it('treats a handler that reports no counts at all as ok', () => {
    expect(toScheduledJobResult({ message: 'no expired sessions' })).toMatchObject({
      ok: true,
      message: 'no expired sessions',
    });
  });
});

/**
 * reliability-07's other half: the runner knowing whether a run worked is
 * useless while the only place that truth lives is a /healthz JSON blob no
 * alert rule can read. infra/monitoring/alerts.yml has ten rules and not one
 * of them can reference a job.
 */
describe('renderScheduledJobMetrics', () => {
  it('exports last_ok, last_run and every handler counter', () => {
    const text = renderScheduledJobMetrics({
      'fine-accrual': {
        at: '2026-08-24T00:00:00.000Z',
        message: 'accrued 2',
        ok: true,
        counts: { fines: 2, tenantsFailed: 0 },
      },
      'member-notifications': {
        at: '2026-08-24T00:00:00.000Z',
        message: 'FAILED',
        ok: false,
        counts: { tenantsFailed: 49 },
      },
    });

    expect(text).toContain('libriant_worker_job_last_ok{job="fine-accrual"} 1');
    expect(text).toContain('libriant_worker_job_last_ok{job="member-notifications"} 0');
    expect(text).toContain(
      'libriant_worker_job_last_run_timestamp_seconds{job="fine-accrual"} 1787529600',
    );
    expect(text).toContain(
      'libriant_worker_job_count{job="member-notifications",count="tenantsFailed"} 49',
    );
  });

  it('emits no series for a job that has not run yet', () => {
    // A worker that booted 10 s ago has not run the 6-hourly sweep. `1` would
    // be a lie and `0` a false alarm; absent is the honest answer, and
    // last_run_timestamp is what an alert uses to catch "stopped entirely".
    const text = renderScheduledJobMetrics({});

    expect(text).not.toContain('libriant_worker_job_last_ok{');
    expect(text).toContain('# TYPE libriant_worker_job_last_ok gauge');
  });
});
