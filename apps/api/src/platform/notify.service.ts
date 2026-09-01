import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env.js';

/**
 * Push notifications to the operator's phone, over HOSTED ntfy.
 *
 * This is the in-container half of a contract whose other half is
 * scripts/_lib/notify.sh, for the host scripts that run outside Docker. Same
 * priority model, same redaction rules, same four environment variables, same
 * two promises: it is best-effort, and it is off unless a topic is configured.
 * Read the header of that file for WHY the publisher is somebody else's server
 * — briefly: an alerting service inside our own compose file dies with the box
 * it is alerting about, which is precisely the state worth being told about.
 *
 * WHAT MAY GO IN A NOTIFICATION.
 *
 * The rule this codebase already applies to its own logs, and one notch
 * stricter. `notify()` in applications.service.ts keeps the applicant's name,
 * address and phone out of a CONTAINER LOG because that log is rolled into the
 * nightly backup and reached by no retention sweep. An ntfy message is worse in
 * every dimension: it leaves the country to a third party, is retained there,
 * is cached on a handset, and on a public topic is readable by anyone who
 * guesses the topic string. So: the library and the town, never the person.
 * A notification says WHAT happened and WHERE TO LOOK — it is a doorbell, not
 * a letter. {@link redactForNotification} is the net under a careless call
 * site, not permission to stop thinking at one.
 *
 * WHAT IT WILL NEVER DO.
 *
 * Fail a caller. {@link send} resolves — never rejects — is bounded by
 * {@link SEND_TIMEOUT_MS}, and writes at most one line per failed send. If
 * ntfy.sh is down, slow or rate-limiting, the request that triggered the
 * notification still succeeds. Nothing in this application becomes required
 * because this service exists.
 */

/**
 * THE PRIORITY TABLE — the compiled copy.
 *
 * The canonical one is `_NTFY_LEVELS` in scripts/_lib/notify.sh, which is also
 * where the reasoning lives (why four levels and not five; why level 5 is
 * rationed; why a new application is a `warn` and not an `error`). It cannot
 * be shared as a file at runtime: this code ships inside a container that does
 * not carry scripts/, so there is a copy here and notify.service.spec.ts reads
 * the shell file off disk and fails the unit suite the moment the two
 * disagree. One table, enforced by a gate rather than by hoping.
 */
export const NOTIFY_LEVELS = {
  /** ntfy 1 — silent, no pop-up, sits in the history. Step-by-step tracing. */
  debug: { priority: 1, tag: 'mag' },
  /** ntfy 3 — short vibration, pops up. "It worked" / "it finished". */
  info: { priority: 3, tag: 'information_source' },
  /** ntfy 4 — long vibration, pops up. "Look at this today." */
  warn: { priority: 4, tag: 'warning' },
  /**
   * ntfy 5 — the loudest, and the only one a handset can be set to let through
   * do-not-disturb. Rationed to states where being woken at 03:00 beats not
   * being woken.
   */
  error: { priority: 5, tag: 'rotating_light' },
} as const;

export type NotifyLevel = keyof typeof NOTIFY_LEVELS;

export const NOTIFY_LEVEL_NAMES = Object.keys(NOTIFY_LEVELS) as NotifyLevel[];

/**
 * An unrecognised level resolves to `warn`, never to `info` and never to
 * `error`: a typo at a call site must not quietly demote an alert into the
 * history, and must not promote a routine line into the one priority that can
 * override do-not-disturb.
 */
const FALLBACK_LEVEL: NotifyLevel = 'warn';

/**
 * Single-digit seconds. This can be awaited on a request path, and the whole
 * design says a notification is allowed to be lost but never to be slow — the
 * same argument NOTIFY_TIMEOUT_MS in applications.service.ts already makes
 * about a librarian watching a spinner.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Character caps, matching `_NOTIFY_MAX_TITLE` / `_NOTIFY_MAX_BODY` in the
 * shell library. ntfy.sh accepts 250 bytes of title and 4096 of message; these
 * are low enough that even an all-Greek string — two bytes a character, four
 * for an emoji — stays inside those byte caps without anyone counting bytes.
 */
