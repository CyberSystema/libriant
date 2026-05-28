import { Injectable, Logger } from '@nestjs/common';

/**
 * Stub email delivery. Real SMTP / SES / Postmark integration is out of
 * MVP scope (same as 18a's notification emails). For now we just log
 * what *would* go out; admin can verify intent via the API logs and the
 * audit row on the announcement detail view ("delivered to email at …").
 *
 * Why a stub and not nothing: the service exists so the rest of the
 * announcement pipeline (per-tenant materialization, deliveredEmailAt
 * timestamps, stats counts) treats email as a first-class channel from
 * day one. Swapping in a real driver is a single-file change.
 *
 * TODO: replace with an actual mailer driver + retry queue. Until then,
 * `enqueue()` is synchronous + always succeeds.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  async enqueue(input: {
    to: string;
    subject: string;
    bodyMarkdown: string;
    announcementId: string;
    tenantId: string;
  }): Promise<{ deliveredAt: Date }> {
    this.logger.log(
      `[email-outbox] would send announcement ${input.announcementId} to ${input.to} (tenant=${input.tenantId}) — "${input.subject}"`,
    );
    return { deliveredAt: new Date() };
  }
}
