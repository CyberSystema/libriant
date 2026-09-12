/**
 * Building {@link ImportEngineV2} outside Nest (2.0 phase 20c).
 *
 * ## The problem this file exists to solve
 *
 * The engine's whole design is "route through the services, not around them" —
 * `BibWriteService.create`, `ItemsService.create`, `PatronsService.create`, so
 * an imported record and a typed one are indistinguishable afterwards. Those
 * are Nest providers. The only production caller of the importer is
 * `import-worker.ts`, which runs in the worker process, and the worker has no
 * Nest container: `worker.ts` is a plain Node entry point iterating
 * `WORKER_CONSUMERS`.
 *
 * So the graph is assembled by hand, exactly as `jobs/hold-expiry.job.ts` and
 * five other sweeps already assemble theirs. It is seven lines because the
 * services are shallow — `TenantPrismaService`, `TenantAuditService`,
 * `TenantClockService` and `BibProjectionService` are the whole closure.
 *
 * ## Why it does NOT construct a TenantPrismaService of its own
 *
 * That is the part worth the file. `resolveTenantPoolPlan('worker', …)` divides
 * the worker's connection share by `WORKER_CONCURRENT_SWEEPS`, and that divisor
 * is 4 because `scheduled-jobs.runner.ts` sets `concurrency: 4` — the number is
 * tied to that runner and to nothing else. The import consumer is a SEPARATE
 * BullMQ worker in the same process. A `TenantPrismaService` held here for the
 * length of a 250,000-row import would be a fifth concurrent instance the
 * budget never counted, which is the same class of mistake performance-06
 * found: a connection ceiling believed rather than computed.
 *
 * The worker already opens exactly what it needs — one client per datamodel,
 * `maxPoolSize: 1`, because the consumer runs at `concurrency: 1` and walks one
 * tenant's rows in order — and disconnects both in its `finally`. So
 * {@link OneTenantPrisma} hands those two clients to the services and caches
 * nothing. Its inherited LRU stays empty, so `onModuleDestroy` has nothing to
 * disconnect and the ownership of the clients stays with the caller that opened
 * them.
 *
 * A subclass rather than a structural stand-in: the services declare
 * `@Inject(TenantPrismaService)` and take the class as their parameter type, so
 * this is the one shape that needs no cast at any of the five call sites.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type { TenantPrismaClient, TenantPrismaClientV2 } from '@libriant/db-tenant';
import { BibProjectionService } from '../../bib/bib-projection.service.js';
import { BibWriteService } from '../../bib/bib-write.service.js';
import { QuotaService } from '../../customization/quota.service.js';
import type { EffectivePlanService } from '../../plans/effective-plan.service.js';
import { ItemStatusService } from '../../items/item-status.service.js';
import { ItemsService } from '../../items/items.service.js';
import { PatronsService } from '../../patrons/patrons.service.js';
import { TenantClockService } from '../../policy/tenant-clock.service.js';
import { TenantAuditService } from '../../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service.js';
import { PolicySnapshotService } from '../../policy/policy-snapshot.service.js';
import { RedisService } from '../../platform/redis.service.js';
import { ImportEngineV2, type EngineV2Context } from './import-engine-v2.js';

/**
 * A `TenantPrismaService` that serves ONE tenant from clients it did not open.
 *
 * Every `getClient`/`getClientV2` on the request path resolves through an LRU
 * keyed by tenant id; here there is one tenant for the life of one import, so
 * the lookup is a constant and the cache would only be a second place for the
 * same two connections to be counted.
 */
class OneTenantPrisma extends TenantPrismaService {
  constructor(
    private readonly v1: TenantPrismaClient,
    private readonly v2: TenantPrismaClientV2,
  ) {
    // `'worker'` for the boot log and the plan it reports. Nothing here spends
    // that plan — see the docblock — but claiming the API's share from inside
    // the worker process would put the wrong number in the one place an
    // operator reads during a connection incident.
    super('worker');
  }

  override getClient(): TenantPrismaClient {
    return this.v1;
  }

  override getClientV2(): TenantPrismaClientV2 {
    return this.v2;
  }
}

/** The engine plus the connections this factory opened for it. */
export type BuiltEngine = {
  readonly engine: ImportEngineV2;
  /** Closes the Redis client and the policy cache. Call it in the caller's `finally`. */
  readonly close: () => Promise<void>;
};

export type ImportEngineV2Wiring = EngineV2Context & {
  readonly kind: ImportEntityKind;
  /** The 1.0 client. Held open by the caller; never written to by this engine. */
  readonly client: TenantPrismaClient;
  /** The 2.0 client every service below reaches the database through. */
  readonly clientV2: TenantPrismaClientV2;
  /** The worker's own plan service, for the `max_books` ceiling (2.0 phase 20g). */
  readonly plans: EffectivePlanService;
};

/**
 * Build the engine and read its per-run state.
 *
 * ASYNC because of `init()`, which phase 20d gave the engine: the run's
 * duplicate-key boundary is read from the database clock before a single row is
 * processed, and a boundary read late is a boundary that matches rows this run
 * wrote. `ImportEngine` initialises the same way for the same reason.
 */
export async function makeImportEngineV2(w: ImportEngineV2Wiring): Promise<BuiltEngine> {
  const tenantPrisma = new OneTenantPrisma(w.client, w.clientV2);
  const audit = new TenantAuditService(tenantPrisma);
  const clock = new TenantClockService();
  const status = new ItemStatusService(tenantPrisma, clock);
  // Phase 20g gave BibWriteService the plan ceiling, so the hand-wired graph
  // grows the service that answers it. The worker already holds one — it is
  // `processImportJob`'s only dependency — so it is passed in rather than built
  // again: a second instance would be a second Redis connection and a second
  // plan cache, disagreeing with the first for a TTL.
  const plans = w.plans;
  const bibs = new BibWriteService(
    tenantPrisma,
    audit,
    new BibProjectionService(),
    new QuotaService(plans),
    plans,
  );
  const items = new ItemsService(tenantPrisma, audit, clock, status);
  const patrons = new PatronsService(tenantPrisma, audit, clock, new QuotaService(plans), plans);
  // Phase 20d: circulation history pins a REAL policy resolution — see
  // `ImportEngineV2.pinnedFor` — so the engine needs the matrix, and the matrix
  // needs Redis. Both belong to this factory, which is why it hands back a
  // `close` rather than leaving two connections to the garbage collector.
  const redis = new RedisService();
  const snapshots = new PolicySnapshotService(redis, tenantPrisma);
  const engine = new ImportEngineV2(
    w.kind,
    {
      tenant: w.tenant,
      actor: w.actor,
      duplicateMode: w.duplicateMode,
      dryRun: w.dryRun,
      orgCode: w.orgCode,
    },
    bibs,
    items,
    patrons,
    tenantPrisma,
    status,
    snapshots,
  );
  await engine.init();
  return {
    engine,
    close: async () => {
      await snapshots.onModuleDestroy().catch(() => undefined);
      await redis.onModuleDestroy().catch(() => undefined);
    },
  };
}
