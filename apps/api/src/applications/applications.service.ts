import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import type { LibraryType } from '@libriant/db-control';
import { findCountry, isCountryCode } from '@libriant/shared';
import { EmailService } from '../email/email.service.js';
import { NotifyService } from '../platform/notify.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { RedisService } from '../platform/redis.service.js';
import { loadEnv } from '../config/env.js';
import { LIBRARY_TYPE_OPTIONS, type RequiredField, type SiteConfig } from '@libriant/site';
import siteConfigRaw from '@libriant/site/site.config.json' with { type: 'json' };

/**
 * How many places the offer has. The same file the marketing site builds from,
 * so the page's promise and the server's gate cannot disagree — the count of
 * places already given away is NOT in there any more; see {@link OfferState}.
 */
export const OFFER_TOTAL = (siteConfigRaw as unknown as SiteConfig).offer.spotsTotal;

export type FieldErrors = Partial<Record<string, string>>;
export type FieldValues = Partial<Record<string, string>>;
export type Parsed = { values: FieldValues; errors: FieldErrors };

/**
 * Longest accepted value per field, matched to the column widths — and, since
 * it is also the list of keys read off the submission, the definition of which
 * fields exist at all.
 *
 * `country` and `phoneDialCode` are both capped at 2, because both carry an ISO
 * 3166-1 alpha-2 code rather than free text — the dial `<select>` is valued by
 * COUNTRY, not by digits, since 25 countries share `+1` and a select whose
 * options do not distinguish the answers cannot give the applicant back the one
 * they picked (apps/site/src/pages.ts, `phoneField`). Both are then looked up in
 * the canonical list, so the cap is not what makes them safe; it is what bounds
 * the string that reaches the lookup.
 */
const MAX_LEN: Record<string, number> = {
  libraryName: 200,
  libraryType: 40,
  city: 120,
  country: 2,
  contactName: 160,
  contactEmail: 320,
  phoneDialCode: 2,
  phone: 40,
  collectionSize: 40,
  currentSystem: 200,
  message: 4000,
};

const FIELDS = Object.keys(MAX_LEN);

/**
 * The fields checked against a fixed list rather than a length. Their submitted
 * value is either one of ours or it is nothing, so it is never truncated on the
 * way back out to the form — see the end of {@link ApplicationsService.validate}.
 */
const WHITELISTED_FIELDS = new Set(['country', 'phoneDialCode', 'libraryType']);

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
 * How many application pushes this process sends in one hour before it starts
 * saying "there are more" instead of saying them one at a time.
 *
 * The push has to survive the day somebody points a script at the form, and
 * the ceilings on THIS path say exactly how bad that day can get: 5 accepted
 * submissions per visitor per hour, 60 platform-wide (input-and-files-10, and
 * {@link ProcessWideCeiling} when Redis cannot count). Sixty phone
 * notifications an hour is a muted topic — and a muted topic is the same
 * blindness as no topic, arrived at by the operator's own hand, where nothing
 * in this file can detect it (scheduled-jobs.runner.ts makes the same argument
 * about a permanently-red alert).
 *
 * Six is far above any honest hour. The campaign points 277 Greek libraries at
 * a form with FIVE places on it, so an hour containing six real applications
 * is already the best hour this product will ever have; the seventh is a
 * burst, and a burst is one fact ("go and look"), not six more buzzes.
 *
 * The burst line gets its own budget of one, on the SAME window length, so
 * "one burst notice per hour of being over budget" falls out without a second
 * clock: that window starts when the budget first runs dry.
 */
const PUSH_BUDGET_PER_HOUR = 6;
const PUSH_WINDOW_MS = 60 * 60_000;

/**
 * The id the controller passes when the commit point itself threw, so there is
 * no row to point anybody at (see the `catch` around `save` in
 * applications.controller.ts). No uuid can take this shape, so reading it as a
 * sentinel here cannot collide with a real application.
 */
const UNSAVED_ID = 'unsaved';

/** Where the operator answers an application, or an honest phrase when the
 *  admin host is not configured. Shared so the two messages cannot drift. */
function panelUrl(adminHost: string): string {
  return adminHost ? `https://${adminHost}/en/admin/applications` : 'the admin panel';
}

