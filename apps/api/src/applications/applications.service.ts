import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import type { LibraryType } from '@libriant/db-control';
import { EmailService } from '../email/email.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { loadEnv } from '../config/env.js';
import { LIBRARY_TYPE_OPTIONS } from '@libriant/site';

export type FieldErrors = Partial<Record<string, string>>;
export type FieldValues = Partial<Record<string, string>>;
export type Parsed = { values: FieldValues; errors: FieldErrors };

/** Longest accepted value per field, matched to the column widths. */
const MAX_LEN: Record<string, number> = {
  libraryName: 200,
  libraryType: 40,
  city: 120,
  contactName: 160,
  contactEmail: 320,
  phone: 40,
  collectionSize: 40,
  currentSystem: 200,
  message: 4000,
};

const FIELDS = Object.keys(MAX_LEN);

/**
 * Deliberately permissive: an address the sender can actually receive at is the
 * only thing that matters, and a strict RFC pattern rejects valid ones.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Max applications accepted from one IP per hour. */
const RATE_LIMIT = 5;
const RATE_WINDOW_SEC = 3600;

export type ApplyResult =
  | { ok: true; id: string }
  | { ok: false; kind: 'invalid' | 'rate-limited' | 'save-failed'; parsed: Parsed };

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  private readonly pepper: string;
  private readonly notifyTo: string;

  constructor(
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {
    const env = loadEnv();
    this.pepper = env.applyHashPepper;
    this.notifyTo = env.applyNotifyTo;
  }

  /**
   * Validation, ported verbatim from the Cloudflare Worker this replaces.
   *
   * NOT `validateDto`: that helper sets `forbidNonWhitelisted`, which would 400
   * the honeypot field and invert its entire purpose, and disables implicit
   * conversion, which fights urlencoded string values. It also returns a single
   * message where the re-rendered form needs one per field.
   */
  validate(body: Record<string, unknown>, messages: ErrorMessages): Parsed {
    const values: FieldValues = {};
    const errors: FieldErrors = {};

    const trim = (k: string): string => {
      const v = body[k];
      return typeof v === 'string' ? v.trim() : '';
    };

    for (const key of FIELDS) values[key] = trim(key);
    // Only ever the literal 'yes' counts, so a truthy-looking value cannot pass.
    if (trim('consent') === 'yes') values.consent = 'yes';

    for (const [key, msg] of Object.entries(messages.required)) {
      if (!values[key]) errors[key] = msg;
    }

    for (const [key, max] of Object.entries(MAX_LEN)) {
      const v = values[key];
      if (v && v.length > max) errors[key] = messages.tooLong(max);
    }

    const email = values.contactEmail;
    if (email && !errors.contactEmail && !EMAIL_RE.test(email)) {
      errors.contactEmail = messages.badEmail;
    }

    const type = values.libraryType;
    if (type && !LIBRARY_TYPE_VALUES.has(type)) errors.libraryType = messages.badType;

    if (values.consent !== 'yes') errors.consent = messages.consent;

    return { values, errors };
  }

  /**
   * Salted SHA-256 of the client IP, for throttling only.
   *
   * The pepper must be secret: the whole IPv4 space is 2^32, so a hash with a
   * publicly-known salt is a rainbow table away from being the address itself.
   * The result lives in Redis under a one-hour TTL and never reaches Postgres —
   * which is what the published privacy notice says happens.
   */
  private ipKey(ip: string | undefined): string {
    const hash = createHash('sha256')
      .update(`${this.pepper}:${ip ?? '0.0.0.0'}`)
      .digest('hex');
    return `apply:iph:${hash}`;
  }

  /** True when this IP is over budget. Fails OPEN — a Redis outage must not eat leads. */
  async isRateLimited(ip: string | undefined): Promise<boolean> {
    const res = await this.rateLimit.hit(this.ipKey(ip), RATE_LIMIT, RATE_WINDOW_SEC);
    return !res.allowed;
  }

  /**
   * The commit point. Everything after the insert is best-effort; everything
   * before it can safely fail the request.
   */
  async save(parsed: Parsed, privacyVersion: string): Promise<string> {
    const v = parsed.values;
    const row = await controlDb.application.create({
      data: {
        libraryName: v.libraryName ?? '',
        libraryType: (v.libraryType ?? 'other') as LibraryType,
        city: v.city ?? '',
        contactName: v.contactName ?? '',
        contactEmail: v.contactEmail ?? '',
        phone: v.phone || null,
        collectionSize: v.collectionSize || null,
        currentSystem: v.currentSystem || null,
        message: v.message || null,
        // Bound from what was submitted, not a literal — this row is the
        // evidence of what the applicant actually did.
        consent: v.consent === 'yes',
        privacyVersion,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Queue the notification. Durable via EmailOutbox with a retry budget, where
   * the Worker sent inline and lost the message on any transient failure.
   */
  async notify(id: string, parsed: Parsed): Promise<void> {
    const v = parsed.values;
    const typeLabel =
      LIBRARY_TYPE_OPTIONS.el.find((o) => o.value === v.libraryType)?.label ?? v.libraryType ?? '—';
    const line = (label: string, value?: string): string => `- **${label}:** ${value || '—'}`;

    const body = [
      `### ${v.libraryName || '—'}`,
      '',
      line('Τύπος', typeLabel),
      line('Πόλη', v.city),
      line('Επικοινωνία', `${v.contactName ?? ''} <${v.contactEmail ?? ''}>`),
      line('Τηλέφωνο', v.phone),
      line('Μέγεθος συλλογής', v.collectionSize),
      line('Σημερινό σύστημα', v.currentSystem),
      '',
      v.message ? `> ${v.message.replace(/\n/g, '\n> ')}` : '_Χωρίς μήνυμα._',
      '',
      `\`id: ${id}\``,
    ].join('\n');

    try {
      await this.email.enqueue({
        kind: 'application_submitted',
        toEmail: this.notifyTo,
        replyToEmail: v.contactEmail || undefined,
        subject: `Νέα αίτηση: ${v.libraryName || '—'} (${v.city || '—'})`,
        bodyMarkdown: body,
        idempotencyKey: `application.submitted:${id}`,
        maxAttempts: 3,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`application ${id}: notification enqueue failed: ${reason}`);
      await controlDb.application
        .update({ where: { id }, data: { notifyError: reason.slice(0, 500) } })
        .catch(() => undefined);
    }
  }
}

/** Enum values, identical in both languages — validation must not depend on locale. */
export const LIBRARY_TYPE_VALUES: ReadonlySet<string> = new Set(
  LIBRARY_TYPE_OPTIONS.el.map((o) => o.value),
);

export type ErrorMessages = {
  required: Record<string, string>;
  tooLong: (max: number) => string;
  badEmail: string;
  badType: string;
  consent: string;
};