const MAX_TITLE = 100;
const MAX_BODY = 900;

/**
 * A process-wide ceiling, and an honest account of what it does not cover.
 *
 * ntfy.sh's free tier allows a few hundred messages a day. The failure this
 * guards is a loop — a job that fires on every row, a handler that notifies
 * inside a retry — which would burn the daily budget in seconds, get the
 * topic rate-limited, and (much worse) teach the operator to mute it. A muted
 * topic is a dead channel that no code here can detect, so noise is the real
 * risk to this feature, not silence.
 *
 * It does NOT cover a crash loop: a restarting container gets a fresh process
 * and a fresh counter. That case is bounded by ntfy.sh's own 429, which is
 * handled as a dropped notification and nothing else.
 */
const CEILING_MAX = 20;
const CEILING_WINDOW_MS = 5 * 60 * 1000;

/** Replacement markers, exported so specs assert against a name not a literal. */
export const NOTIFY_REDACTIONS = {
  credential: '[redacted]',
  token: '[redacted-token]',
  hex: '[redacted-hex]',
  email: '[email]',
  ip: '[ip]',
  phone: '[phone]',
} as const;

/**
 * The last line of defence on every outgoing title and body.
 *
 * Deliberately greedy. Over-redacting a doorbell costs an operator one extra
 * `ssh`; under-redacting it puts a member's e-mail address on a third-party
 * server in another country, permanently, where a stranger who guessed the
 * topic can read it. When in doubt this function removes.
 *
 * The ORDER is load bearing. Connection strings go first, because
 * `postgresql://libriant:hunter2@db.example.com/x` contains something the
 * e-mail rule would otherwise rewrite into a shape that hides the credential
 * from the rules after it.
 *
 * KNOWN LIMITS, stated rather than papered over:
 *   - A BARE ten-digit Greek mobile (`6941234567`) is not redacted. At that
 *     shape it is indistinguishable from a byte count or a row id, and
 *     redacting every long digit run would gut every useful metric.
 *   - A person's NAME is not redacted and cannot be. There is no regex for
 *     "Μαρία Παπαδοπούλου".
 *   Those two are why the rule at the call site is "never put a person in a
 *   notification" and this function is only the net under it.
 *
 * Kept behaviourally identical to `notify_redact` in scripts/_lib/notify.sh.
 */