/**
 * The whole of what a new application puts on the operator's phone.
 *
 * READ THE COMMENT ON {@link ApplicationsService.notify} BEFORE CHANGING A
 * WORD OF THIS. The rule there is "the library and the town, never the
 * person", written for a container log — and this message is worse than a
 * container log in every dimension the rule was reasoning about: it leaves the
 * country to a server we do not run, it is retained there, it is cached on a
 * handset, and on a public ntfy topic anybody who guesses the string reads it.
 * So it carries the institution, its town and its country, and nothing else:
 * no contact name, no e-mail address, no phone number, no message body, no
 * collection size, no current system. A library's name is an institution's
 * name; everything else on that form belongs to a person.
 *
 * The application id is deliberately absent too, though it is not personal
 * data and it IS in the log line: it is 36 characters of UUID on a lock
 * screen, and it answers "which row?" — a question the admin panel, sorted
 * newest first, answers better than a phone does.
 *
 * English, matching every other operator-facing surface in this repository
 * (the log line above, alerts.yml's annotations, scripts/_lib/notify.sh's own
 * test message) and therefore matching the rest of the traffic on this topic:
 * the backup, the deploy and Alertmanager all publish English to it, and one
 * channel that changes language per sender is harder to read than either
 * language alone. The library's own name stays in whatever alphabet it was
 * submitted in — the JSON publish shape exists so Greek survives the wire.
 *
 * The admin host is the one piece of our infrastructure named here. It is
 * already public: it resolves in DNS and every certificate issued for it is in
 * the Certificate Transparency logs. It buys the operator a tap instead of a
 * typed URL, which is the difference between a doorbell and a chore.
 *
 * Exported for the spec, because "what exactly reaches the phone" is the one
 * thing about this feature that must never be inferred from a mock.
 */
export function applicationAnnouncement(
  v: FieldValues,
  saved: boolean,
  adminHost: string,
): { title: string; body: string } {
  const country = v.country ? (findCountry(v.country)?.en ?? v.country) : '';
  const where = [v.city || '—', country].filter(Boolean).join(', ');
  const who = `${v.libraryName || '—'} — ${where}`;

  if (saved) {
    return {
      title: 'New library application',
      body: `${who}\nOpen ${panelUrl(adminHost)} to read and answer it.`,
    };
  }
  // The commit point threw, so there is no row and no panel entry to open —
  // naming one would send the operator somewhere the lead is not. What exists
  // is the API container log and an outbox row that EMAIL_DRIVER=console will
  // never deliver, so those are what the message names.
  return {
    title: 'Application NOT saved — the public form is failing',
    body:
      `${who}\nThe control database refused the row. This lead is only in the API ` +
      `container log and, undelivered, in the outbox at /admin/emails. Real libraries ` +
      `are being answered with a 500 right now.`,
  };
}

/**
 * How many of the launch-offer places have been given away, and therefore
 * whether the public form is still open.
 *
 * `taken` counts applications the operator has marked `accepted`. Three
 * candidates were considered and rejected:
 *   - the literal in site.config.json — that is the finding
 *     (launch-readiness-11): nothing decremented it, so it advertised five
 *     places that were already promised;
 *   - the number of tenants — signup at app.libriant.com is self-serve, so
 *     that pool counts every library that ever tried the product, not the ones
 *     given a free year;
 *   - `contacted` — answering an application is not a promise of a place, and
 *     counting it would close the form on the strength of a reply.
 * `accepted` is the exact moment a librarian is told "you have one of the
 * five", which is the moment there is one fewer to advertise.
 */
