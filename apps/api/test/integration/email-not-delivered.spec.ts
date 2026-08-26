import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { controlDb } from '@libriant/db-control';
import { startEmailWorker } from '../../src/email/email-worker.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Drives the e-mail worker against the control-plane outbox. No plan gate is involved, and ' +
    'EMAIL_DRIVER=console with no provider IS the launch configuration this spec exists to ' +
    'describe honestly.',
);

/**
 * privacy-legal-18, driven through the real worker.
 *
 * The defect was one line: whatever `driver.send` returned, the worker wrote
 * `status: 'delivered', deliveredAt: now`. With `EMAIL_DRIVER=console` — what
 * ships, because there is no Resend key — nothing is sent, so every overdue
 * notice in `email_outbox` claimed a delivery that never happened. That is the
 * row a librarian reads in `/admin/emails` before telling a member "we did
 * e-mail you about the book".
 *
 * This boots `startEmailWorker()` — the same function `src/worker.ts:194`
 * calls in production — against the real control database and the real Redis,
 * and reads the row back with Prisma. The unit spec next to the worker covers
 * the mapping; this covers the write, the BullMQ round trip, and the retention
 * interlock the mapping created.
 */

const TAG = randomBytes(4).toString('hex');
const OWED_ID = `not-delivered-${TAG}`;
const STALE_ID = `not-delivered-stale-${TAG}`;
const STALE_BODY = `secret prose for ${TAG}`;
/** Comfortably past the worker's 90-day body retention. */
const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

afterAll(async () => {
  await controlDb.emailOutbox.deleteMany({ where: { id: { in: [OWED_ID, STALE_ID] } } });
});

async function waitForStatus(id: string, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const row = await controlDb.emailOutbox.findUnique({ where: { id } });
    if (row && row.status !== 'pending' && row.status !== 'sending') return row;
    if (Date.now() > until) {
      throw new Error(`outbox row ${id} never left pending (status=${row?.status ?? 'missing'})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('the outbox records what the driver actually did (privacy-legal-18)', () => {
  it('marks a message the console driver never sent as failed, not delivered', async () => {
    expect(process.env.EMAIL_DRIVER ?? 'console').toBe('console');

    await controlDb.emailOutbox.create({
      data: {
        id: OWED_ID,
        kind: 'member_overdue',
        toEmail: `patron-${TAG}@example.test`,
        subject: '"Dune" is overdue',
        bodyMarkdown: 'Dear Ada,\n\nOur records show "Dune" was due on 2026-08-01.',
        status: 'pending',
      },
    });
    // A terminal row whose body is long past the 90-day retention. It is
    // seeded as `failed` on purpose: that is the status this finding
    // introduced, and the sweep that removes message prose from the shared
    // control plane (privacy-legal-06) only ever knew about `delivered` and
    // `dead`. If the two findings are not wired together, every body on the
    // shipped configuration becomes permanent and this assertion is how you
    // find out.
    await controlDb.emailOutbox.create({
      data: {
        id: STALE_ID,
        kind: 'member_overdue',
        toEmail: `stale-${TAG}@example.test`,
        subject: 'an old notice',
        bodyMarkdown: STALE_BODY,
        status: 'failed',
        failedAt: OLD,
        createdAt: OLD,
      },
    });

    const handle = await startEmailWorker();
    try {
      const row = await waitForStatus(OWED_ID);

      expect(row.status).toBe('failed');
      // The two columns that read as "it went out".
      expect(row.deliveredAt).toBeNull();
      expect(row.providerId).toBeNull();
      expect(row.failedAt).not.toBeNull();
      expect(row.lastError ?? '').toContain('EMAIL_DRIVER=console');

      const stale = await controlDb.emailOutbox.findUnique({ where: { id: STALE_ID } });
      expect(stale?.bodyMarkdown).not.toContain(STALE_BODY);
      expect(stale?.bodyMarkdown).toContain('outbox retention');
    } finally {
      await handle.stop();
    }
  });
});
