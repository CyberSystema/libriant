import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { createEmailDriver } from './drivers/create-email-driver.js';
import type { EmailDriver, SendResult } from './drivers/email-driver.js';
import { EMAIL_JOB_NAME, EMAIL_QUEUE_NAME } from './email.service.js';
import { outboxSecretKey, parseSecretPayload, sealedRef, unsealBody } from './outbox-secrets.js';

type JobData = { outboxId: string };

/** A9-01: how often the cold-start/periodic recovery scan runs. */
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** A row stuck in `sending` longer than this is assumed orphaned by a crashed
 *  worker and is reset to `pending` so the scan re-enqueues it. */
const SENDING_STUCK_MS = 5 * 60 * 1000;
/** Cap rows re-enqueued per scan pass so a huge backlog can't stall the loop. */
const RECOVERY_BATCH = 1000;

/**
 * privacy-legal-06, second half. Sealing (outbox-secrets.ts) takes the bearer
 * credentials out of `bodyMarkdown`; it does not make the column harmless.
 * What is left is still a permanent archive of every transactional message
 * Libriant has ever composed — member names, borrowed titles, contact details —
 * inside `pg_dumpall`, inside every nightly backup, and inside any admin
 * control export, with nothing that ever deletes a row.
 *
 * So terminal rows lose their body after this window. 90 days is chosen to
 * outlast the questions the body actually answers ("what did we send that
 * member in March?", "did the overdue notice go out?") while keeping the
 * archive from growing without limit. The ENVELOPE (to / subject / kind /
 * status / timestamps) is kept forever: it is what the outbox stats and the
 * admin viewer are for, and it is far less sensitive than the prose.
 *
 * Only TERMINAL rows are swept — `delivered`, `dead` and (privacy-legal-18)
 * `failed`. A `pending`/`sending` row still owes someone an email and its body
 * is the message.
 *
 * `failed` is in that list because of the interlock between the two findings:
 * privacy-legal-18 makes every console-driver message terminate as `failed`
 * instead of `delivered`, and on the shipped configuration that is EVERY
 * message. Leaving `failed` out would have quietly turned this sweep off — the
 * bodies it exists to remove (member names, borrowed titles) would have sat in
 * the shared control plane forever, with the retention fix still reading as
 * present in the diff.
 */
const BODY_RETENTION_DAYS = 90;
/**
 * Statuses that will never be sent again, so their body has no reader left.
 * Shared by the retention sweep and the no-double-send guard in `processOne`
 * so the two can never disagree about what "finished" means.
 */
const TERMINAL_STATUSES = ['delivered', 'dead', 'failed'] as const;
const BODY_REDACTED_MARKER = `[body removed after ${BODY_RETENTION_DAYS} days — outbox retention]`;
/** Cap per pass so the first sweep on a long-lived install can't stall the loop. */
const RETENTION_BATCH = 5000;

/**
 * Appended to every outgoing email so recipients always see the parent brand.
 * Libriant is a CyberSystema product. Added at send time (not persisted), so
 * the stored outbox body stays clean.
 */
const BRAND_EMAIL_FOOTER = '\n\n---\n\nPowered by **CyberSystema** — https://cybersystema.com';

/**
 * Worker-side consumer. Boots a single BullMQ worker that drains the
 * `email-outbox` queue using whatever driver `EMAIL_DRIVER` resolves to.
 * Lives in its own module (not via Nest DI) because the worker runs as a
 * separate process — bringing up Nest just to grab two services would
 * double the cold-start time on every redeploy.
 *
 * Lifecycle:
 *   start()  — open Redis + Worker, return the disposer
 *   stop()   — close gracefully (wait for in-flight, then end Redis)
 *
 * Per-job flow (see `processOne`):
 *   1. Load outbox row + assert it's `pending` (no double-send)
 *   2. Flip to `sending`, increment `attempts`
 *   3. Call driver.send
 *   4a. Sent → `delivered` + providerId + deliveredAt
 *   4b. Returned, but the driver says it sent nothing (privacy-legal-18:
 *       `EMAIL_DRIVER=console`) → `failed` + failedAt + lastError, no
 *       deliveredAt and no provider id. Terminal; nothing retries it.
 *   4c. Threw & attempts < maxAttempts → back to `pending` + lastError
 *   4d. Threw & attempts >= maxAttempts → `dead` + abandonedAt
 *
 * On step 4b we let BullMQ's exponential backoff queue the retry — the
 * row going back to `pending` is just so a cold-start recovery scan can
 * see it as "still owed."
 */

