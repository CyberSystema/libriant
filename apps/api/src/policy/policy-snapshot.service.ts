import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { PolicySnapshot } from '@libriant/circ-policy';
import { LRUCache } from 'lru-cache';
import { RedisService } from '../platform/redis.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  loadPolicySnapshot,
  validateSnapshot,
  type LoadedSnapshot,
} from './policy-snapshot.loader.js';

/**
 * The snapshot every checkout resolves against, and the three ways it stays
 * current.
 *
 * §4.1: "caches process-locally, versioned by the trigger-maintained
 * `circulation_policy_version` counter, invalidated over Redis pub/sub with a
 * 30 s TTL backstop, and **never fails open to a default policy**."
 *
 * ## The criterion is two criteria, and they measure different things
 *
 * §6 phase 13 asks for "every pod serves the new snapshot within 1 s (pub/sub)
 * or 30 s (TTL)" AND "resolution p99 < 0.2 ms over a 500-rule snapshot". The
 * second is a property of `resolveCirculationPolicy`, which §4.1 defines as
 * "pure, synchronous, no `Date.now()`" — a pure synchronous function has no
 * round trips to budget. So the version check is OUTSIDE the 0.2 ms budget, and
 * it must be, or the two clauses contradict each other. What this design owes
 * instead is that a checkout pays ZERO I/O in the steady state, which it does.
 *
 * ## Three timescales, and each one bounds a different failure
 *
 * - `freshnessMs` (250 ms) — how long a confirmed version is trusted without
 *   re-asking. This is the backstop for a LOST pub/sub message while Redis is
 *   healthy, and it is why the 1-second criterion is met on a bad day and not
 *   only on a good one. A design whose only fast path has no failure detection
 *   does not meet a latency criterion, it meets it when nothing goes wrong.
 * - `ttlMs` (30 s) — §4.1's stated backstop. Past this we will not serve without
 *   a confirmation from something. It bounds staleness while REDIS is down.
 * - `staleCeilingMs` (15 min) — past this we refuse rather than serve. It bounds
 *   staleness while the TENANT DATABASE is down, and the number is
 *   `SystemModeService`'s `LAST_KNOWN_TENANT_MS` for its reason: it comfortably
 *   outlives the blips it exists for while keeping the worst case short.
 *
 * They are CONSTRUCTOR OPTIONS rather than module constants — the one deliberate
 * departure from `system-mode.service.ts`, whose `CACHE_TTL_SEC` is a module
 * constant and therefore only testable by waiting thirty seconds.
 *
 * ## A stale snapshot is not a default policy
 *
 * This is the distinction the whole fail posture turns on, and it is worth being
 * precise about because "never fails open" reads like "refuse whenever unsure".
 *
 * A DEFAULT POLICY is a value no librarian ever wrote — fourteen days, twenty
 * cents a day, invented by the software. The receipt in the patron's hand then
 * states a rule that is not this library's rule, and nothing in the row
 * distinguishes it from a real resolution. `packages/circ-policy` refuses to
 * export one and a test greps its source to be sure.
 *
 * A STALE SNAPSHOT is a value the library DID write, which was in force at a
 * real identifiable instant. `RuleTrace.snapshotVersion` names which one and
 * `loans.policy_snapshot` freezes it into the row, so a loan priced by version
 * 41 forty seconds after version 42 was published is exactly a loan taken forty
 * seconds earlier. The failure is LATENESS — bounded, observable, attributable,
 * and correctable by phase 21's audited repolicy. The other is FABRICATION, and
 * none of those words applies to it.
 *
 * So there are three postures here, not two, and the third is one no other cache
 * in this repository has: REFUSE.
 *
 * ## No metric, and that is a decision
 *
 * A refusal here stops a desk lending, which is exactly the shape of thing that
 * usually earns a counter. It does not get one in this phase, for the reason
 * `check:check-alerts` enforces in both directions: a `defineMetric` obliges an
 * alert rule or a written exemption, `SOURCES.api.files` would have to widen
 * past `apps/api/src/platform`, and the worker builds snapshots too but serves
 * its own `/metrics` — so a half-wired counter would under-report exactly the
 * critical case while looking like coverage. Every one of the three postures
 * logs instead, at the severity it deserves: a stale serve is a `warn` naming
 * the version and its age, a refusal is an `error` naming the tenant and the
 * cause. Phase 23 owns the multi-branch operations console and is where this
 * belongs with an alert beside it.
 */

export type PolicySnapshotTimings = {
  readonly freshnessMs: number;
  readonly ttlMs: number;
  readonly staleCeilingMs: number;
  readonly maxTenants: number;
};