export type OfferState = { total: number; taken: number; open: boolean };

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
  /** Named in the log line below so the operator can click it, not guess it. */
  private readonly adminHost: string;
  /** Read once so the log line can say whether the e-mail will reach anyone. */
  private readonly emailDriver: string;
  private readonly localCeiling = new ProcessWideCeiling(
    GLOBAL_RATE_LIMIT,
    GLOBAL_RATE_WINDOW_SEC * 1000,
  );
  /**
   * The hourly push budget and the one burst line that replaces it. Both are
   * {@link ProcessWideCeiling}, the same counter the platform-wide submission
   * ceiling already uses — the shape ("claim a slot from a rolling window, or
   * do not") is identical and a second implementation of it would only be a
   * second thing to get wrong.
   */
  private readonly pushBudget = new ProcessWideCeiling(PUSH_BUDGET_PER_HOUR, PUSH_WINDOW_MS);
  private readonly pushBurst = new ProcessWideCeiling(1, PUSH_WINDOW_MS);

  constructor(
    @Inject(EmailService) private readonly email: EmailService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(RedisService) private readonly redis: RedisService,
    /**
     * Injected rather than constructed, so this process has exactly ONE
     * notifier: its 20-per-5-minutes ceiling is the last defence against a
     * notification loop anywhere in the API, and a private instance here would
     * quietly hold a budget of its own. It needs no import in
     * applications.module.ts — PlatformModule is `@Global` for this provider.
     */
    @Inject(NotifyService) private readonly pushes: NotifyService,
  ) {
    const env = loadEnv();
    this.pepper = env.applyHashPepper;
    this.notifyTo = env.applyNotifyTo;
    this.adminHost = env.adminHost;
    this.emailDriver = env.emailDriver;
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

    // A `<select>` guarantees the server nothing: this is the only
    // unauthenticated write in the control plane, and the submitter is assumed
    // not to have used the form at all. So both codes are looked up in the
    // canonical list rather than trusted, exactly as `libraryType` is above.
    //
    // Guarded on truthiness for the same reason `libraryType` is: the country
    // select opens on an empty «Επιλέξτε…» option, so a visitor really can
    // submit nothing, and telling them "you have not chosen one" is the
    // required loop's job. Only a country they did name reaches the lookup, so
    // the two mistakes get the two different sentences they deserve.
    const country = values.country;
    if (country && !isCountryCode(country)) errors.country = messages.badCountry;

    // The dial code is NOT guarded, because it has no `required` entry to fall
    // through to and deliberately so (apps/site/src/copy.ts, ErrorCopy): its
    // select carries no empty option and a native select cannot be cleared, so
    // an empty one is a malformed submission rather than an answer a visitor
    // can get wrong. It is also not checked against the country above — the two
    // selects cannot be kept in step without JavaScript and the site ships
    // none, and a Greek library whose contact carries a Cypriot mobile must not
    // be told that pair is an error it has no way to resolve.
    if (!isCountryCode(values.phoneDialCode)) errors.phoneDialCode = messages.badDialCode;

    if (values.consent !== 'yes') errors.consent = messages.consent;

    // Echo back only what the field can hold.
    //
    // A rejected submission comes back as the whole page with the visitor's
    // answers in it, so nothing has to be retyped — and an over-long value used
    // to be echoed whole. A 100KB `message` (body-parser's default cap, which
    // nothing here narrows) returned inside a ~540KB page, escaped and gzipped:
    // five times the request that asked for it, on a path the controller
    // deliberately does not meter, since the throttle runs after validation so
    // an honest typo does not burn anyone's budget. Capping the echo takes the
    // amplification away without taking that decision away — the response is
    // now bounded by the form rather than by the request — and it is the honest
    // answer to the visitor too, because what is missing is exactly what they
    // have to delete.
    //
    // LAST, after every check above, and never for the three fields validated
    // against a fixed list. Truncating first turned `country: 'GRC'` into a
    // perfectly valid 'GR': the lookup then passed, the message became "too
    // long" instead of "choose one of the available countries", and the form
    // came back with Greece selected for someone who never chose it. Their caps
    // are 2, 2 and 40 characters, so there is no amplification to prevent there
    // anyway — an unusable code is simply echoed as nothing, which is what
    // `options()` already does with a value that matches no entry.
    for (const [key, max] of Object.entries(MAX_LEN)) {
      if (WHITELISTED_FIELDS.has(key)) continue;
      const v = values[key];
      if (v && v.length > max) values[key] = v.slice(0, max);
    }

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
   * How many places are left, asked of the only thing that knows.
   *
   * FAILS OPEN. If the count itself cannot be taken, the visitor is let
   * through: refusing would tell a real library "the five places are gone" on
   * the strength of a database blip, and that is a sentence they will believe
   * and never come back from. If Postgres is genuinely down, `save()` fails a
   * few lines later and they get the honest "write to us at this address"
   * answer instead of a false one.
   *
   * No cache. This runs on the one unauthenticated write in the control plane,
   * behind a 5/hour per-visitor bucket and a 60/hour platform ceiling, against
   * an index on (status, createdAt) — the whole campaign is 277 mailboxes, so
   * the query count here is not a number worth optimising away into staleness.
   */
  async offerState(): Promise<OfferState> {
    const total = OFFER_TOTAL;
    try {
      const taken = await controlDb.application.count({ where: { status: 'accepted' } });
      return { total, taken, open: taken < total };
    } catch (err) {
      this.logger.error(
        `Could not count the accepted applications (${err instanceof Error ? err.message : String(err)}) — ` +
          'treating the launch offer as OPEN so a database blip cannot turn a real applicant away.',
      );
      return { total, taken: 0, open: true };
    }
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
        country: v.country || null,
        contactName: v.contactName ?? '',
        contactEmail: v.contactEmail ?? '',
        phone: dialablePhone(v) || null,
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
   *
   * "Durable" was doing a lot of work in that sentence (launch-readiness-03).
   * Libriant launches with EMAIL_DRIVER=console: the message is composed and
   * stored, the outbox row is honestly recorded as `failed` with a reason
   * (ConsoleEmailDriver, privacy-legal-18), and nobody receives it — a durable
   * record of a notification that never arrives is still not a notification.
   * Meanwhile the site promises an answer within two working days
   * and the campaign points 277 Greek libraries at the form. So the enqueue
   * below is no longer the only thing that happens when a library applies —
   * the log line is a second channel that works with the mail driver we
   * actually run, and the admin panel's Applications page (with the unread
   * count in the sidebar) is the one an operator will actually see.
   *
   * BOTH OF THOSE STILL REQUIRE SOMEBODY TO GO AND LOOK, which is the half of
   * launch-readiness-03 an admin screen cannot close: the campaign drives 277
   * mailboxes at this form and the site promises an answer within two working
   * days, so "it is readable when you next open the panel" is not the same
   * commitment. {@link announce} is the push that closes it — the only channel
   * here that arrives without being asked for, and the only one that needs no
   * mail provider.
   */
  async notify(id: string, parsed: Parsed): Promise<void> {
    const v = parsed.values;

    // The library and the town, never the person. This line lands in the
    // container log, which is rolled and archived into the nightly backup and
    // is reached by no retention sweep — so the applicant's name, address and
    // phone stay out of it, exactly as they stay out of cross-tenant audit
    // rows (privacy-legal-04). A library's name is an institution's name.
    this.logger.warn(
      `NEW APPLICATION — ${v.libraryName || '—'} (${v.city || '—'}) · id ${id}. ` +
        `Open ${this.adminHost ? `https://${this.adminHost}` : ''}/en/admin/applications to read and answer it.` +
        (this.emailDriver === 'console'
          ? ' EMAIL_DRIVER=console: the notification e-mail is composed and delivered to nobody, ' +
            'so this line and the admin panel are the whole notification.'
          : ''),
    );
    this.announce(id !== UNSAVED_ID, v);
    const typeLabel =
      LIBRARY_TYPE_OPTIONS.el.find((o) => o.value === v.libraryType)?.label ?? v.libraryType ?? '—';
    // The body is Greek throughout (the operator reads it), so the country is
    // named the way the rest of the message is rather than left as 'GR'. An
    // unresolvable code falls back to itself instead of to a dash: if this ever
    // prints a raw code, the operator should see WHICH one.
    const countryLabel = v.country ? (findCountry(v.country)?.el ?? v.country) : '';
    const line = (label: string, value?: string): string => `- **${label}:** ${value || '—'}`;

    const body = [
      `### ${v.libraryName || '—'}`,
      '',
      line('Τύπος', typeLabel),
      line('Πόλη', v.city),
      line('Χώρα', countryLabel),
      line('Επικοινωνία', `${v.contactName ?? ''} <${v.contactEmail ?? ''}>`),
      line('Τηλέφωνο', dialablePhone(v)),
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

  /**
   * Ring the doorbell — launch-readiness-03's missing half.
   *
   * `sendDetached`, not `send`. This runs on the visitor's request, in front of
   * a 303 to the thank-you page, and NOTIFY_TIMEOUT_MS above already documents
   * what the alternative costs: a librarian watching a spinner for a form whose
   * row is already safely committed. NotifyService promises never to reject, so
   * dropping the promise is safe; it swallows and logs its own failures, which
   * is the "a notification must never break the thing it reports on" rule
   * pushed down into the one place that can enforce it.
   *
   * WHY THIS SITS BEHIND A BUDGET AT ALL, when a real hour holds one or two
   * applications: because the worst hour is not a real hour. Sixty submissions
   * can be accepted platform-wide (input-and-files-10) and every one of them
   * would otherwise buzz. The seventh in an hour therefore becomes ONE line
   * that says there are more — which is also the most useful thing the channel
   * can say at that moment, because six real applications in an hour and a
   * script working the form look identical from here, and both mean "open the
   * panel".
   *
   * NOT SAVED IS THE LOUDER OF THE TWO. `warn` for an application that landed:
   * the site promises an answer within two working days, not two minutes, and
   * an operator woken at 03:00 by a form submission mutes the topic — which
   * turns off the backup and deploy alerts riding on it, in the one way no code
   * here can detect. `error` when the row did not commit, because that is the
   * single unauthenticated write in the control plane refusing real libraries
   * during the campaign, and it is the one state on this path where being woken
   * beats not being woken.
   */
  private announce(saved: boolean, v: FieldValues): void {
    // NotifyService documents that `send` never rejects, and `sendDetached`
    // depends on that. This does not: "a notification must never break the
    // thing it reports on" is a promise the FUNNEL has to keep whatever the
    // notifier does, and everything after this call — the outbox enqueue and
    // the `notifyError` column — is what a throw from here would skip.
    try {
      this.push(saved, v);
    } catch (err) {
      this.logger.error(
        `application push failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The decision and the message. Wrapped by {@link announce}. */
  private push(saved: boolean, v: FieldValues): void {
    if (this.pushBudget.claim()) {
      const { title, body } = applicationAnnouncement(v, saved, this.adminHost);
      this.pushes.sendDetached({
        level: saved ? 'warn' : 'error',
        title,
        body,
        tags: ['inbox_tray'],
      });
      return;
    }
    // One line per hour of being over budget, and then silence. The window on
    // this second counter starts the moment the first one runs dry.
    if (this.pushBurst.claim()) {
      this.pushes.sendDetached({
        level: 'warn',
        title: 'More applications than this channel will announce',
        body:
          `More than ${PUSH_BUDGET_PER_HOUR} applications were accepted in the last hour, so ` +
          `the rest are not being announced one at a time. Open ${panelUrl(this.adminHost)}. ` +
          'If this is not a real rush, the public form is being scripted.',
        tags: ['inbox_tray'],
      });
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

/**
 * The phone as it has to be dialled: the code the applicant chose in front of
 * the number they typed — `+30 2410000000`.
 *
 * `phoneDialCode` is a COUNTRY, not digits — `CA` and `US` are different
 * answers that both dial `+1`, and the form has to be able to hand back the one
 * the applicant picked — so the digits are looked up here rather than sent.
 *
 * The two halves stay separate in {@link Parsed} because the form has two
 * controls and a failed submission comes back with both of them still filled
 * in. They are joined here, on the way out to Postgres and to the operator's
 * notification, which is the last point at which either half is read alone.
 *
 * STORING THEM AS TWO COLUMNS WAS THE ALTERNATIVE, AND IT LOSES ON WHO HAS TO
 * REMEMBER. `phone` is already read straight out of the row and dropped into a
 * `tel:` link by the admin panel's ApplicationsClient.tsx, and exported as one
 * CSV cell. Splitting it makes every one of those surfaces responsible for
 * putting the number back together, and the first one that forgets shows a bare
 * national number — a lead nobody outside the country can ring, which is the
 * exact failure that making the phone compulsory exists to prevent. Composed
 * here, both surfaces are right without either of them changing.
 *
 * The national part is stored EXACTLY as typed. Stripping spaces and
 * punctuation would tidy `2410 000 000` and quietly ruin
 * `2410000000 (εσωτ. 12)`; dropping a leading trunk zero is correct for the UK
 * and wrong for Italy. Neither is a judgement to make on a stranger's phone
 * number on their behalf.
 */
export function dialablePhone(v: FieldValues): string {
  const national = v.phone?.trim() ?? '';
  if (!national) return '';
  // Already international, so do not prefix it again. The form asks for the
  // code in a separate select and says so in the hint, but a fair number of
  // people type it into the number anyway — and it is also the only way to
  // express a number whose country is not the one the select is showing.
  // Composing regardless produced '+30 +357 99123456', which is not a number
  // anyone can ring: the exact silent-loss failure this function exists to
  // avoid, manufactured by the function itself.
  if (national.startsWith('+')) return national;
  const dial = v.phoneDialCode ? findCountry(v.phoneDialCode)?.dial : undefined;
  return dial ? `+${dial} ${national}` : national;
}

/** Enum values, identical in both languages — validation must not depend on locale. */
export const LIBRARY_TYPE_VALUES: ReadonlySet<string> = new Set(
  LIBRARY_TYPE_OPTIONS.el.map((o) => o.value),
);

export type ErrorMessages = {
  /**
   * Imported, not restated. This type mirrors `ErrorCopy` in
   * apps/site/src/copy.ts so the service can be tested without the site's
   * config; a locally-written `Record<string, string>` here would have widened
   * the union straight back to the thing it exists to prevent.
   */
  required: Record<RequiredField, string>;
  tooLong: (max: number) => string;
  badEmail: string;
  badType: string;
  badCountry: string;
  badDialCode: string;
  consent: string;
};