export function redactForNotification(input: string): string {
  return (
    input
      // Control characters. The newline survives (a body legitimately has
      // lines); every other one goes, INCLUDING the tab and the carriage
      // return, because a raw character below 0x20 inside a JSON string is
      // invalid JSON — ntfy answers 400 and the notification is lost. They
      // are replaced with a space rather than deleted, so a stripped tab
      // does not run two words together.
      //
      // `no-control-regex` is disabled rather than satisfied: that rule
      // exists to catch a control character that reached a pattern by
      // accident, and here they are the entire subject of the pattern. The
      // mirror of this line is the `tr` in `notify_redact` in
      // scripts/_lib/notify.sh.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000B\u000D-\u001F\u007F]/g, ' ')
      // scheme://user:pass@host — every DATABASE_URL, REDIS_URL, SMTP_URL and
      // rclone remote in .env.prod has this shape. The empty-username form
      // (`redis://:pass@host`) is included; it is the one Redis actually uses.
      .replace(
        /([A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s/@]*(?::[^\s/@]*)?@/g,
        `$1://${NOTIFY_REDACTIONS.credential}@`,
      )
      // JWTs. The session, admin, impersonation and signed-storage-download
      // tokens are all `eyJ…`, and the audit lifted one straight out of a log.
      .replace(
        /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g,
        NOTIFY_REDACTIONS.token,
      )
      // Provider keys with a known prefix.
      .replace(/(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/g, NOTIFY_REDACTIONS.token)
      .replace(/(?:whsec|tk|re)_[A-Za-z0-9_-]{8,}/g, NOTIFY_REDACTIONS.token)
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, NOTIFY_REDACTIONS.token)
      .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, NOTIFY_REDACTIONS.token)
      // NAME=value where NAME smells of a secret. Catches whatever the rules
      // above miss purely because we have not met it yet — the same argument
      // log-redaction.ts makes for preferring an allowlist: a denylist of
      // credential shapes cannot be completed.
      .replace(
        /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|pepper|credential|auth)[A-Za-z0-9_.-]*)\s*[=:]\s*[^\s,;]+/gi,
        `$1=${NOTIFY_REDACTIONS.credential}`,
      )
      // 32+ hex characters. Every secret ensure-env.sh mints is
      // `openssl rand -hex 32`, i.e. 64 of these. Catches a sha256 digest too,
      // which a doorbell has no reason to carry.
      .replace(/[0-9a-fA-F]{32,}/g, NOTIFY_REDACTIONS.hex)
      // 40+ token-ish characters — the general shape of a bearer credential.
      // `/` is excluded so an admin-panel URL, which is the "where to look"
      // half of the notification's whole job, survives intact.
      .replace(/[A-Za-z0-9_+-]{40,}/g, NOTIFY_REDACTIONS.credential)
      // The single most likely personal datum to reach an alert by accident.
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, NOTIFY_REDACTIONS.email)
      // An IP address is personal data — it is why the public application form
      // hashes it with a secret pepper instead of storing it (privacy-legal).
      .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, NOTIFY_REDACTIONS.ip)
      // IPv6 needs 3+ colons so that `14:30:45` in a timestamp is left alone.
      .replace(/(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}/g, NOTIFY_REDACTIONS.ip)
      // +NN international numbers: the applicant's phone, which the public
      // form collects and this channel must never carry.
      .replace(/\+\d[\d\s().-]{6,}\d/g, NOTIFY_REDACTIONS.phone)
  );
}