export type EmailWorkerHandle = {
  worker: Worker;
  /** Counter the worker process exposes via /metrics for ops. */
  inFlight(): number;
  stop(): Promise<void>;
};

export async function startEmailWorker(): Promise<EmailWorkerHandle> {
  const env = loadEnv();
  // Dedicated Redis connection — BullMQ documentation insists on it for
  // workers (separate from any sharing the API does for caching).
  // BullMQ insists on its own `prefix` option for queue keys (it manages
  // a small key hierarchy that needs to be addressable as a hash tag in
  // cluster mode). Don't pass ioredis' `keyPrefix` — that breaks LUA
  // script ownership detection in BullMQ. The shared prefix used elsewhere
  // in the app for app-state keys is set on the BullMQ side via
  // `prefix: '{lbr-bull}'` below.
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const driver: EmailDriver = createEmailDriver();

  // privacy-legal-06: the sealed halves of each body live in Redis under the
  // app-level `lbr:` key prefix that RedisService applies. Constructing the
  // real RedisService (rather than another bare ioredis like `connection`
  // above) is what guarantees the prefix can never drift apart from the one
  // EmailService writes with — a mismatch would silently turn every reset link
  // into "[link expired]". It is a plain class with a no-arg constructor, so it
  // works outside Nest DI, which is why this worker runs as its own process.
  const secretsRedis = new RedisService();
  await secretsRedis.ready().catch((err: Error) => {
    console.error(`[email-worker] secret store not ready: ${err.message}`);
  });

  let inFlight = 0;

  const worker = new Worker<JobData>(
    EMAIL_QUEUE_NAME,
    async (job) => {
      inFlight++;
      try {
        if (job.name !== EMAIL_JOB_NAME) return; // future-proof against new job names
        await processOne(driver, job.data.outboxId, secretsRedis);
      } finally {
        inFlight--;
      }
    },
    { connection, concurrency: 5, prefix: 'lbr-bull' },
  );

  worker.on('failed', (job, err) => {
    console.error(`[email-worker] job ${job?.id} failed: ${err.message}`);
  });
  worker.on('completed', (job) => {
    // "processed", not "delivered": privacy-legal-18. A job completes when
    // `processOne` returns, which it also does for a message the driver
    // refused to send. The row's own status is the answer to "did it go out?".
    // eslint-disable-next-line no-console
    console.log(`[email-worker] job ${job.id} processed`);
  });

  // A9-01: durable-outbox recovery. The outbox is the source of truth, but a
  // Redis hiccup during enqueue, or a worker crash mid-flight, can leave a row
  // `pending`/`sending` with NO live BullMQ job — stranded forever (password
  // resets, hold-ready, overdue notices silently lost, no alarm). On boot and
  // on a timer we (a) reset `sending` rows orphaned by a crash back to `pending`
  // and (b) re-enqueue every owed row. `jobId = row.id` dedups against any live
  // job, so a row that IS actively being processed is a no-op — no double-send.
  const recoveryConnection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const recoveryQueue = new Queue(EMAIL_QUEUE_NAME, {
    connection: recoveryConnection,
    prefix: 'lbr-bull',
  });

  async function runRecovery(): Promise<void> {
    try {
      const stuckCutoff = new Date(Date.now() - SENDING_STUCK_MS);
      const reset = await controlDb.emailOutbox.updateMany({
        where: { status: 'sending', updatedAt: { lt: stuckCutoff } },
        data: { status: 'pending' },
      });
      const owed = await controlDb.emailOutbox.findMany({
        where: { status: 'pending', scheduledFor: { lte: new Date() } },
        select: { id: true },
        orderBy: { scheduledFor: 'asc' },
        take: RECOVERY_BATCH,
      });
      let requeued = 0;
      for (const row of owed) {
        const added = await recoveryQueue
          .add(EMAIL_JOB_NAME, { outboxId: row.id }, { jobId: row.id })
          .catch(() => null);
        if (added) requeued++;
      }
      if (reset.count > 0 || requeued > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[email-worker] recovery: reset ${reset.count} stuck 'sending', re-enqueued ${requeued} owed`,
        );
      }
    } catch (err) {
      console.error(`[email-worker] recovery scan failed: ${(err as Error).message}`);
    }
    await sweepExpiredBodies();
  }

  /**
   * privacy-legal-06: drop the body of terminal rows past
   * {@link BODY_RETENTION_DAYS}. It rides on the recovery timer because that is
   * the only periodic loop this process already owns — a `jobs/` cron would put
   * the retention of email content in a different module from the code that
   * writes it, which is how the outbox ended up with no purge job in the first
   * place.
   */
  async function sweepExpiredBodies(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      // Two steps rather than a bare updateMany: Prisma has no LIMIT on
      // updateMany, and the FIRST sweep on an install that has been running for
      // a year would otherwise be one unbounded UPDATE.
      const stale = await controlDb.emailOutbox.findMany({
        where: {
          status: { in: [...TERMINAL_STATUSES] },
          createdAt: { lt: cutoff },
          NOT: { bodyMarkdown: BODY_REDACTED_MARKER },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: RETENTION_BATCH,
      });
      if (stale.length === 0) return;
      const cleared = await controlDb.emailOutbox.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { bodyMarkdown: BODY_REDACTED_MARKER },
      });
      // eslint-disable-next-line no-console
      console.log(
        `[email-worker] retention: cleared ${cleared.count} outbox bodies older than ${BODY_RETENTION_DAYS}d`,
      );
    } catch (err) {
      console.error(`[email-worker] retention sweep failed: ${(err as Error).message}`);
    }
  }

  // Kick off a boot scan (don't block startup on it) + a periodic timer.
  void runRecovery();
  const recoveryTimer = setInterval(() => void runRecovery(), RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();

  // eslint-disable-next-line no-console
  console.log(`[email-worker] started (driver=${driver.name})`);

  return {
    worker,
    inFlight: () => inFlight,
    async stop() {
      clearInterval(recoveryTimer);
      await worker.close();
      await recoveryQueue.close();
      await connection.quit();
      await recoveryConnection.quit();
      await secretsRedis.onModuleDestroy();
    },
  };
}

async function processOne(
  driver: EmailDriver,
  outboxId: string,
  secretsRedis: RedisService,
): Promise<void> {
  const env = loadEnv();
  const row = await controlDb.emailOutbox.findUnique({ where: { id: outboxId } });
  if (!row) {
    console.warn(`[email-worker] outbox row ${outboxId} not found — skipping`);
    return;
  }
  // Idempotency: don't re-process a row that is already finished. BullMQ
  // retries can revive a job after the worker already handled it. `failed`
  // (privacy-legal-18) belongs here for the same reason `dead` does: nothing
  // retries it, so re-entering would only re-log and re-stamp it. A row put
  // back in play by hand — the re-drive SQL in the alert annotations — is set
  // to `pending`, which is not in this list and is picked up normally.
  if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
    return;
  }

  // privacy-legal-06: put the bearer credentials back, from Redis, in memory,
  // for the duration of this send only.
  const sendable = await rehydrate(row.bodyMarkdown, secretsRedis);
  if (sendable === null) {
    // The sealed value outlived its TTL while this row was still owed. The
    // underlying reset/verify token is expired too (its TTL is shorter), so
    // retrying cannot help and sending a URL with a dead token in it is worse
    // than sending nothing: the recipient gets a link that fails, and support
    // gets a ticket. Abandon loudly instead.
    await controlDb.emailOutbox.update({
      where: { id: outboxId },
      data: {
        status: 'dead',
        failedAt: new Date(),
        abandonedAt: new Date(),
        lastError:
          'the one-time link in this message expired before it could be delivered — ' +
          'ask the recipient to request a new one',
      },
    });
    console.warn(`[email-worker] outbox row ${outboxId} abandoned: sealed link expired`);
    return;
  }

  await controlDb.emailOutbox.update({
    where: { id: outboxId },
    data: { status: 'sending', attempts: { increment: 1 } },
  });

  try {
    const result = await driver.send({
      to: row.toEmail,
      from: row.fromEmail ?? env.emailFrom,
      replyTo: row.replyToEmail ?? env.emailReplyTo,
      subject: row.subject,
      bodyMarkdown: sendable + BRAND_EMAIL_FOOTER,
      // A9-03: stable key so a provider that supports it (Resend) dedups a
      // retry whose prior send reached the provider before the crash.
      idempotencyKey: row.id,
    });
    await controlDb.emailOutbox.update({
      where: { id: outboxId },
      data: sendOutcome(result, new Date()),
    });
    if (!result.delivered) {
      console.warn(`[email-worker] outbox row ${outboxId} not sent: ${result.notDeliveredReason}`);
    }
  } catch (err) {
    const reason = (err as Error).message;
    // Pull the latest row to read the now-incremented attempts count.
    const post = await controlDb.emailOutbox.findUnique({
      where: { id: outboxId },
      select: { attempts: true, maxAttempts: true },
    });
    const exhausted = (post?.attempts ?? row.maxAttempts) >= (post?.maxAttempts ?? row.maxAttempts);
    await controlDb.emailOutbox.update({
      where: { id: outboxId },
      data: exhausted
        ? { status: 'dead', failedAt: new Date(), abandonedAt: new Date(), lastError: reason }
        : { status: 'pending', failedAt: new Date(), lastError: reason },
    });
    // Re-throw so BullMQ records the failure and applies backoff.
    throw err;
  }
}

/**
 * Turn what the driver reported into the row the outbox will keep
 * (privacy-legal-18).
 *
 * The old code wrote `status: 'delivered', deliveredAt: now` the moment
 * `driver.send` returned without throwing. The console driver — the driver the
 * product SHIPS with, because there is no mail provider yet — never throws and
 * never sends, so every stored notice claimed to have been delivered. That is
 * not a cosmetic inaccuracy: a librarian looking at `/admin/emails`, or
 * answering a member who says "nobody told me it was overdue", or assembling
 * an Art. 5(2) accountability file, was reading a row asserting a delivery
 * that never happened.
 *
 * `failed`, not `dead`, for an undelivered message. `dead` means "we tried
 * `maxAttempts` times and gave up", which is what `LibriantEmailOutboxDeadLetters`
 * (infra/monitoring/alerts.yml) pages a human about and offers re-drive SQL for
 * — and on the shipped console configuration that alert would fire on every
 * single message, forever, with a re-drive that can only produce another
 * undelivered row. Alert fatigue on the one rule that means "a real password
 * reset was abandoned" is a worse outcome than the finding. `failed` was
 * documented in outbox-census.ts as an unreachable enum member; this is the
 * writer it never had. The signal that mail is not being delivered stays where
 * it belongs, at boot, in create-email-driver.ts's banner.
 *
 * Exported for `email-worker.spec.ts`, which drives a REAL driver instance
 * through this function rather than a hand-built result object.
 */
export type OutboxSendOutcome = {
  status: 'delivered' | 'failed';
  providerId: string | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
};

export function sendOutcome(result: SendResult, at: Date): OutboxSendOutcome {
  if (result.delivered) {
    return {
      status: 'delivered',
      providerId: result.providerId,
      deliveredAt: at,
      failedAt: null,
      lastError: null,
    };
  }
  return {
    status: 'failed',
    // Never a provider id on a message no provider ever saw.
    providerId: null,
    deliveredAt: null,
    failedAt: at,
    // A driver that reports `delivered: false` without a reason still has to
    // leave the operator something readable next to the row.
    lastError:
      result.notDeliveredReason ??
      'the email driver reported this message as not delivered, and gave no reason',
  };
}

/**
 * Re-hydrate a stored body for delivery. Returns the sendable body, or `null`
 * when the message carried a sealed credential whose value is gone — the
 * caller abandons the row rather than deliver a broken link.
 *
 * A body with no sealed credential (the overwhelming majority: announcements,
 * overdue notices, welcome mail) short-circuits without touching Redis, so a
 * Redis outage cannot stop ordinary mail. A Redis outage DOES stop a reset
 * link — correctly, since the token it points at lives in the same Redis.
 */
async function rehydrate(storedBody: string, secretsRedis: RedisService): Promise<string | null> {
  const ref = sealedRef(storedBody);
  if (!ref) return storedBody;
  const raw = await secretsRedis.client.get(outboxSecretKey(ref)).catch((err: Error) => {
    console.error(`[email-worker] secret fetch failed for ref=${ref}: ${err.message}`);
    return null;
  });
  const { body, missing } = unsealBody(storedBody, parseSecretPayload(raw));
  return missing > 0 ? null : body;
}
