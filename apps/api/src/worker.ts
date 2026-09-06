/**
 * Libriant worker entry point.
 *
 * Hosts every long-running background job the API process can't run inline.
 * WHICH jobs is no longer written here: `queues/consumers.ts` is the single
 * registry, and this file iterates it.
 *
 * That indirection is the point (REL-04). This file used to name its five
 * consumers four separate times — the /healthz map, the /readyz expression,
 * the /metrics gauges and the shutdown Promise.all — and the audit found the
 * readiness expression naming three of them. Two consumers were declared,
 * started, tracked, and simply absent from the one list that decides whether
 * the orchestrator pulls a broken worker out of service. Each list read as
 * complete on its own; only reading all four together showed it.
 *
 * So the lists are gone. `WORKER_CONSUMERS` is iterated to start them, and the
 * three HTTP surfaces are rendered by pure functions in `queues/worker-surface.ts`
 * — which, unlike this file, a unit test can drive.
 *
 * Exposes `/healthz`, `/readyz`, `/metrics` on `WORKER_PORT` so compose /
 * k8s / a LB can probe without BullMQ awareness.
 */
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { loadEnv } from './config/env.js';
import { EmailService } from './email/email.service.js';
import { CENSUS_INTERVAL_MS, refreshOutboxCensus } from './email/outbox-census.js';
import { RedisService } from './platform/redis.service.js';
import {
  describeFleetConnectionPlan,
  describeTenantPoolPlan,
  resolveFleetConnectionPlan,
  resolveTenantPoolPlan,
} from './platform/tenant-pool-budget.js';
import { WORKER_CONSUMERS, type ConsumerDeps } from './queues/consumers.js';
import {
  healthzQueues,
  initialConsumerStates,
  jobResults,
  readiness,
  renderWorkerMetrics,
  type ConsumerState,
} from './queues/worker-surface.js';

const env = loadEnv();
const port = Number(process.env.WORKER_PORT ?? '3002');
const bootedAt = new Date();

let shuttingDown = false;

/**
 * One entry per registered consumer, in registry order. Every surface below
 * reads THIS array — there is no second list to fall out of step with it.
 */
const states: ConsumerState[] = initialConsumerStates();

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/healthz') {
    res.statusCode = shuttingDown ? 503 : 200;
    res.end(
      JSON.stringify({
        status: shuttingDown ? 'shutting_down' : 'ok',
        bootedAt: bootedAt.toISOString(),
        nodeEnv: env.nodeEnv,
        queues: healthzQueues(states),
        scheduledLastResults: jobResults(states),
      }),
    );
    return;
  }
  if (req.url === '/readyz') {
    // Ready when EVERY registered consumer is running AND Redis is live
    // (REL-04 / READYZ-MISSING-WORKERS). `readiness()` reads the same array the
    // starter fills, so a consumer cannot be missing from this check while
    // being present in the process — which is the exact shape of the defect.
    //
    // The Redis ping keeps readiness a LIVENESS signal rather than a boot-time
    // latch: the BullMQ connections use `maxRetriesPerRequest: null`, so a
    // post-boot partition queues commands forever instead of erroring.
    const consumers = readiness(states);
    const handlesUp = !shuttingDown && consumers.ready;
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
            // Named, not counted. An operator reading a 503 needs to know which
            // capability is missing; "not_ready" sends them to the logs.
            down: consumers.down,
          }),
        );
      })
      .catch(() => {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'not_ready', redis: 'down', down: consumers.down }));
      });
    return;
  }
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(
      renderWorkerMetrics({
        states,
        plan: tenantPoolPlan,
        uptimeSeconds: Math.round((Date.now() - bootedAt.getTime()) / 1000),
      }),
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

/**
 * The whole fleet's connection arithmetic, printed by the worker because it is
 * the one process that starts last and can therefore state the total.
 *
 * Logged at WARN when it does not fit: `planFleetConnections` never throws — a
 * capacity misconfiguration must not become an outage — so the only way an
 * operator learns the fleet is over-committed is this line and the assertion in
 * `tenant-pool-budget.spec.ts` that keeps the shipped defaults inside it.
 */
const fleetPlan = resolveFleetConnectionPlan(
  env.tenantClientCacheSize,
  env.tenantDbConnectionLimit,
);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] listening on :${port} (env=${env.nodeEnv})`);
  // eslint-disable-next-line no-console
  console.log(`[worker] ${describeTenantPoolPlan(tenantPoolPlan)}`);
  const fleet = `[worker] ${describeFleetConnectionPlan(fleetPlan)}`;
  if (fleetPlan.problems.length) console.warn(fleet);
  // eslint-disable-next-line no-console
  else console.log(fleet);
});

/**
 * reliability-10: keep the outbox head-count fresh so `/metrics` can answer
 * synchronously. Started here rather than inside startEmailWorker() so the
 * gauges exist even if the BullMQ consumer fails to connect — a worker that
 * cannot reach Redis is EXACTLY when an operator needs to see the backlog
 * growing. `unref` so it never holds the process open during a drain.
 */
void refreshOutboxCensus();
const outboxCensusTimer = setInterval(() => void refreshOutboxCensus(), CENSUS_INTERVAL_MS);
outboxCensusTimer.unref?.();

// Scheduled jobs need an EmailService for outgoing notifications (18a
// session-ended emails). The service uses ioredis for its BullMQ producer +
// reads loadEnv internally, so direct construction works outside Nest's DI
// graph. Shared with the import + maintenance consumers, which take the same
// Redis for their plan lookups and cache busting; BullMQ gets its own socket
// inside each start* function.
const sharedRedis = new RedisService();
const sharedEmails = new EmailService(sharedRedis);
const consumerDeps: ConsumerDeps = { redis: sharedRedis, emails: sharedEmails };

/**
 * Boot every registered consumer alongside the HTTP server.
 *
 * One loop, not five hand-written blocks. If BullMQ fails to connect we keep
 * the HTTP surface alive — so the orchestrator sees readiness flap rather than
 * a silent process — and the consumer stays `null`, which `readiness()` reports
 * by name.
 */
for (const [index, consumer] of WORKER_CONSUMERS.entries()) {
  consumer
    .start(consumerDeps)
    .then((handle) => {
      states[index] = { consumer, handle };
    })
    .catch((err) => {
      // Recorded, not just logged. A null handle alone cannot tell "failed to
      // connect" from "still booting", and /healthz would read `starting` for
      // the rest of the process's life.
      states[index] = { consumer, handle: null, failed: true };
      console.error(
        `[worker] failed to start the ${consumer.name} consumer ` +
          `(${consumer.purpose}): ${(err as Error).message}`,
      );
    });
}

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
  clearInterval(outboxCensusTimer);
  server.close();

  // Race the drain against a hard deadline: whichever resolves first wins. If
  // the deadline trips we exit non-zero so the failure is visible (REL-03).
  let timedOut = false;
  const deadline = wait(SHUTDOWN_DEADLINE_MS).then(() => {
    timedOut = true;
  });

  const drain = (async () => {
    // Stop every registered consumer in parallel so a slow one doesn't extend
    // the overall shutdown deadline. The same array again: a consumer added to
    // the registry is drained on shutdown without anyone remembering to add it
    // here — which is the fourth of the four lists REL-04 was about.
    await Promise.all(
      states.map((s) =>
        s.handle?.stop().catch((err) => {
          console.warn(`[worker] ${s.consumer.name} stop: ${(err as Error).message}`);
        }),
      ),
    );
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