/** Clip with a marker, so a truncated body never reads as a complete one. */
function clip(text: string, max: number, oneLine = false): string {
  const flat = oneLine ? text.replace(/\s*\n\s*/g, ' ') : text;
  const trimmed = flat.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export type NotifyInput = {
  level: NotifyLevel;
  /** One line. What happened. */
  title: string;
  /** A few lines at most. Where to look. */
  body: string;
  /** Extra ntfy emoji shortcodes, appended after the level's own tag. */
  tags?: string[];
};

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  private readonly server: string;
  private readonly topic: string | null;
  private readonly token: string | null;
  private readonly minPriority: number;
  /** Rolling window for {@link CEILING_MAX}. */
  private windowStartedAt = 0;
  private sentInWindow = 0;
  private suppressed = 0;

  constructor() {
    const env = loadEnv();
    this.server = env.ntfyServer;
    this.topic = env.ntfyTopic;
    this.token = env.ntfyToken;
    this.minPriority = this.priorityOf(env.ntfyMinLevel);

    // At most one line, and only when there is something an operator can act
    // on. A host that never configured ntfy gets `null` here and therefore
    // total silence — which is the "off by default, and everything still
    // works" promise, spelled out in the log's absence.
    if (env.ntfyConfigProblem) {
      this.logger.warn(
        `ntfy: ${env.ntfyConfigProblem}. ` +
          (this.topic
            ? 'Notifications are ON but degraded.'
            : 'Push notifications are OFF; nothing else is affected.'),
      );
    }
  }

  /** True when a usable topic is configured. */
  get enabled(): boolean {
    return this.topic !== null;
  }

  private priorityOf(level: string): number {
    return (NOTIFY_LEVELS[level as NotifyLevel] ?? NOTIFY_LEVELS[FALLBACK_LEVEL]).priority;
  }

  /**
   * Publish one notification. Resolves in every case — a failed send is a
   * logged line and nothing more.
   *
   * NOTE the publish shape, which is not ntfy's headline one
   * (`curl -H "Title: …" https://ntfy.sh/<topic>`). Three reasons, all of them
   * also spelled out in scripts/_lib/notify.sh:
   *
   *   1. The TOPIC is a credential. In the headline form it is a URL path
   *      segment, so it reaches every proxy access log and every error
   *      message. Here it is a field in the JSON body, which none of those
   *      see.
   *   2. The TITLE would be an HTTP header, and header values are ASCII. Most
   *      library names in this product are Greek; ntfy documents RFC 2047
   *      encoding as the workaround. A JSON body is UTF-8 and needs none.
   *   3. A newline in a header value is request splitting. In a JSON string it
   *      is an escaped `\n` and nothing more.
   */
  async send(input: NotifyInput): Promise<void> {
    const topic = this.topic;
    if (topic === null) return;

    const level = (NOTIFY_LEVELS[input.level] ? input.level : FALLBACK_LEVEL) as NotifyLevel;
    const { priority, tag } = NOTIFY_LEVELS[level];
    if (priority < this.minPriority) return;
    if (!this.claimCeilingSlot()) return;

    const payload = {
      topic,
      priority,
      tags: [tag, ...(input.tags ?? [])],
      title: clip(redactForNotification(input.title), MAX_TITLE, true),
      message: clip(redactForNotification(input.body), MAX_BODY),
    };

    try {
      const res = await fetch(`${this.server}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The body is read for the diagnosis, under the SAME AbortSignal — an
        // ntfy that answers its headers and then stalls its body would
        // otherwise hang here past the timeout the headers respected.
        const detail = await res.text().catch(() => '');
        this.logger.warn(
          `ntfy: send rejected with HTTP ${res.status}${
            res.status === 429
              ? ' — rate limited by the server'
              : res.status === 401 || res.status === 403
                ? ' — the topic is protected and NTFY_TOKEN is missing or wrong'
                : ''
          }. Notification dropped; nothing else is affected. ${detail.slice(0, 200)}`,
        );
      }
    } catch (err) {
      // Network error, DNS failure, or our own timeout. The message can quote
      // the error safely: the URL in it is the bare server, because the topic
      // travels in the body — see the note above.
      this.logger.warn(
        `ntfy: send failed (${err instanceof Error ? err.message : String(err)}). ` +
          'Notification dropped; nothing else is affected.',
      );
    }
  }

  /**
   * Fire a notification without waiting for it.
   *
   * For a request path, where the visitor should not wait even the bounded
   * five seconds for a third party. The returned promise is deliberately
   * dropped, which is safe ONLY because {@link send} never rejects — that is
   * the invariant this method depends on, so do not make send throw.
   */
  sendDetached(input: NotifyInput): void {
    void this.send(input);
  }

  /**
   * One slot out of {@link CEILING_MAX} per {@link CEILING_WINDOW_MS}. When
   * the window rolls, the count of what was dropped is logged once — a
   * suppressed notification that is never mentioned anywhere is the same
   * silent failure this whole feature exists to remove.
   */
  private claimCeilingSlot(now: number = Date.now()): boolean {
    if (now - this.windowStartedAt >= CEILING_WINDOW_MS) {
      if (this.suppressed > 0) {
        this.logger.warn(
          `ntfy: ${this.suppressed} notification(s) were dropped by the local ceiling ` +
            `of ${CEILING_MAX} per ${CEILING_WINDOW_MS / 60000} minutes. Something is ` +
            'notifying in a loop; the container log has the full sequence.',
        );
      }
      this.windowStartedAt = now;
      this.sentInWindow = 0;
      this.suppressed = 0;
    }
    if (this.sentInWindow >= CEILING_MAX) {
      this.suppressed++;
      return false;
    }
    this.sentInWindow++;
    return true;
  }
}
