import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { controlDb } from '@libriant/db-control';
import { sweepRetention } from '../../src/jobs/retention.job.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Retention is a data-lifecycle concern with no plan gate in it. This runs the shipped ' +
    'configuration, which is also the one where the three periods below are unset.',
);

/**
 * performance-07, the half a previous round left open: the control-plane
 * `audit_log`, the `email_outbox` body and `support_redemption_attempts` had no
 * sweep at all, on the stated grounds that Privacy Policy §6 has not published a
 * period for them and inventing one would be worse.
 *
 * That reasoning is right about the number and wrong about the machinery. The
 * limbs now exist and are governed by an environment variable that is UNSET in
 * the shipped configuration, so:
 *
 *   - with nothing set, nothing is deleted and the run message names the
 *     variable an operator has to set — the finding's "no way to stop the
 *     growth" becomes "one line in .env.prod once counsel signs off";
 *   - with a period set, rows really go.
 *
 * Every assertion below fails against the code as it stood: with no limb, pass 3
 * leaves all five fixtures exactly as pass 1 found them.
 *
 * The sweep is driven through its real entry point, `sweepRetention()` — the
 * function `registry.ts` registers as `retention-sweep` — and not through the
 * private limb functions, because the defect this closes was precisely a limb
 * that existed somewhere the job never reached.
 */
const TAG = `retention-cfg-${randomBytes(3).toString('hex')}`;
const LONG_AGO = new Date(Date.now() - 400 * 86_400_000);
const PRUNED_MARKER = '_(Body removed by the retention sweep.)_';

/** The env vars this spec drives. Cleared between passes and at the end. */
const PERIOD_VARS = [
  'CONTROL_AUDIT_RETENTION_DAYS',
  'EMAIL_OUTBOX_BODY_RETENTION_DAYS',
  'SUPPORT_ATTEMPT_RETENTION_DAYS',
] as const;

function clearPeriods(): void {
  for (const v of PERIOD_VARS) delete process.env[v];
}

type Fixtures = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const ordinaryAudit = await controlDb.auditEvent.create({
    data: {
      actorType: 'system',
      action: `${TAG}.ordinary`,
      occurredAt: LONG_AGO,
      ip: '203.0.113.9',
    },
  });
  // The Art. 7(1) evidence privacy-legal-09 writes. A retention sweep that took
  // this with everything else would close one finding by re-opening another.
  const legalAccepted = await controlDb.auditEvent.create({
    data: { actorType: 'user', action: 'tenant.legal_accepted', occurredAt: LONG_AGO },
  });
  const delivered = await controlDb.emailOutbox.create({
    data: {
      idempotencyKey: `${TAG}:delivered`,
      kind: 'member_overdue',
      toEmail: `${TAG}-a@example.invalid`,
      subject: 'Overdue notice',
      bodyMarkdown: 'Your book is overdue. Please bring it back.',
      status: 'delivered',
      createdAt: LONG_AGO,
      deliveredAt: LONG_AGO,
    },
  });
  // Never sent. Its body is what the worker would still send — and with
  // EMAIL_DRIVER=console it is also the only copy of a live one-time link.
  const pending = await controlDb.emailOutbox.create({
    data: {
      idempotencyKey: `${TAG}:pending`,
      kind: 'email_verification',
      toEmail: `${TAG}-b@example.invalid`,
      subject: 'Confirm your address',
      bodyMarkdown: 'https://libriant.test/verify?token=still-redeemable',
      status: 'pending',
      createdAt: LONG_AGO,
    },
  });
  const attempt = await controlDb.supportRedemptionAttempt.create({
    data: { ipAddress: '203.0.113.9', ts: LONG_AGO, success: false, codePrefix: TAG.slice(0, 8) },
  });
  return { ordinaryAudit, legalAccepted, delivered, pending, attempt };
}

