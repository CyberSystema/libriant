/**
 * Libriant worker entry point.
 *
 * Today this process is intentionally minimal — it exists so the prod
 * topology has a worker container from day one and adding background
 * jobs later is a code change, not an ops change. The plan's deferred
 * jobs that will move here over time:
 *   - 18a:   support-session auto-expiry sweeper, before/after diff writer
 *   - 18b:   upfront announcement delivery materialization at publishAt,
 *            real email outbox driver
 *   - 18c:   system-mode window-boundary side effects (auto-suggest
 *            announcements, notify "we're back" subscribers)
 *   - 11/12: ISBN OpenLibrary refresh cron, fine accrual job
 *   - 16:    Stripe webhook retry sweep
 *
 * BullMQ + ioredis are already in the API dependency tree; spinning up a
 * queue and a processor is a few lines once a job exists.
 *
 * The worker exposes a tiny HTTP server on `WORKER_PORT` for liveness +
 * readiness checks. Compose / k8s / a future LB can hit `/healthz`
 * without needing a BullMQ-aware probe.
 */
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const port = Number(process.env.WORKER_PORT ?? '3002');
const bootedAt = new Date();

let shuttingDown = false;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/healthz') {
    res.statusCode = shuttingDown ? 503 : 200;
    res.end(
      JSON.stringify({
        status: shuttingDown ? 'shutting_down' : 'ok',
        bootedAt: bootedAt.toISOString(),
        nodeEnv: env.nodeEnv,
      }),
    );
    return;
  }
  if (req.url === '/readyz') {
    // Once real BullMQ queues land, the readiness check should round-trip
    // Redis + confirm at least one worker is connected. For now: liveness
    // is the readiness signal.
    res.statusCode = shuttingDown ? 503 : 200;
    res.end(JSON.stringify({ status: shuttingDown ? 'shutting_down' : 'ready' }));
    return;
  }
  if (req.url === '/metrics') {
    // Prometheus text exposition — single counter for now, but the format
    // is the contract so a scraper can keep working as we add metrics.
    const upSec = Math.round((Date.now() - bootedAt.getTime()) / 1000);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(
      [
        '# HELP libriant_worker_uptime_seconds Process uptime in seconds.',
        '# TYPE libriant_worker_uptime_seconds counter',
        `libriant_worker_uptime_seconds ${upSec}`,
        '# HELP libriant_worker_jobs_running Number of jobs currently in-flight.',
        '# TYPE libriant_worker_jobs_running gauge',
        'libriant_worker_jobs_running 0',
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

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[worker] received ${signal}, draining…`);
  server.close();
  // Give in-flight jobs (none yet, but future-proof) a few seconds.
  await wait(2000);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