/**
 * The DI token for an override.
 *
 * Nest resolves constructor parameters positionally and this codebase emits no
 * `design:paramtypes` — `main.ts:65` explains why — so a plain default value on
 * the third parameter is not enough: the container still tries to inject
 * something for it and fails at boot with `UnknownDependenciesException`.
 * `@Optional() @Inject(token)` is the shape `TenantPrismaService` already uses
 * for `TENANT_POOL_ROLE`, and it keeps direct construction (`new
 * PolicySnapshotService(redis, prisma, timings)`) working for the tests that
 * need a second pod with a shorter freshness window.
 */
export const POLICY_SNAPSHOT_TIMINGS = Symbol('POLICY_SNAPSHOT_TIMINGS');

export const DEFAULT_TIMINGS: PolicySnapshotTimings = {
  freshnessMs: 250,
  ttlMs: 30_000,
  staleCeilingMs: 900_000,
  maxTenants: 200,
};

/**
 * The channel carries the `lbr:` namespace LITERALLY.
 *
 * Measured: ioredis applies `keyPrefix` only to arguments the command declares
 * as keys, and `PUBLISH`/`SUBSCRIBE` declare none — so a channel named
 * `policy:bump` would be published and subscribed as `policy:bump`, unprefixed,
 * and would cross-talk with any other Libriant deployment sharing the Redis.
 * (`SPUBLISH`, the sharded form, DOES declare a key and would be prefixed, so
 * reaching for it later would silently desynchronise publisher and subscriber.)
 */
const BUMP_CHANNEL = 'lbr:policy:bump';

/** Goes through `keyPrefix`, so the real key is `lbr:policy:v:<tenantId>`. */
const VERSION_KEY = (tenantId: string) => `policy:v:${tenantId}`;

type Entry = {
  loaded: LoadedSnapshot;
  /** The last moment the version was CONFIRMED against Redis or Postgres. */
  verifiedAt: number;
  /** The last moment a confirmation was ATTEMPTED, successful or not. */
  attemptedAt: number;
};

