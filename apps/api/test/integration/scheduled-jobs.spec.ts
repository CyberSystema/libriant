import { afterEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  startScheduledJobs,
  type ScheduledJobsHandle,
} from '../../src/jobs/scheduled-jobs.runner.js';
import type { JobContext, ScheduledJob } from '../../src/jobs/jobs.types.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This spec drives the BullMQ scheduler with stub job handlers and never touches a tenant, ' +
    'a plan or a quota, so it runs the configuration customers actually get.',
);

/**
 * The scheduled-jobs runner drives every cron in the product — member due-soon
 * and overdue notices, session expiry, the lot — and had no test whatsoever.
 * That mattered when BullMQ 6 removed the legacy repeatable-job API
 * (queue.add({repeat}) / getRepeatableJobs / removeRepeatableByKey) and the
 * runner had to move to Job Schedulers: a typecheck proves the new calls exist,
 * not that a job ever fires again.
 *
 * Needs the real Redis the integration project already assumes.
 */
const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

const ctx = { emails: { enqueue: async () => undefined } } as unknown as JobContext;
let handle: ScheduledJobsHandle | undefined;

async function inspect<T>(fn: (q: Queue) => Promise<T>): Promise<T> {
  const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const q = new Queue(QUEUE_NAME, { connection: conn, prefix: QUEUE_PREFIX });
  try {
    return await fn(q);
  } finally {
    await q.close();
    await conn.quit();
  }
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  // Leave no schedulers behind for the next spec file.
  await inspect(async (q) => {
    for (const s of await q.getJobSchedulers()) await q.removeJobScheduler(s.key);
  });
});

describe('scheduled-jobs runner on BullMQ 6 job schedulers', () => {
  it('registers one scheduler per job, and actually fires the handler', async () => {
    let fired = 0;
    const jobs: ScheduledJob[] = [
      {
        name: 'test-tick',
        intervalMs: 300,
        handler: async () => {
          fired++;
          return { message: 'tick' };
        },
      },
    ];
    handle = await startScheduledJobs(jobs, ctx);

    const ids = await inspect(async (q) => (await q.getJobSchedulers()).map((s) => s.key));
    expect(ids).toContain('test-tick');

    // The proof that matters: the migration still produces running work.
    const deadline = Date.now() + 15_000;
    while (fired === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBeGreaterThan(0);

    const results = handle.lastResults();
    expect(results['test-tick']).toMatchObject({ ok: true });
  }, 60_000);

  it('reconciles: a scheduler whose job is gone from the registry is removed', async () => {
    handle = await startScheduledJobs(
      [{ name: 'going-away', intervalMs: 60_000, handler: async () => ({ message: 'x' }) }],
      ctx,
    );
    expect(await inspect(async (q) => (await q.getJobSchedulers()).map((s) => s.key))).toContain(
      'going-away',
    );
    await handle.stop();

    // Boot again with a different registry — the stale one must not survive.
    handle = await startScheduledJobs(
      [{ name: 'still-here', intervalMs: 60_000, handler: async () => ({ message: 'y' }) }],
      ctx,
    );
    const ids = await inspect(async (q) => (await q.getJobSchedulers()).map((s) => s.key));
    expect(ids).toContain('still-here');
    expect(ids).not.toContain('going-away');
  }, 60_000);
});
