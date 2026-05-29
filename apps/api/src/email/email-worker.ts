import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { ConsoleEmailDriver } from './drivers/console-driver.js';
import type { EmailDriver } from './drivers/email-driver.js';
import { SmtpEmailDriver } from './drivers/smtp-driver.js';
import { EMAIL_JOB_NAME, EMAIL_QUEUE_NAME } from './email.service.js';

type JobData = { outboxId: string };

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

  const driver: EmailDriver =
    env.emailDriver === 'smtp' ? new SmtpEmailDriver() : new ConsoleEmailDriver();

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
  // eslint-disable-next-line no-console
  console.log(`[email-worker] started (driver=${driver.name})`);

  return {
    worker,
    inFlight: () => inFlight,
    async stop() {
      await worker.close();
      await connection.quit();
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
      bodyMarkdown: row.bodyMarkdown,
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