async function observe(f: Fixtures) {
  return {
    ordinaryAudit: !!(await controlDb.auditEvent.findUnique({ where: { id: f.ordinaryAudit.id } })),
    legalAccepted: !!(await controlDb.auditEvent.findUnique({ where: { id: f.legalAccepted.id } })),
    deliveredBody: (await controlDb.emailOutbox.findUnique({ where: { id: f.delivered.id } }))
      ?.bodyMarkdown,
    deliveredRow: !!(await controlDb.emailOutbox.findUnique({ where: { id: f.delivered.id } })),
    pendingBody: (await controlDb.emailOutbox.findUnique({ where: { id: f.pending.id } }))
      ?.bodyMarkdown,
    attempt: !!(await controlDb.supportRedemptionAttempt.findUnique({
      where: { id: f.attempt.id },
    })),
  };
}

const fixtures = await seed();

afterAll(async () => {
  clearPeriods();
  await controlDb.auditEvent
    .deleteMany({
      where: { id: { in: [fixtures.ordinaryAudit.id, fixtures.legalAccepted.id] } },
    })
    .catch(() => undefined);
  await controlDb.emailOutbox
    .deleteMany({ where: { id: { in: [fixtures.delivered.id, fixtures.pending.id] } } })
    .catch(() => undefined);
  await controlDb.supportRedemptionAttempt
    .deleteMany({ where: { id: fixtures.attempt.id } })
    .catch(() => undefined);
});

describe('performance-07 — the §6 periods are a switch, not a missing feature', () => {
  it('deletes nothing while the periods are unset, and names them in the run message', async () => {
    clearPeriods();
    const res = await sweepRetention();

    for (const v of PERIOD_VARS) {
      expect(res.message, `run message never mentions ${v}`).toContain(v);
    }
    expect(res.message).toContain('not configured');
    expect(res.counts?.controlAuditRowsDeleted).toBe(0);
    expect(res.counts?.emailBodiesPruned).toBe(0);
    expect(res.counts?.supportAttemptsDeleted).toBe(0);

    const after = await observe(fixtures);
    expect(after.ordinaryAudit).toBe(true);
    expect(after.deliveredBody).toContain('bring it back');
    expect(after.attempt).toBe(true);
  }, 180_000);

  it('refuses a period under the floor rather than acting on a typo', async () => {
    // Zero days would blank the body of a verification e-mail whose link is
    // still redeemable — and with EMAIL_DRIVER=console that body IS the
    // delivery, so the librarian would simply never get in.
    process.env.EMAIL_OUTBOX_BODY_RETENTION_DAYS = '0';
    const res = await sweepRetention();
    expect(res.counts?.emailBodiesPruned).toBe(0);
    expect((await observe(fixtures)).deliveredBody).toContain('bring it back');
    clearPeriods();
  }, 180_000);

  it('really deletes once a period is published, and spares what must survive', async () => {
    process.env.CONTROL_AUDIT_RETENTION_DAYS = '90';
    process.env.EMAIL_OUTBOX_BODY_RETENTION_DAYS = '30';
    process.env.SUPPORT_ATTEMPT_RETENTION_DAYS = '90';

    const res = await sweepRetention();
    expect(res.counts?.controlAuditRowsDeleted).toBeGreaterThanOrEqual(1);
    expect(res.counts?.emailBodiesPruned).toBeGreaterThanOrEqual(1);
    expect(res.counts?.supportAttemptsDeleted).toBeGreaterThanOrEqual(1);

    const after = await observe(fixtures);
    expect(after.ordinaryAudit).toBe(false);
    expect(after.attempt).toBe(false);
    // The body goes; the envelope stays, because `idempotencyKey` is @unique and
    // IS the dedup ledger — delete the row and the next hourly tick re-sends
    // every overdue notice this library has ever sent.
    expect(after.deliveredRow).toBe(true);
    expect(after.deliveredBody).toBe(PRUNED_MARKER);
    // Never sent, so its body is still the message.
    expect(after.pendingBody).toContain('still-redeemable');
    // The acceptance evidence is not retention-eligible at any period.
    expect(after.legalAccepted).toBe(true);
  }, 180_000);

  it('is a no-op on the next run', async () => {
    const res = await sweepRetention();
    expect(res.counts?.controlAuditRowsDeleted).toBe(0);
    expect(res.counts?.emailBodiesPruned).toBe(0);
    expect(res.counts?.supportAttemptsDeleted).toBe(0);
    clearPeriods();
  }, 180_000);
});
