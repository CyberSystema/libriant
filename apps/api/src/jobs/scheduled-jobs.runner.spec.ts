import { describe, expect, it } from 'vitest';
import {
  announceJobFailure,
  renderScheduledJobMetrics,
  shouldAnnounceJobFailure,
  toScheduledJobResult,
} from './scheduled-jobs.runner.js';

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

/**
 * launch-readiness-06: nothing in this system has ever told a person that a
 * scheduled sweep stopped working — the failure line goes to stderr in a
 * rolling container log, and `libriant_worker_job_last_ok` has no rule in
 * infra/monitoring/alerts.yml pointed at it. The push added to
 * `worker.on('failed')` is that missing channel, and this is the gate in front
 * of it. Everything asserted here is a volume decision: the phone is one tap
 * from being muted, and a muted channel loses the real alerts too.
 */
describe('shouldAnnounceJobFailure', () => {
  const JOB = 'member-notifications';

  it('says nothing while BullMQ still has retries left', () => {
    // reliability-20 bought three attempts per tick precisely so a two-second
    // Postgres blip costs ~30 s instead of an hour. Announcing attempt 1 would
    // push for every blip those retries exist to absorb.
    const seen = new Map<string, number>();

    expect(shouldAnnounceJobFailure({ name: JOB, attemptsMade: 1, attempts: 3 }, seen)).toBe(false);
    expect(shouldAnnounceJobFailure({ name: JOB, attemptsMade: 2, attempts: 3 }, seen)).toBe(false);
    expect(seen.size).toBe(0);
  });

  it('announces the tick that spends the last attempt', () => {
    const seen = new Map<string, number>();

    expect(shouldAnnounceJobFailure({ name: JOB, attemptsMade: 3, attempts: 3 }, seen)).toBe(true);
  });

  it('reads an absent retry budget as one attempt, not as zero', () => {
    // BullMQ stores "no attempts option" as `attempts: 0`. With `??` instead of
    // `|| 1` the comparison would be `1 < 0` — false — and EVERY first failure
    // of a job registered without a budget would read as an exhausted one.
    const seen = new Map<string, number>();

    expect(shouldAnnounceJobFailure({ name: JOB, attemptsMade: 0, attempts: 0 }, seen)).toBe(true);
  });

  it('stays quiet for six hours about a job it has already announced', () => {
    // A broken sweep is broken for hours; the second and hundredth exhaustion
    // inside a working day are the same fact told again.
    const seen = new Map<string, number>();
    const t0 = Date.parse('2026-08-28T09:00:00Z');
    const exhausted = { name: JOB, attemptsMade: 3, attempts: 3 };

    expect(shouldAnnounceJobFailure(exhausted, seen, t0)).toBe(true);
    expect(shouldAnnounceJobFailure(exhausted, seen, t0 + 60_000)).toBe(false);
    expect(shouldAnnounceJobFailure(exhausted, seen, t0 + 5 * 3_600_000)).toBe(false);
    expect(shouldAnnounceJobFailure(exhausted, seen, t0 + 6 * 3_600_000)).toBe(true);
  });

  it('does not let a job that recovers and re-breaks reopen the window', () => {
    // The obvious refinement — clear the cooldown on success — is the wrong
    // one: support-session-expiry ticks every 60 s, so a sweep flapping between
    // success and failure would announce itself every other tick, 720 times a
    // day. Nothing here observes success, and that is the point.
    const seen = new Map<string, number>();
    const t0 = Date.parse('2026-08-28T09:00:00Z');
    const exhausted = { name: 'support-session-expiry', attemptsMade: 3, attempts: 3 };

    expect(shouldAnnounceJobFailure(exhausted, seen, t0)).toBe(true);
    for (let tick = 1; tick <= 60; tick++) {
      expect(shouldAnnounceJobFailure(exhausted, seen, t0 + tick * 120_000)).toBe(false);
    }
  });

  it('budgets each job separately, so an outage that breaks everything says so', () => {
    // Eleven notifications in the first minutes read as "nothing is working",
    // which is true. It is the REPEAT that gets a channel muted, not the burst.
    const seen = new Map<string, number>();
    const t0 = Date.parse('2026-08-28T09:00:00Z');

    for (const name of ['fine-accrual', 'retention-sweep', 'export-file-cleanup']) {
      expect(shouldAnnounceJobFailure({ name, attemptsMade: 3, attempts: 3 }, seen, t0)).toBe(true);
    }
    expect(seen.size).toBe(3);
  });

  it('ignores a failure event with no job attached to it', () => {
    // BullMQ's `failed` event can arrive with `job` undefined (a job that
    // vanished from Redis mid-flight). There is nothing to name and nothing to
    // rate-limit on, so nothing is sent.
    const seen = new Map<string, number>();

    expect(shouldAnnounceJobFailure({ attemptsMade: 3, attempts: 3 }, seen)).toBe(false);
  });
});

/**
 * What a broken sweep actually puts on the phone. The gate above decides
 * WHETHER; this decides WHAT, and the interesting assertions are the absences.
 */
describe('announceJobFailure', () => {
  function fakeNotifier() {
    const sent: Array<Record<string, unknown>> = [];
    return { sent, sendDetached: (input: Record<string, unknown>) => void sent.push(input) };
  }

  it('names the job, the budget it spent and where the error actually is', () => {
    const notifier = fakeNotifier();

    announceJobFailure(notifier, { name: 'fine-accrual', attemptsMade: 3, attempts: 3 }, new Map());

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      level: 'warn',
      title: 'Scheduled job failing: fine-accrual',
    });
    const body = String(notifier.sent[0]?.body);
    expect(body).toContain('all 3 attempts');
    expect(body).toContain('/healthz');
    expect(body).toContain('6 hours');
  });

  it('carries no part of the error, because errors quote connection strings', () => {
    // A Prisma connect failure quotes DATABASE_URL and an ioredis one quotes
    // REDIS_URL; both carry a password. This message leaves the country, is
    // retained by ntfy.sh, and on a public topic is world-readable.
    const notifier = fakeNotifier();

    announceJobFailure(
      notifier,
      { name: 'member-notifications', attemptsMade: 3, attempts: 3 },
      new Map(),
    );

    const wire = JSON.stringify(notifier.sent[0]);
    expect(wire).not.toMatch(/postgres|redis:\/\/|password|Error:/i);
  });

  it('is silent for a failure the retries are still working on', () => {
    const notifier = fakeNotifier();

    announceJobFailure(
      notifier,
      { name: 'retention-sweep', attemptsMade: 1, attempts: 3 },
      new Map(),
    );

    expect(notifier.sent).toHaveLength(0);
  });

  it('never uses the one level that overrides do-not-disturb', () => {
    // `error` is ntfy 5, the only level a handset can be told to let through
    // DND. A sweep that re-runs on its own interval is worth today, not 03:00.
    const notifier = fakeNotifier();

    announceJobFailure(notifier, { name: 'export-file-cleanup', attemptsMade: 9 }, new Map());

    expect(notifier.sent[0]?.level).toBe('warn');
  });
});
