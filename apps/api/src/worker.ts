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
import {
  makeImportWorkerDeps,
  startImportWorker,
  type ImportWorkerHandle,
} from './import/import-worker.js';
import {
  startMaintenanceWorker,
  type MaintenanceWorkerHandle,
} from './maintenance/maintenance-worker.js';
import { startExportWorker, type ExportWorkerHandle } from './export/export-worker.js';
import { RedisService } from './platform/redis.service.js';
import { describeTenantPoolPlan, resolveTenantPoolPlan } from './platform/tenant-pool-budget.js';
import { SCHEDULED_JOBS } from './jobs/registry.js';
import { startScheduledJobs, type ScheduledJobsHandle } from './jobs/scheduled-jobs.runner.js';

const env = loadEnv();
const port = Number(process.env.WORKER_PORT ?? '3002');
const bootedAt = new Date();

let shuttingDown = false;
let emailWorker: EmailWorkerHandle | null = null;
let scheduledJobs: ScheduledJobsHandle | null = null;
let importWorker: ImportWorkerHandle | null = null;
let maintenanceWorker: MaintenanceWorkerHandle | null = null;
let exportWorker: ExportWorkerHandle | null = null;

const server = createServer((req, res) => {
  // Treat any registered BullMQ worker handle as "running" only when its
  // underlying worker is actually running (not closed/paused). A handle that
  // exists but whose worker died is NOT ready (REL-04).
  const isRunning = (handle: { worker?: { isRunning(): boolean } } | null | undefined): boolean =>
    !!handle && (handle.worker ? handle.worker.isRunning() : true);

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
          import: importWorker ? 'running' : 'starting',
          maintenance: maintenanceWorker ? 'running' : 'starting',
          export: exportWorker ? 'running' : 'starting',
        },
        scheduledLastResults: scheduledJobs?.lastResults() ?? {},
      }),
    );
    return;
  }
  if (req.url === '/readyz') {
    // Ready when ALL FIVE queue consumers are running AND Redis is live
    // (REL-04 / READYZ-MISSING-WORKERS). Previously this omitted the
    // maintenance + export workers and never re-checked Redis, so a post-boot
    // Redis partition or a dead consumer still reported 200 and the
    // orchestrator never pulled the worker. The Redis ping makes readiness a
    // liveness signal, not a boot-time latch.
    const handlesUp =
      !shuttingDown &&
      isRunning(emailWorker) &&
      !!scheduledJobs &&
      isRunning(importWorker) &&
      isRunning(maintenanceWorker) &&
      isRunning(exportWorker);
    // The HTTP handler can't be async, so ping then write the response.
    sharedRedis
      .ping()
      .then((redisOk) => {
        const ready = handlesUp && redisOk;
        res.statusCode = ready ? 200 : 503;
        res.end(
          JSON.stringify({
            status: ready ? 'ready' : shuttingDown ? 'shutting_down' : 'not_ready',
            redis: redisOk ? 'up' : 'down',
          }),
        );
      })
      .catch(() => {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'not_ready', redis: 'down' }));
      });
    return;
  }
  if (req.url === '/metrics') {
    const upSec = Math.round((Date.now() - bootedAt.getTime()) / 1000);
    const emailInFlight = emailWorker?.inFlight() ?? 0;
    const scheduledInFlight = scheduledJobs?.inFlight() ?? 0;
    const importInFlight = importWorker?.inFlight() ?? 0;
    const maintenanceInFlight = maintenanceWorker?.inFlight() ?? 0;
    const exportInFlight = exportWorker?.inFlight() ?? 0;
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
        `libriant_worker_jobs_running{queue="import"} ${importInFlight}`,
        `libriant_worker_jobs_running{queue="maintenance"} ${maintenanceInFlight}`,
        `libriant_worker_jobs_running{queue="export"} ${exportInFlight}`,
        '# HELP libriant_worker_tenant_conn_peak Worst-case tenant DB connections this worker may hold.',
        '# TYPE libriant_worker_tenant_conn_peak gauge',
        `libriant_worker_tenant_conn_peak ${tenantPoolPlan.peakConnections}`,
        '# HELP libriant_worker_tenant_conn_budget Tenant DB connection budget for this worker.',
        '# TYPE libriant_worker_tenant_conn_budget gauge',
        `libriant_worker_tenant_conn_budget ${tenantPoolPlan.budget}`,
        '',
      ].join('\n'),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ statusCode: 404, error: 'NotFound' }));
});

/**
 * The tenant-connection budget this process runs under.
 *
 * performance-06: the four per-tenant sweeps each build their own
 * TenantPrismaService and hold it for the whole run, and they believed a
 * `connection_limit=1` URL parameter kept them to one connection apiece. It did
 * not — that parameter belongs to Prisma's old Rust engine, and the driver
 * adapter ignored it, so the real ceiling was cacheSize x poolMax = 250 against
 * a server with max_connections=200. The plan is computed once here and printed
 * at boot so the number an operator can act on is in the log rather than in a
 * comment; the sweeps get the same plan by constructing their service with the
 * 'worker' role.
 */
