import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleEmailDriver } from './drivers/console-driver.js';
import { sendOutcome } from './email-worker.js';

/**
 * privacy-legal-18.
 *
 * `EMAIL_DRIVER=console` is the shipped configuration — there is no Resend key
 * — and the console driver does not throw, it just does nothing. The worker
 * wrote `status: 'delivered', deliveredAt: now` for every message it returned
 * from, so the outbox recorded a delivery for every overdue notice, every
 * hold-ready notice and every password reset that in fact went nowhere. That
 * row is what `/admin/emails` shows a librarian, and what an Art. 5(2)
 * accountability file would quote.
 *
 * These assertions run the REAL `ConsoleEmailDriver` through the REAL
 * `sendOutcome` the worker calls — no hand-built result object standing in for
 * a driver, because the whole defect was a driver whose honest answer nobody
 * asked for. The one thing this cannot reach from a unit test is the Prisma
 * write; `apps/api/test/integration/email-not-delivered.spec.ts` boots the
 * actual worker against the actual control database for that.
 */

const SEND = {
  to: 'patron@example.test',
  from: 'library@example.test',
  replyTo: null,
  subject: 'Εκπρόθεσμο: «Το Κιβώτιο»',
  bodyMarkdown: 'Αγαπητέ/ή Μαρία,\n\nΤο βιβλίο είναι εκπρόθεσμο.',
  idempotencyKey: 'outbox-row-abc123',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('undelivered mail is not recorded as delivered (privacy-legal-18)', () => {
  it('the console driver reports that it sent nothing', async () => {
    const result = await new ConsoleEmailDriver().send(SEND);
    expect(result.delivered).toBe(false);
    // A provider id for a message no provider ever saw was the other half of
    // the row's false claim.
    expect(result.providerId).toBeNull();
    expect(result.notDeliveredReason).toContain('EMAIL_DRIVER=console');
  });

  it('the worker turns that report into a failed row, not a delivered one', async () => {
    const at = new Date('2026-08-26T10:00:00.000Z');
    const outcome = sendOutcome(await new ConsoleEmailDriver().send(SEND), at);

    expect(outcome.status).toBe('failed');
    // The two columns a librarian or an auditor actually reads as "it went
    // out". Both must stay empty on a message that was never sent.
    expect(outcome.deliveredAt).toBeNull();
    expect(outcome.providerId).toBeNull();
    expect(outcome.failedAt).toEqual(at);
    expect(outcome.lastError).toContain('never sent to anyone');
  });

  it('still records a real send as delivered', () => {
    const at = new Date('2026-08-26T10:00:00.000Z');
    // What SmtpEmailDriver/ResendEmailDriver return once the transport has
    // accepted the message. Constructing those drivers opens a transport, so
    // this is the one place the shape is stated rather than produced — the
    // point of the assertion is that the new field did not break the path that
    // was already correct.
    const outcome = sendOutcome({ providerId: '<abc@libriant>', delivered: true }, at);
    expect(outcome.status).toBe('delivered');
    expect(outcome.deliveredAt).toEqual(at);
    expect(outcome.providerId).toBe('<abc@libriant>');
    expect(outcome.lastError).toBeNull();
  });

  it('keeps the patron and the book title out of the container log', async () => {
    // NODE_ENV is `test` under vitest, so this is the non-development branch —
    // the one that runs on the box. It used to log
    // `"${subject}" to ${to}`, which pairs a named member's e-mail address
    // with the title they have out: a borrowing record, in journald, with no
    // retention rule, on a deployment that by definition sent nothing.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await new ConsoleEmailDriver().send(SEND);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).not.toContain(SEND.to);
    expect(line).not.toContain('Το Κιβώτιο');
    // It still has to be greppable: the outbox id is how an operator finds the
    // message in /admin/emails, and it is not personal data.
    expect(line).toContain(SEND.idempotencyKey);
  });
});
