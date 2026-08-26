import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import type { LibraryType } from '@libriant/db-control';
import { EmailService } from '../email/email.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { RedisService } from '../platform/redis.service.js';
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

/**
 * Ceiling on applications accepted platform-wide per hour, whatever address
 * they come from.
 *
 * input-and-files-10: the per-IP bucket above was the ONLY throttle on the one
 * unauthenticated write in the control plane, and it fails open by design — so
 * a Redis blip removed it entirely, leaving a single hidden honeypot input as
 * the whole defence. Rotating a forwarded-for header walked around it even with
 * Redis healthy: the auditor executed eight submissions with rotating
 * X-Real-IP and every one persisted. Each accepted submission is a
 * control-plane row plus an email to the operator's inbox, arriving exactly
 * when the Greek launch campaign is pointing real traffic at that page.
 *
 * 60/hour is twelve times the per-visitor budget and far above any honest burst
 * — 277 libraries on the campaign list, five free spots — so a real applicant
 * will never meet it. A script meets it inside the first minute.
 *
 * The `apply-all:` prefix is what makes this bucket fail CLOSED in Redis; see
 * FAIL_CLOSED_PREFIXES in RateLimitService for why this one and not the other.
 * What that refusal MEANS when Redis is the thing that broke is decided here,
 * by {@link ProcessWideCeiling} — not by letting the refusal reach the visitor.
 */
const GLOBAL_RATE_LIMIT = 60;
const GLOBAL_RATE_WINDOW_SEC = 3600;
const GLOBAL_RATE_KEY = 'apply-all:hour';

/**
 * The same ceiling, counted in THIS process, for the minutes when Redis cannot
 * count it for us.
 *
 * Closing input-and-files-10 by making the shared bucket fail closed traded one
 * silent failure for a louder one: a Redis blip now REFUSED library
 * applications outright, on the single unauthenticated write in the product,
 * days before a campaign to 277 Greek libraries whose entire purpose is
 * capturing five leads. Both of the obvious answers are wrong — allowing
 * everything re-opens the finding, refusing everything eats the leads the
 * bucket was added to protect — and neither is a decision this file gets to
 * make on the business's behalf.
 *
 * So neither. A Redis refusal is re-decided against a counter that lives in
 * this process, on the same 60/hour budget. There is one API instance today, so
 * that is very nearly the same ceiling; with N instances it degrades to 60/hour
 * EACH, which is still a ceiling and still far above any honest burst.
 *
 * It is spent on every accepted submission, not only during an outage: a
 * counter that starts at zero the moment Redis drops hands an attacker a fresh
 * 60 slots for free, which is the whole ceiling back again at the worst
 * possible moment.
 */
class ProcessWideCeiling {
  private windowStartedAt = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Claim one slot. False once this window is spent. */
  claim(now: number = Date.now()): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}

/**
 * How long the visitor's browser will wait for the operator's notification.
 *
 * The notification is documented as best-effort ("the application is already
 * committed"), and it was — except for the waiting. `EmailService.enqueue`
 * finishes with `queue.add`, and BullMQ's connection queues commands rather
 * than rejecting them, so with Redis down that call does not fail: it waits.
 * Making the throttle survive a Redis outage is what exposed it — before, the
 * ceiling refused the submission long before it could reach here — and the
 * result was a librarian watching a spinner for a form whose row was already
 * safely in the control plane.
 *
 * The outbox row and the `applications` row are both committed to Postgres by
 * then; only the BullMQ nudge is lost, and a timed-out enqueue is recorded on
 * `notifyError` for exactly that reason.
 */
const NOTIFY_TIMEOUT_MS = 3_000;

/**
 * `ip` — this visitor is over their own hourly budget.
 * `global` — the platform-wide ceiling tripped. Not the visitor's doing, and
 * the answer they get must not say it was.
 */
export type ThrottleVerdict = 'ok' | 'ip' | 'global';

export type ApplyResult =
  | { ok: true; id: string }
  | { ok: false; kind: 'invalid' | 'rate-limited' | 'save-failed'; parsed: Parsed };

