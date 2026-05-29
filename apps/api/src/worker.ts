/**
 * Libriant worker entry point.
 *
 * Hosts every long-running background job the API process can't run
 * inline. Today (after Step 18g):
 *   - email-outbox queue consumer (18d) — drains EmailOutbox rows
 *   - scheduled-jobs queue (18g) — runs the cron-style background jobs
 *     registered in `jobs/registry.ts`: support-session expiry sweeper,
 *     reservation pickup-expiry sweeper, Stripe webhook retry sweep.
 *
 * Still TODO, will land alongside future steps:
 *   - 18a: before/after diff writer (needs Prisma middleware)
 *   - 18b: upfront announcement delivery materialization at publishAt
 *   - 18c: window-boundary side effects (auto-suggest pre-window
 *          announcement, notify "we're back" subscribers)
 *   - 11/12: ISBN OpenLibrary refresh cron, fine accrual job
 *
 * Exposes `/healthz`, `/readyz`, `/metrics` on `WORKER_PORT` so compose /
 * k8s / a LB can probe without BullMQ awareness.
 */
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { loadEnv } from './config/env.js';
import { startEmailWorker, type EmailWorkerHandle } from './email/email-worker.js';
import { EmailService } from './email/email.service.js';
import { RedisService } from './platform/redis.service.js';
import { SCHEDULED_JOBS } from './jobs/registry.js';
import { startScheduledJobs, type ScheduledJobsHandle } from './jobs/scheduled-jobs.runner.js';

const env = loadEnv();
const port = Number(process.env.WORKER_PORT ?? '3002');
const bootedAt = new Date();

let shuttingDown = false;
let emailWorker: EmailWorkerHandle | null = null;
let scheduledJobs: ScheduledJobsHandle | null = null;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/healthz') {
    res.statusCode = shuttingDown ? 503 : 200;
    res.end(
      JSON.stringify({
        status: shuttingDown ? 'shutting_down' : 'ok',
        bootedAt: bootedAt.toISOString(),
        nodeEnv: env.nodeEnv,
        queues: {
          'email-outbox': emailWorker ? 'running' : 'starting',
          scheduled: scheduledJobs ? 'running' : 'starting',
        },
        scheduledLastResults: scheduledJobs?.lastResults() ?? {},
      }),
    );
    return;
  }
  if (req.url === '/readyz') {
    // Ready when both BullMQ workers are connected to Redis. If either
    // isn't, the orchestrator should pull traffic — jobs are silently
    // not being drained.
    const ready = !shuttingDown && !!emailWorker && !!scheduledJobs;
    res.statusCode = ready ? 200 : 503;
    res.end(
      JSON.stringify({
        status: ready ? 'ready' : shuttingDown ? 'shutting_down' : 'not_ready',
      }),
    );
    return;
  }
  if (req.url === '/metrics') {
    const upSec = Math.round((Date.now() - bootedAt.getTime()) / 1000);
    const emailInFlight = emailWorker?.inFlight() ?? 0;
    const scheduledInFlight = scheduledJobs?.inFlight() ?? 0;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(
      [
        '# HELP libriant_worker_uptime_seconds Process uptime in seconds.',
        '# TYPE libriant_worker_uptime_seconds counter',
        `libriant_worker_uptime_seconds ${upSec}`,
        '# HELP libriant_worker_jobs_running Number of jobs currently in-flight.',
        '# TYPE libriant_worker_jobs_running gauge',
        `libriant_worker_jobs_running{queue="email-outbox"} ${emailInFlight}`,
        `libriant_worker_jobs_running{queue="scheduled"} ${scheduledInFlight}`,
        '',
      ].join('\n'),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ statusCode: 404, error: 'NotFound' }));
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] listening on :${port} (env=${env.nodeEnv})`);
});

// Boot the queue consumers alongside the HTTP server. If BullMQ fails to
// connect we keep the HTTP surface alive (so the orchestrator sees the
// readiness flap) but every send becomes a retry — fail-loud beats
// fail-silent.
startEmailWorker()
  .then((handle) => {
    emailWorker = handle;
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] failed to start email worker: ${(err as Error).message}`);
  });

// Scheduled jobs need an EmailService for outgoing notifications (18a
// session-ended emails). The service uses ioredis for its BullMQ
// producer + reads loadEnv internally, so direct construction works
// outside Nest's DI graph.
const sharedRedis = new RedisService();
const sharedEmails = new EmailService(sharedRedis);
startScheduledJobs(SCHEDULED_JOBS, { emails: sharedEmails })
  .then((handle) => {
    scheduledJobs = handle;
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] failed to start scheduled jobs: ${(err as Error).message}`);
  });

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[worker] received ${signal}, draining…`);
  server.close();
  // Stop both BullMQ workers in parallel so a slow one doesn't extend the
  // overall shutdown deadline.
  await Promise.all([
    emailWorker?.stop().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[worker] email-worker stop: ${(err as Error).message}`);
    }),
    scheduledJobs?.stop().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[worker] scheduled-jobs stop: ${(err as Error).message}`);
    }),
  ]);
  await wait(1000);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