const tenantPoolPlan = resolveTenantPoolPlan('worker', env.tenantClientCacheSize);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] listening on :${port} (env=${env.nodeEnv})`);
  // eslint-disable-next-line no-console
  console.log(`[worker] ${describeTenantPoolPlan(tenantPoolPlan)}`);
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
    console.error(`[worker] failed to start scheduled jobs: ${(err as Error).message}`);
  });

// Bulk-import consumer (validate + commit passes). Shares the process's
// Redis for its EffectivePlanService limit lookups; BullMQ gets its own
// socket inside startImportWorker.
startImportWorker(makeImportWorkerDeps(sharedRedis))
  .then((handle) => {
    importWorker = handle;
  })
  .catch((err) => {
    console.error(`[worker] failed to start import worker: ${(err as Error).message}`);
  });

// Operator maintenance consumer (diagnostics / migrate / fix / vacuum). Shares
// the process Redis for cache busting; BullMQ gets its own socket inside.
startMaintenanceWorker({ redis: sharedRedis })
  .then((handle) => {
    maintenanceWorker = handle;
  })
  .catch((err) => {
    console.error(`[worker] failed to start maintenance worker: ${(err as Error).message}`);
  });

// Database-export consumer (csv/json/xlsx/sql → file on the shared storage volume).
startExportWorker()
  .then((handle) => {
    exportWorker = handle;
  })
  .catch((err) => {
    console.error(`[worker] failed to start export worker: ${(err as Error).message}`);
  });

/**
 * Hard ceiling on a graceful drain (REL-03). A wedged in-flight job (e.g. a
 * stuck export reading a slow DB, or a worker that can't reach Redis to ack)
 * must not hold the drain open past this; we force-exit so the orchestrator's
 * `stop_grace_period` doesn't escalate to an uncontrolled SIGKILL mid-write.
 * Kept comfortably under the compose stop_grace_period (60s).
 */
const SHUTDOWN_DEADLINE_MS = 25_000;

async function shutdown(signal: NodeJS.Signals, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[worker] received ${signal}, draining…`);
  server.close();

  // Race the drain against a hard deadline: whichever resolves first wins. If
  // the deadline trips we exit non-zero so the failure is visible (REL-03).
  let timedOut = false;
  const deadline = wait(SHUTDOWN_DEADLINE_MS).then(() => {
    timedOut = true;
  });

  const drain = (async () => {
    // Stop all BullMQ workers in parallel so a slow one doesn't extend the
    // overall shutdown deadline.
    await Promise.all([
      emailWorker?.stop().catch((err) => {
        console.warn(`[worker] email-worker stop: ${(err as Error).message}`);
      }),
      scheduledJobs?.stop().catch((err) => {
        console.warn(`[worker] scheduled-jobs stop: ${(err as Error).message}`);
      }),
      importWorker?.stop().catch((err) => {
        console.warn(`[worker] import-worker stop: ${(err as Error).message}`);
      }),
      maintenanceWorker?.stop().catch((err) => {
        console.warn(`[worker] maintenance-worker stop: ${(err as Error).message}`);
      }),
      exportWorker?.stop().catch((err) => {
        console.warn(`[worker] export-worker stop: ${(err as Error).message}`);
      }),
    ]);
    // Close the standalone Redis connection the scheduled-jobs EmailService
    // borrows (it lives outside Nest's DI graph, so nothing else disconnects it).
    await sharedRedis.onModuleDestroy().catch((err) => {
      console.warn(`[worker] redis close: ${(err as Error).message}`);
    });
  })();

  await Promise.race([drain, deadline]);
  if (timedOut) {
    console.error(`[worker] graceful shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`);
    process.exit(exitCode || 1);
  }
  await wait(1000);
  process.exit(exitCode);
}

// Wrap so Node's listener args (signal name + signal NUMBER) don't leak into
// `exitCode` — a clean signal drain must exit 0.
process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

// WORKER-NO-REJECTION-HANDLER / REL-09: a single floating rejection or uncaught
// exception would otherwise kill the whole worker (every queue at once) with no
// logged cause and bypass the graceful drain. Log loudly so the failure is
// observable, then drain: an unhandledRejection is recoverable enough to attempt
// a clean shutdown(); an uncaughtException leaves the process in an unknown
// state, so we still drain but the deadline guarantees we exit.
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — draining and exiting', reason);
  void shutdown('SIGTERM', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — draining and exiting', err);
  void shutdown('SIGTERM', 1);
});
