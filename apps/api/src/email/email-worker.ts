import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { createEmailDriver } from './drivers/create-email-driver.js';
import type { EmailDriver } from './drivers/email-driver.js';
import { EMAIL_JOB_NAME, EMAIL_QUEUE_NAME } from './email.service.js';

type JobData = { outboxId: string };

/** A9-01: how often the cold-start/periodic recovery scan runs. */
const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** A row stuck in `sending` longer than this is assumed orphaned by a crashed
 *  worker and is reset to `pending` so the scan re-enqueues it. */
const SENDING_STUCK_MS = 5 * 60 * 1000;
/** Cap rows re-enqueued per scan pass so a huge backlog can't stall the loop. */
const RECOVERY_BATCH = 1000;

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
 *   4a. Success → `delivered` + providerId + deliveredAt
 *   4b. Failure & attempts < maxAttempts → back to `pending` + lastError
 *   4c. Failure & attempts >= maxAttempts → `dead` + abandonedAt
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

  let inFlight = 0;

  const worker = new Worker<JobData>(
    EMAIL_QUEUE_NAME,
    async (job) => {
      inFlight++;
      try {
        if (job.name !== EMAIL_JOB_NAME) return; // future-proof against new job names
        await processOne(driver, job.data.outboxId);
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
    // eslint-disable-next-line no-console
    console.log(`[email-worker] job ${job.id} delivered`);
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
    },
  };
}

async function processOne(driver: EmailDriver, outboxId: string): Promise<void> {
  const env = loadEnv();
  const row = await controlDb.emailOutbox.findUnique({ where: { id: outboxId } });
  if (!row) {
    console.warn(`[email-worker] outbox row ${outboxId} not found — skipping`);
    return;
  }
  // Idempotency: don't re-send already-delivered rows. BullMQ retries
  // can revive a job after the worker already finished it.
  if (row.status === 'delivered' || row.status === 'dead') {
    return;
  }

  await controlDb.emailOutbox.update({
    where: { id: outboxId },
    data: { status: 'sending', attempts: { increment: 1 } },
  });

  try {
    const { providerId } = await driver.send({
      to: row.toEmail,
      from: row.fromEmail ?? env.emailFrom,
      replyTo: row.replyToEmail ?? env.emailReplyTo,
      subject: row.subject,
      bodyMarkdown: row.bodyMarkdown + BRAND_EMAIL_FOOTER,
      // A9-03: stable key so a provider that supports it (Resend) dedups a
      // retry whose prior send reached the provider before the crash.
      idempotencyKey: row.id,
    });
    await controlDb.emailOutbox.update({
      where: { id: outboxId },
      data: {
        status: 'delivered',
        providerId,
        deliveredAt: new Date(),
        lastError: null,
      },
    });
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
