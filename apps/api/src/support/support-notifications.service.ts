import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb, type SupportSessionEndReason } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EmailService } from '../email/email.service.js';

/**
 * Step 18a notification surface, riding on Step 18d's email pipeline.
 *
 * Each method looks up the tenant's `primaryEmail` (the contact the
 * library opted into for "urgent platform notices") and enqueues a
 * `EmailMessageKind` with an idempotency key derived from the trigger
 * id, so retried requests / replayed jobs never spam the same library
 * twice for the same event.
 *
 * Failures here never throw — the trigger (key generation, redemption,
 * session end) is already committed by the caller; a failed enqueue
 * shouldn't roll that back. The error is logged for the worker to
 * recover from.
 */
@Injectable()
export class SupportNotificationsService {
  private readonly logger = new Logger(SupportNotificationsService.name);

  constructor(@Inject(EmailService) private readonly emails: EmailService) {}

  async keyGenerated(input: {
    keyId: string;
    tenantId: string;
    prefix: string;
    expiresAt: Date;
    createdByUserId: string;
  }): Promise<void> {
    const tenant = await this.tenantContact(input.tenantId);
    if (!tenant) return;
    const env = loadEnv();
    const lifetimeMin = Math.round(env.supportKeyTtlSec / 60);
    const settingsUrl = `${env.publicAppUrl}/${tenant.defaultLocale}/t/${tenant.slug}/settings/support-access`;
    const body = [
      `Hi,`,
      ``,
      `A one-time support key was just generated for ${tenant.name}.`,
      ``,
      `  Code prefix: SUPPORT-${input.prefix}…`,
      `  Expires:     ${input.expiresAt.toUTCString()} (${lifetimeMin} minutes)`,
      ``,
      `If you generated this, please share the full code with your Libriant`,
      `support contact — they need it to open a 4-hour debugging window.`,
      ``,
      `If you DID NOT generate this, revoke it immediately:`,
      `  ${settingsUrl}`,
      ``,
      `— Libriant`,
    ].join('\n');
    await this.tryEnqueue({
      idempotencyKey: `support.key.generated:${input.keyId}`,
      kind: 'support_key_generated',
      toEmail: tenant.primaryEmail,
      tenantId: input.tenantId,
      subject: `[${tenant.name}] A Libriant support key was just generated`,
      bodyMarkdown: body,
      metadata: { keyId: input.keyId, createdByUserId: input.createdByUserId },
    });
  }

  async keyRedeemed(input: {
    sessionId: string;
    tenantId: string;
    adminEmail: string;
    adminFullName: string;
    expiresAt: Date;
    ipAddress: string | null;
  }): Promise<void> {
    const tenant = await this.tenantContact(input.tenantId);
    if (!tenant) return;
    const env = loadEnv();
    const settingsUrl = `${env.publicAppUrl}/${tenant.defaultLocale}/t/${tenant.slug}/settings/support-access`;
    const body = [
      `Hi,`,
      ``,
      `${input.adminFullName} (${input.adminEmail}) just redeemed a Libriant`,
      `support key for ${tenant.name}.`,
      ``,
      `  Opened:  now`,
      `  Expires: ${input.expiresAt.toUTCString()} (4 hours)`,
      `  From IP: ${input.ipAddress ?? 'unknown'}`,
      ``,
      `Every action Libriant takes during this window is logged. You can`,
      `view the live audit log or end the session immediately:`,
      `  ${settingsUrl}`,
      ``,
      `— Libriant`,
    ].join('\n');
    await this.tryEnqueue({
      idempotencyKey: `support.key.redeemed:${input.sessionId}`,
      kind: 'support_key_redeemed',
      toEmail: tenant.primaryEmail,
      tenantId: input.tenantId,
      subject: `[${tenant.name}] Libriant support just opened a session`,
      bodyMarkdown: body,
      metadata: { sessionId: input.sessionId, adminEmail: input.adminEmail },
    });
  }

  async sessionEnded(input: {
    sessionId: string;
    tenantId: string;
    endedReason: SupportSessionEndReason;
    actionCount: number;
  }): Promise<void> {
    const tenant = await this.tenantContact(input.tenantId);
    if (!tenant) return;
    const env = loadEnv();
    const settingsUrl = `${env.publicAppUrl}/${tenant.defaultLocale}/t/${tenant.slug}/settings/support-access`;
    const reasonHuman: Record<SupportSessionEndReason, string> = {
      expired: 'expired automatically (4-hour window elapsed)',
      admin_ended: 'was ended by the Libriant support engineer',
      library_revoked: 'was ended by you (or another library admin)',
    };
    const body = [
      `Hi,`,
      ``,
      `The Libriant support session on ${tenant.name} ${reasonHuman[input.endedReason]}.`,
      ``,
      `  Actions recorded during the window: ${input.actionCount}`,
      ``,
      `Full audit log:`,
      `  ${settingsUrl}`,
      ``,
      `— Libriant`,
    ].join('\n');
    await this.tryEnqueue({
      idempotencyKey: `support.session.ended:${input.sessionId}`,
      kind: 'support_session_ended',
      toEmail: tenant.primaryEmail,
      tenantId: input.tenantId,
      subject: `[${tenant.name}] Libriant support session ended`,
      bodyMarkdown: body,
      metadata: { sessionId: input.sessionId, endedReason: input.endedReason },
    });
  }

  // --- helpers -----------------------------------------------------------

  private async tenantContact(tenantId: string) {
    return controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, primaryEmail: true, defaultLocale: true },
    });
  }

  private async tryEnqueue(input: Parameters<EmailService['enqueue']>[0]): Promise<void> {
    try {
      await this.emails.enqueue(input);
    } catch (err) {
      this.logger.warn(
        `support notification enqueue failed (${input.kind} → ${input.toEmail}): ${(err as Error).message}`,
      );
    }
  }
}
