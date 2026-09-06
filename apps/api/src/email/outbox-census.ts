import { controlDb } from '@libriant/db-control';
import { metricHeader, metricLine } from '../observability/metrics.registry.js';

/**
 * A periodic head-count of the e-mail outbox, exported as Prometheus gauges.
 *
 * WHY THIS EXISTS (reliability-10). After `maxAttempts` the worker writes
 * `status: 'dead', abandonedAt, lastError` and gives up. Repo-wide, the only
 * other read of `'dead'` was the skip check in `processOne` — no admin
 * endpoint, no metric, no /healthz field, no sweep, no alert. The single trace
 * of an abandoned message was one `console.error` in a rolling Docker log.
 *
 * That means a misconfigured provider, a rate-limit, or a blocked sending
 * domain permanently abandons password-reset links, e-mail-verification links
 * and hold-ready notices with NO operator-visible signal: the user says "the
 * reset email never arrived" and support cannot even confirm it happened. It is
 * dormant only while EMAIL_DRIVER=console, which is the current setting — it
 * goes live the day a real driver is configured.
 *
 * The rows themselves are durable and carry `lastError` / `failedAt` /
 * `abandonedAt`, so a dead letter is RECOVERABLE by SQL. What was missing was
 * anyone knowing to look. These two gauges are what
 * `LibriantEmailOutboxDeadLetters` and `LibriantEmailOutboxStalled`
 * (infra/monitoring/alerts.yml) fire on, and the alert annotations carry the
 * re-drive SQL.
 *
 * Cost control: the census runs on a timer, not per scrape. Prometheus scrapes
 * the worker every 30s and the /metrics handler is synchronous, so a per-scrape
 * `groupBy` would put an unbounded aggregate on the request path of the
 * endpoint that is supposed to keep working when the database is unhappy.
 */

/**
 * Every value of the `EmailOutboxStatus` enum. A status the census does not
 * know about would be silently dropped from the head-count, which is the
 * failure this whole file exists to stop. Emitted even at zero — see
 * `renderOutboxCensus`.
 *
 * `failed` was dead weight here for a long time — a transient failure goes
 * back to `pending`, so nothing wrote it. privacy-legal-18 gave it a writer:
 * it is now the status of a message the driver reported as NOT SENT without
 * throwing, which on the shipped `EMAIL_DRIVER=console` configuration is every
 * message. So `libriant_email_outbox_rows{status="failed"}` is the count of
 * mail this deployment composed and never sent, and it climbing while
 * `delivered` stays flat is exactly what "no mail provider is configured"
 * looks like on the dashboard.
 */
const STATUSES = ['pending', 'sending', 'delivered', 'failed', 'dead'] as const;
type OutboxStatus = (typeof STATUSES)[number];

export type OutboxCensus = {
  byStatus: Record<OutboxStatus, number>;
  /** Age of the oldest row still owed, in seconds. 0 when nothing is owed. */
  oldestPendingSeconds: number;
  /** When this snapshot was taken. */
  at: number;
};

/** How often the census refreshes. */
export const CENSUS_INTERVAL_MS = 60_000;

let latest: OutboxCensus | null = null;

/**
 * Run one census pass. Never throws: a failed pass leaves the PREVIOUS snapshot
 * in place rather than blanking the gauges, because a gauge that disappears
 * during a control-DB blip would resolve `LibriantEmailOutboxDeadLetters` and
 * make the dead letters look cleaned up.
 */
export async function refreshOutboxCensus(): Promise<OutboxCensus | null> {
  try {
    const grouped = await controlDb.emailOutbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus: Record<OutboxStatus, number> = {
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
    };
    for (const row of grouped) {
      if ((STATUSES as readonly string[]).includes(row.status)) {
        byStatus[row.status as OutboxStatus] = row._count._all;
      }
    }
    // `scheduledFor`, not `createdAt`: a message deliberately scheduled for
    // next Tuesday is not late, and alerting on it would train operators to
    // ignore the alert that matters.
    const oldest = await controlDb.emailOutbox.findFirst({
      where: { status: { in: ['pending', 'sending'] }, scheduledFor: { lte: new Date() } },
      select: { scheduledFor: true },
      orderBy: { scheduledFor: 'asc' },
    });
    const oldestPendingSeconds = oldest
      ? Math.max(0, Math.round((Date.now() - oldest.scheduledFor.getTime()) / 1000))
      : 0;
    latest = { byStatus, oldestPendingSeconds, at: Date.now() };
    return latest;
  } catch (err) {
    console.error(`[outbox-census] failed: ${(err as Error).message}`);
    return latest;
  }
}

/** The last successful snapshot, or null if none has completed yet. */
export function lastOutboxCensus(): OutboxCensus | null {
  return latest;
}

/**
 * Prometheus lines for the last snapshot. Empty before the first pass
 * completes — `LibriantEmailOutboxCensusMissing` covers "it never completes".
 *
 * Every status is emitted even when zero. A `dead` series that only appears
 * once a message has already been abandoned would make the `> 0` rule fire on
 * a metric that did not exist a moment earlier, which reads as a scrape
 * problem; and `dead == 0` is the assertion an operator actually wants to see
 * on the dashboard.
 */
export function renderOutboxCensus(): string[] {
  const snap = latest;
  if (!snap) return [];
  const lines = [...metricHeader('libriant_email_outbox_rows')];
  for (const s of STATUSES) {
    lines.push(metricLine('libriant_email_outbox_rows', snap.byStatus[s], { status: s }));
  }
  lines.push(
    ...metricHeader('libriant_email_outbox_oldest_pending_seconds'),
    metricLine('libriant_email_outbox_oldest_pending_seconds', snap.oldestPendingSeconds),
  );
  return lines;
}

/** Test seam. Never called in production. */
export function resetOutboxCensus(): void {
  latest = null;
}

/**
 * Test seam. Never called in production.
 *
 * `worker-surface.spec.ts` asserts that the worker's `/metrics` renders EVERY
 * metric the registry declares for this process — the assertion that would have
 * caught `renderScheduledJobMetrics` being exported and never called. These two
 * gauges are absent until the first census pass completes against the control
 * database, so without a seam the assertion would have to carry an exception
 * for them, and an exception is exactly the hole the assertion exists to close.
 */
export function seedOutboxCensusForTest(snapshot: OutboxCensus): void {
  latest = snapshot;
}