/**
 * The outbox idempotency key of an application's admin notification.
 *
 * Exported because the retention sweep deletes that row together with the
 * application it describes (privacy-legal-14): the notification body restates
 * the applicant's name, e-mail and phone, and its envelope keeps their address
 * in `replyToEmail`, so deleting only the `applications` row left a second copy
 * of a person we had promised to forget. Both sides must agree on the key, and
 * a format retyped in `jobs/retention.job.ts` would agree only until somebody
 * edited one of them.
 */
export function applicationNotifyKey(applicationId: string): string {
  return `application.submitted:${applicationId}`;
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  private readonly pepper: string;
  private readonly notifyTo: string;
  private readonly localCeiling = new ProcessWideCeiling(
    GLOBAL_RATE_LIMIT,
    GLOBAL_RATE_WINDOW_SEC * 1000,
  );

  constructor(
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(RedisService) private readonly redis: RedisService,
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

  /**
   * Whether this submission is over budget, and WHICH budget — the caller needs
   * to know, because only one of the two is the visitor's own doing.
   *
   * The per-visitor bucket still fails OPEN: a Redis outage must not eat leads,
   * and it is checked first so a flood from one address never reaches (or
   * spends) the shared ceiling. The platform-wide ceiling behind it fails
   * CLOSED in Redis, which is the entire point of adding it — but a bucket that
   * fails closed refuses the honest applicant just as flatly as the script, so
   * the refusal is re-decided here against {@link ProcessWideCeiling} when Redis
   * is the thing that broke rather than the thing that counted.
   *
   * `client.status` is the discriminator because `hit()` cannot be one: a
   * genuine 61st submission and a Redis error both come back as
   * `{ allowed: false, count: limit + 1 }`. ioredis reports `ready` only while
   * the socket can carry a command (`enableOfflineQueue: false`, see
   * RedisService), so anything else means the count we were just refused by was
   * never taken.
   */
  async throttle(ip: string | undefined): Promise<ThrottleVerdict> {
    const perVisitor = await this.rateLimit.hit(this.ipKey(ip), RATE_LIMIT, RATE_WINDOW_SEC);
    if (!perVisitor.allowed) return 'ip';
    const platformWide = await this.rateLimit.hit(
      GLOBAL_RATE_KEY,
      GLOBAL_RATE_LIMIT,
      GLOBAL_RATE_WINDOW_SEC,
    );
    // Spent on every accepted submission, not only during an outage — see the
    // class comment for why a cold counter is the ceiling handed back.
    const localSlot = this.localCeiling.claim();
    if (platformWide.allowed) return 'ok';
    if (this.redis.client.status === 'ready') return 'global';
    if (!localSlot) return 'global';
    // Once per accepted-under-degradation submission: at 60/hour this cannot
    // become a storm, and an operator reading the outage needs to know the
    // ceiling is still being counted, by whom, and that leads are still landing.
    this.logger.warn(
      `Redis is ${this.redis.client.status} — the platform-wide /apply ceiling is being counted ` +
        `in-process for this instance (${GLOBAL_RATE_LIMIT}/${GLOBAL_RATE_WINDOW_SEC}s). ` +
        'The application was accepted.',
    );
    return 'ok';
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
      await withTimeout(
        this.email.enqueue({
          kind: 'application_submitted',
          toEmail: this.notifyTo,
          replyToEmail: v.contactEmail || undefined,
          subject: `Νέα αίτηση: ${v.libraryName || '—'} (${v.city || '—'})`,
          bodyMarkdown: body,
          idempotencyKey: applicationNotifyKey(id),
          maxAttempts: 3,
        }),
        NOTIFY_TIMEOUT_MS,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`application ${id}: notification enqueue failed: ${reason}`);
      await controlDb.application
        .update({ where: { id }, data: { notifyError: reason.slice(0, 500) } })
        .catch(() => undefined);
    }
  }
}

/**
 * Reject after `ms` if `work` has not settled. The work is NOT cancelled —
 * nothing here can cancel a BullMQ command — it is simply no longer something
 * the visitor's request waits on.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