/** Nothing cached and nothing reachable. A 503, never a default policy. */
export class PolicySnapshotUnavailableError extends Error {
  constructor(
    readonly tenantId: string,
    cause: unknown,
  ) {
    super(
      'The circulation policy for this library could not be loaded, and this process holds no ' +
        'earlier copy of it. Nothing was lent. This is a database problem rather than a ' +
        'configuration one — retry in a moment. ' +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = 'PolicySnapshotUnavailableError';
  }
}

@Injectable()
export class PolicySnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicySnapshotService.name);
  private readonly cache: LRUCache<string, Entry>;
  /** Single-flight: twenty concurrent checkouts on a cold pod issue ONE build. */
  private readonly inFlight = new Map<string, Promise<LoadedSnapshot>>();
  private readonly t: PolicySnapshotTimings;
  private subscribed = false;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Optional() @Inject(POLICY_SNAPSHOT_TIMINGS) timings?: PolicySnapshotTimings,
  ) {
    this.t = timings ?? DEFAULT_TIMINGS;
    this.cache = new LRUCache<string, Entry>({
      max: this.t.maxTenants,
      // No `ttl`: expiry here is a POLICY question (fresh / stale / too stale)
      // that `get()` answers with three different outcomes, and an LRU that
      // silently dropped an entry at 30 s would turn "serve stale and warn" into
      // "refuse", which is the opposite of what a database blip wants.
      ttlAutopurge: false,
      updateAgeOnGet: false,
    });
  }

  /**
   * Subscribe on the SHARED client. No second connection.
   *
   * ioredis 6 defaults to RESP3 (`protocol: 3`), and RESP2's restricted
   * subscriber mode — where a subscribed connection accepts only
   * (P)SUBSCRIBE/PING/QUIT — does not apply. Measured against the running
   * container with the exact options `RedisService` uses: after
   * `subscribe('lbr:policy:bump')`, `GET` returned its value and `PUBLISH`
   * returned its receiver count on the same socket. A dedicated subscriber
   * connection would be two more sockets per process (four across api and
   * worker) bought with a premise that is false for this client.
   */
  async onModuleInit(): Promise<void> {
    try {
      // `enableOfflineQueue: false` makes a command issued while `connecting`
      // reject immediately — the exact reliability-01 failure `ready()` exists
      // for, where a job subscribed on the next tick and silently never did.
      await this.redis.ready(5_000);
      this.redis.client.on('message', (channel: string, payload: string) => {
        if (channel === BUMP_CHANNEL) this.onBump(payload);
      });
      await this.redis.client.subscribe(BUMP_CHANNEL);
      this.subscribed = true;
    } catch (err) {
      // Not fatal, and deliberately so: without the subscription every pod still
      // converges within `ttlMs`, which is §4.1's stated backstop. Refusing to
      // boot because a cache notification channel is unavailable would take the
      // desk down to protect a latency figure.
      this.logger.warn(
        `Could not subscribe to ${BUMP_CHANNEL} (${describe(err)}) — policy changes will ` +
          `propagate on the ${this.t.ttlMs / 1000}s backstop instead of within a second.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscribed) return;
    try {
      await this.redis.client.unsubscribe(BUMP_CHANNEL);
    } catch {
      // The connection is being torn down anyway; RedisService.quit() follows.
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async get(tenant: TenantContext): Promise<PolicySnapshot> {
    return (await this.load(tenant)).snapshot;
  }

  /** The snapshot plus what travels with it. */
  async load(tenant: TenantContext): Promise<LoadedSnapshot> {
    const now = Date.now();
    const entry = this.cache.get(tenant.id);

    // 1. INSIDE THE FRESHNESS WINDOW — the hot path, zero round trips. A desk
    //    doing five checkouts in three seconds pays at most twelve version
    //    checks in the session; a pod running 100 checkouts a second for one
    //    library pays four.
    if (entry !== undefined && now - entry.verifiedAt < this.t.freshnessMs) {
      return entry.loaded;
    }

    // 2. PAST THE WINDOW, INSIDE THE TTL — serve what we hold and re-verify
    //    BEHIND the request, so the checkout never waits on Redis. Convergence
    //    for a lost message is therefore measured at the NEXT call.
    if (entry !== undefined && now - entry.verifiedAt < this.t.ttlMs) {
      if (now - entry.attemptedAt >= this.t.freshnessMs) {
        entry.attemptedAt = now;
        // `.catch` is not optional: `main.ts` and `worker.ts` both install an
        // `unhandledRejection` handler that calls `process.exit(1)`, so a
        // floating rejection here would take the pod down on a database blip —
        // on the very path that exists to survive one.
        void this.refresh(tenant).catch((err: unknown) =>
          this.logger.warn(`Background policy refresh failed (${describe(err)}).`),
        );
      }
      return entry.loaded;
    }

    // 3. PAST THE TTL, OR NOTHING CACHED — confirm before serving.
    return this.refresh(tenant);
  }

  private async refresh(tenant: TenantContext): Promise<LoadedSnapshot> {
    const entry = this.cache.get(tenant.id);
    let mirrored: number | null = null;
    let mirrorRead = false;

    try {
      const raw = await this.redis.client.get(VERSION_KEY(tenant.id));
      mirrored = raw === null ? null : Number(raw);
      mirrorRead = true;
    } catch (err) {
      // A cache we cannot read is a MISS, not an error — the tenant database is
      // the source of truth and is still reachable. The fall-through below
      // widens the check from a 250 ms Redis GET to a 30 s Postgres SELECT
      // deliberately: re-reading Postgres every 250 ms would convert a Redis
      // outage into a database load spike, which is its own incident.
      this.logger.warn(
        `Redis read failed (${describe(err)}) — confirming the policy version from the DB.`,
      );
    }

    if (
      mirrorRead &&
      mirrored !== null &&
      entry !== undefined &&
      mirrored === entry.loaded.snapshot.version
    ) {
      const now = Date.now();
      entry.verifiedAt = now;
      entry.attemptedAt = now;
      return entry.loaded;
    }

    try {
      return await this.build(tenant);
    } catch (err) {
      return this.serveStaleOrRefuse(tenant, entry, err);
    }
  }

  /**
   * One transaction, REPEATABLE READ, single-flighted per tenant.
   *
   * The entry is replaced only once a COMPLETE and VALIDATED snapshot is in
   * hand. The obvious implementation — delete, then rebuild — opens a hole
   * precisely when the database is unhealthy, and there is no negative caching
   * of a failure either, because that would extend a transient blip into a fixed
   * window of refused checkouts. Single-flight is what stops the retry becoming
   * a storm.
   */
  private async build(tenant: TenantContext): Promise<LoadedSnapshot> {
    const existing = this.inFlight.get(tenant.id);
    if (existing !== undefined) return existing;

    const started = process.hrtime.bigint();
    const work = (async () => {
      const client = this.tenantPrisma.getClientV2(tenant);
      const loaded = await client.$transaction((tx) => loadPolicySnapshot(tx), {
        isolationLevel: 'RepeatableRead',
      });
      validateSnapshot(loaded.snapshot);
      const now = Date.now();
      this.cache.set(tenant.id, { loaded, verifiedAt: now, attemptedAt: now });
      // Repair the mirror from the authoritative read. Best effort, and it is
      // the READER doing it rather than only the writer because a pod that has
      // just built version 42 knows something a mirror stuck at 41 does not.
      void this.mirror(tenant.id, loaded.snapshot.version);
      this.logger.debug(
        `Built policy snapshot v${loaded.snapshot.version} for tenant ${tenant.id} in ` +
          `${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)} ms ` +
          `(${loaded.snapshot.rules.length} rule(s)).`,
      );
      return loaded;
    })();

    this.inFlight.set(tenant.id, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(tenant.id);
    }
  }

  /**
   * The one fork between lateness and fabrication.
   *
   * Holding a snapshot: serve it, past the TTL, up to the stale ceiling, and
   * count it. This looks like it earns nothing — a TOTAL database outage means
   * no checkout can be written anyway — but the case it earns its keep in is the
   * PARTIAL one: pool exhaustion, a long lock, a three-second failover, where
   * the write succeeds on retry and only the policy read had bad luck. Refusing
   * there turns a blip into a desk that cannot lend.
   *
   * Holding nothing: refuse. There is no honest alternative, because any policy
   * servable here would have to be invented.
   */
  private serveStaleOrRefuse(
    tenant: TenantContext,
    entry: Entry | undefined,
    cause: unknown,
  ): LoadedSnapshot {
    const age = entry === undefined ? Infinity : Date.now() - entry.verifiedAt;
    if (entry !== undefined && age < this.t.staleCeilingMs) {
      this.logger.warn(
        `Serving policy snapshot version ${entry.loaded.snapshot.version} for tenant ` +
          `${tenant.id}, last confirmed ${Math.round(age / 1000)}s ago — the version could not ` +
          `be re-confirmed (${describe(cause)}). Loans priced now carry that version and can be ` +
          'repriced if it turns out to be superseded.',
      );
      return entry.loaded;
    }
    this.logger.error(
      `Refusing to resolve circulation policy for tenant ${tenant.id}: ${describe(cause)}`,
    );
    throw new PolicySnapshotUnavailableError(tenant.id, cause);
  }

  // -------------------------------------------------------------------------
  // Write side
  // -------------------------------------------------------------------------

  /**
   * Announce a bump. Called AFTER the writing transaction has committed.
   *
   * The ordering is the whole point and getting it wrong is subtle. Publishing
   * INSIDE the transaction is the natural place to put it and is wrong: a
   * subscriber that reacts before the commit reads the PRE-CHANGE rows on its
   * own connection and caches them stamped with the NEW version, at which point
   * every later check agrees with the mirror and the pod serves the old policy
   * under the new number until the TTL — and `RuleTrace.snapshotVersion`, which
   * exists so a receipt can prove which snapshot priced it, is a lie.
   *
   * Publishing after commit trades that for losing the notification if the
   * process dies in between, which is exactly what the 30-second backstop is
   * for. Both writes are best-effort: the policy row is already committed, and a
   * dead Redis must not turn a successful edit into a 500.
   */
  async announce(tenantId: string, version: number): Promise<void> {
    this.applyBump(tenantId, version);
    try {
      await this.mirror(tenantId, version);
      await this.redis.client.publish(BUMP_CHANNEL, `${tenantId}:${version}`);
    } catch (err) {
      this.logger.warn(
        `Could not announce policy version ${version} for tenant ${tenantId} ` +
          `(${describe(err)}). Other processes will pick it up within ` +
          `${this.t.ttlMs / 1000}s on the backstop.`,
      );
    }
  }

  private async mirror(tenantId: string, version: number): Promise<void> {
    await this.redis.client.set(
      VERSION_KEY(tenantId),
      String(version),
      'EX',
      Math.ceil(this.t.staleCeilingMs / 1000),
    );
  }

  private onBump(payload: string): void {
    const sep = payload.lastIndexOf(':');
    if (sep <= 0) return;
    const tenantId = payload.slice(0, sep);
    const version = Number(payload.slice(sep + 1));
    if (!Number.isInteger(version)) return;
    this.applyBump(tenantId, version);
  }

  /**
   * Mark the cached entry stale if the announced version is newer.
   *
   * It EXPIRES rather than rebuilds. A rebuild here would have every pod in the
   * fleet hit the tenant database within milliseconds of one edit; expiring
   * means the next actual checkout pays for one build, and a library nobody is
   * using pays for none. The entry is dropped rather than marked, so `get()`
   * takes branch 3 and confirms before serving.
   */
  private applyBump(tenantId: string, version: number): void {
    const entry = this.cache.get(tenantId);
    if (entry === undefined) return;
    if (version <= entry.loaded.snapshot.version) return;
    this.cache.delete(tenantId);
  }

  /** Test seam: drop everything this process holds. */
  forget(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
