import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import {
  lastOutboxCensus,
  refreshOutboxCensus,
  renderOutboxCensus,
  resetOutboxCensus,
} from '../../src/email/outbox-census.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Counts rows in the control-plane email_outbox table. No plan gate is involved, so the ' +
    'launch configuration is the honest posture.',
);

/**
 * reliability-10.
 *
 * A `dead` outbox row had no surface anywhere: `grep -rn "'dead'" apps/api/src`
 * returned exactly two hits, both inside email-worker.ts (the skip check and the
 * write). No endpoint, no metric, no /healthz field, no sweep, no alert — one
 * console.error in a rolling Docker log was the entire record that a password
 * reset had been permanently abandoned.
 *
 * This runs the census against the real control-plane schema, because that is
 * where the two things that can silently break live: the `status` enum (a value
 * the census does not know about is dropped from the head-count) and the
 * columns the alert rules' recovery SQL names.
 *
 * The wiring — the worker calling this on a timer and spreading it into
 * /metrics — was verified by scraping a running worker; see the remediation
 * notes. What this file protects is the query and the exposition format that
 * infra/monitoring/alerts.yml keys on by name.
 */

const DEAD_ID = `census-dead-${randomBytes(4).toString('hex')}`;
const OWED_ID = `census-owed-${randomBytes(4).toString('hex')}`;
const OWED_AGE_SEC = 3_600;

afterAll(async () => {
  await controlDb.emailOutbox.deleteMany({ where: { id: { in: [DEAD_ID, OWED_ID] } } });
  resetOutboxCensus();
});

describe('e-mail outbox census (reliability-10)', () => {
  it('exports nothing at all before the first pass, so absent() can catch a worker that never ran', () => {
    resetOutboxCensus();
    expect(lastOutboxCensus()).toBeNull();
    expect(renderOutboxCensus()).toEqual([]);
  });

  it('counts an abandoned row and ages the oldest owed one', async () => {
    const owedSince = new Date(Date.now() - OWED_AGE_SEC * 1000);
    await controlDb.emailOutbox.create({
      data: {
        id: DEAD_ID,
        kind: 'password_reset',
        toEmail: `dead-${DEAD_ID}@example.test`,
        subject: 'Reset your password',
        bodyMarkdown: 'body',
        status: 'dead',
        attempts: 5,
        maxAttempts: 5,
        failedAt: new Date(),
        abandonedAt: new Date(),
        lastError: 'provider refused the message',
      },
    });
    await controlDb.emailOutbox.create({
      data: {
        id: OWED_ID,
        kind: 'password_reset',
        toEmail: `owed-${OWED_ID}@example.test`,
        subject: 'Reset your password',
        bodyMarkdown: 'body',
        status: 'pending',
        scheduledFor: owedSince,
      },
    });

    const snap = await refreshOutboxCensus();

    expect(snap).not.toBeNull();
    expect(snap!.byStatus.dead).toBeGreaterThanOrEqual(1);
    expect(snap!.byStatus.pending).toBeGreaterThanOrEqual(1);
    // Allow for clock/rounding slack, but it must clearly be an hour, not zero.
    expect(snap!.oldestPendingSeconds).toBeGreaterThanOrEqual(OWED_AGE_SEC - 60);

    const body = renderOutboxCensus().join('\n');
    // These EXACT names are what infra/monitoring/alerts.yml fires on; a rename
    // here silently disarms LibriantEmailOutboxDeadLetters and
    // LibriantEmailOutboxStalled while every rule still looks like coverage.
    expect(body).toMatch(/^libriant_email_outbox_rows\{status="dead"\} [1-9]\d*$/m);
    expect(body).toMatch(/^libriant_email_outbox_oldest_pending_seconds \d+$/m);
    // Every enum value is present even at zero, so `> 0` fires on a series that
    // was already being scraped rather than on one that just appeared.
    for (const status of ['pending', 'sending', 'delivered', 'failed', 'dead']) {
      expect(body).toContain(`libriant_email_outbox_rows{status="${status}"}`);
    }
  });

  it('keeps the last good snapshot when a pass fails, rather than blanking the gauges', async () => {
    // A gauge that vanishes during a control-DB blip would RESOLVE the dead
    // letter alert and make the abandoned mail look cleaned up.
    const before = lastOutboxCensus();
    expect(before).not.toBeNull();

    const groupBy = controlDb.emailOutbox.groupBy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controlDb.emailOutbox as any).groupBy = () => Promise.reject(new Error('control DB is down'));
    try {
      const result = await refreshOutboxCensus();
      expect(result).toEqual(before);
      expect(renderOutboxCensus().join('\n')).toContain(
        'libriant_email_outbox_rows{status="dead"}',
      );
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controlDb.emailOutbox as any).groupBy = groupBy;
    }
  });
});
