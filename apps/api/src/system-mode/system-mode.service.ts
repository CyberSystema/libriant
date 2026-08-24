import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  controlDb,
  type Prisma,
  type SystemModeEvent,
  type SystemModeKind,
} from '@libriant/db-control';
import { FailOpenMemo, RedisService } from '../platform/redis.service.js';
import { NORMAL_MODE, pickStricter, type ResolvedSystemMode } from './system-mode.types.js';

type OpenInput = {
  mode: SystemModeKind;
  messageMarkdown: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allowAdminBypass: boolean;
  createdByAdminId: string;
};

/**
 * Per the plan: "refreshed every 30s; invalidated on admin write." The
 * short TTL caps how long a stale resolution can survive if the busting
 * code path ever drops a key (it's belt-and-braces on the bust call).
 */
const CACHE_TTL_SEC = 30;
const KEY_GLOBAL = 'system_mode:global';
const KEY_TENANT = (tenantId: string) => `system_mode:tenant:${tenantId}`;

/**
 * How long a resolution Redis refused to store survives in-process. Only ever
 * consulted while Redis is erroring (BOOT-01), so this is the extra staleness
 * an operator's `bust()` can see during an outage — on top of the 30 s TTL
 * that already exists for exactly that reason.
 */
const DEGRADED_MEMO_MS = 5_000;

/**
 * How long a *successfully* resolved tenant mode is remembered in-process as
 * the fallback for `resolveTenantSafe()`.
 *
 * This is the per-tenant twin of `lastKnownGlobal`, and it is bounded where
 * that one is not: there is exactly one global mode, but a tenant map with no
 * expiry grows with the customer count. 15 minutes comfortably outlives the
 * control-DB blips this exists for while keeping the worst case (a window that
 * was ended during a long outage) short. FailOpenMemo's 500-entry ceiling is
 * the second bound — overflow just costs a re-resolve.
 */
const LAST_KNOWN_TENANT_MS = 15 * 60_000;

/**
 * CRUD + resolution for the system-mode subsystem. Resolution is
 * **read-time**: we never run a scheduler that flips the row at
 * `startsAt`. Instead, the active query is
 * `endedAt IS NULL AND startsAt <= now AND (endsAt IS NULL OR endsAt > now)`.
 * That removes the only race (worker dies → mode never flips) and lets
 * us declare windows hours/days/weeks in advance with zero infra.
 */
@Injectable()
export class SystemModeService {
  private readonly logger = new Logger(SystemModeService.name);
  /** Populated only when Redis I/O throws — see FailOpenMemo. */
  private readonly degraded = new FailOpenMemo<ResolvedSystemMode>(DEGRADED_MEMO_MS);
  /**
   * Last global mode we successfully resolved, with no expiry. The floor for
   * `resolveGlobalSafe()` when Redis *and* the control DB are both unreachable:
   * falling straight back to `normal` there would flip the takeover page off
   * mid-maintenance, which is the opposite of what the operator asked for.
   */
  private lastKnownGlobal: ResolvedSystemMode | null = null;
  /**
   * Same idea, per tenant. Populated on every successful tenant resolution —
   * cache hit included — so `resolveTenantSafe()` can keep reporting an open
   * tenant window when the control DB goes away mid-maintenance.
   */
  private readonly lastKnownTenant = new FailOpenMemo<ResolvedSystemMode>(LAST_KNOWN_TENANT_MS);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  // ---------- resolution -------------------------------------------------

  async resolveGlobal(): Promise<ResolvedSystemMode> {
    const cached = await this.readCache(KEY_GLOBAL);
    if (cached) {
      // Remember it HERE too, not only on the miss path below. In a
      // multi-process deployment (api + worker, or several api replicas) one
      // process refreshes the 30 s key and the others only ever see hits, so a
      // fallback assigned solely after a DB read was never assigned at all in
      // those processes — their `resolveGlobalSafe()` degraded to whatever
      // they happened to resolve at boot, or to `normal`. Every path that
      // yields a mode we believe now updates the floor.
      this.lastKnownGlobal = cached;
      return cached;
    }
    const row = await controlDb.systemModeEvent.findFirst({
      where: this.activeWhere({ scope: 'global' }),
      orderBy: { startsAt: 'desc' },
    });
    const resolved = row ? this.eventToResolved(row, 'global') : NORMAL_MODE;
    await this.writeCache(KEY_GLOBAL, resolved);
    this.lastKnownGlobal = resolved;
    return resolved;
  }

  /**
   * Never-throws variant, for callers that must survive a dead dependency —
   * today the middleware's ALWAYS_PASS branch.
   *
   * BOOT-01: `SystemModeMiddleware` is mounted on `*`, and its bypass branch
   * (the one that keeps /healthz, /readyz and the /admin/system-mode recovery
   * lever reachable) resolved the mode before calling next(). With Redis
   * unreachable that GET rejected, the middleware rejected, and the global
   * filter turned a routine `docker restart redis` into a 500 on every path —
   * including the lever an operator needs to recover. The cache reads below
   * now fail open to the control DB; this catches the remaining case where the
   * DB is down too, so the bypass branch cannot throw at all.
   */
  async resolveGlobalSafe(): Promise<ResolvedSystemMode> {
    try {
      return await this.resolveGlobal();
    } catch (err) {
      this.logger.error(
        `Could not resolve the global system mode (${describeFailure(err)}) — serving ` +
          `${this.lastKnownGlobal ? 'the last known mode' : "'normal'"} so probes and ` +
          `/admin/system-mode stay reachable.`,
      );
      return this.lastKnownGlobal ?? NORMAL_MODE;
    }
  }

  async resolveTenant(tenantId: string): Promise<ResolvedSystemMode> {
    const cached = await this.readCache(KEY_TENANT(tenantId));
    if (cached) {
      this.lastKnownTenant.set(tenantId, cached);
      return cached;
    }
    const row = await controlDb.systemModeEvent.findFirst({
      where: this.activeWhere({ scope: 'tenant', tenantId }),
      orderBy: { startsAt: 'desc' },
    });
    const resolved = row ? this.eventToResolved(row, 'tenant') : NORMAL_MODE;
    await this.writeCache(KEY_TENANT(tenantId), resolved);
    this.lastKnownTenant.set(tenantId, resolved);
    return resolved;
  }

  /**
   * Never-throws variant of {@link resolveTenant}. Returns `null` — NOT
   * `normal` — when the tenant dimension genuinely cannot be determined, so
   * the caller has to decide what an unknown means rather than being handed a
   * clean bill of health it did not earn.
   */
  async resolveTenantSafe(tenantId: string): Promise<ResolvedSystemMode | null> {
    try {
      return await this.resolveTenant(tenantId);
    } catch (err) {
      // The cache layer already fails open to the DB, so the only way to get
      // here is the control DB itself being unreachable.
      const last = this.lastKnownTenant.get(tenantId);
      this.logger.error(
        `Could not resolve the tenant system mode for ${tenantId} ` +
          `(${describeFailure(err)}) — ` +
          (last ? 'serving the last known tenant mode.' : 'no last known mode to fall back on.'),
      );
      return last;
    }
  }

  /**
   * Effective mode for a request: max-severity of global and per-tenant
   * events. When no tenant is supplied (e.g. /admin/*), only global is
   * consulted.
   */
  async resolveEffective(input: { tenantId?: string }): Promise<ResolvedSystemMode> {
    const global = await this.resolveGlobal();
    if (!input.tenantId) return global;
    const tenant = await this.resolveTenant(input.tenantId);
    return pickStricter(global, tenant);
  }

  /**
   * Never-throws {@link resolveEffective}, for the endpoint the web app polls.
   *
   * The call site used to be
   * `resolveEffective({tenantId}).catch(() => resolveGlobalSafe())`, which
   * pointed the wrong way: `resolveEffective` resolves global THEN tenant, so a
   * control-DB error on the tenant leg discarded the tenant dimension entirely
   * and answered with the global mode. A library sitting in a tenant-scoped
   * maintenance window therefore reported `normal`, and the web app rendered
   * the ordinary app instead of the takeover page — the one thing this endpoint
   * exists to prevent.
   *
   * Now the two legs degrade independently and the tenant leg keeps its own
   * last-known answer, so an infrastructure error can no longer DOWNGRADE a
   * window we have already seen.
   *
   * Judgement call, stated here because the next person will second-guess it:
   * when the tenant leg is unknown *and* nothing was ever cached, we return the
   * global answer rather than fabricating `maintenance`. Inventing a window for
   * a tenant we have no evidence about would take a healthy library offline on
   * a transient control-DB blip — the tenant DB is a separate server and its
   * reads may well still be serving. Under-reporting a window we cannot see is
   * the smaller harm, and the `logger.error` in `resolveTenantSafe` is the
   * trace that says which way it went.
   *
   * Note this is NOT what the enforcing middleware uses: `resolveEffective`
   * throwing there produces a 500, i.e. it fails CLOSED, which is the correct
   * direction for a gate that decides whether to accept a mutation. Reporting
   * and enforcing want opposite fallbacks.
   */
  async resolveEffectiveSafe(input: { tenantId?: string }): Promise<ResolvedSystemMode> {
    const global = await this.resolveGlobalSafe();
    if (!input.tenantId) return global;
    const tenant = await this.resolveTenantSafe(input.tenantId);
    return tenant ? pickStricter(global, tenant) : global;
  }

  // ---------- mutations --------------------------------------------------

  async openGlobal(input: OpenInput): Promise<SystemModeEvent> {
    if (input.mode === 'normal') {
      throw new BadRequestException(
        "There's no point opening a 'normal' window — that's the default. Exit an existing mode instead.",
      );
    }
    const event = await this.createEvent({
      scope: 'global',
      tenantId: null,
      mode: input.mode,
      messageMarkdown: input.messageMarkdown,
      startsAt: input.startsAt ?? undefined,
      endsAt: input.endsAt,
      allowAdminBypass: input.allowAdminBypass,
      createdByAdminId: input.createdByAdminId,
    });
    await this.bust({ global: true });
    return event;
  }

  async openTenant(input: OpenInput & { tenantId: string }): Promise<SystemModeEvent> {
    if (input.mode === 'normal') {
      throw new BadRequestException(
        "There's no point opening a 'normal' window — that's the default. Exit an existing mode instead.",
      );
    }
    const tenant = await controlDb.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    const event = await this.createEvent({
      scope: 'tenant',
      tenantId: input.tenantId,
      mode: input.mode,
      messageMarkdown: input.messageMarkdown,
      startsAt: input.startsAt ?? undefined,
      endsAt: input.endsAt,
      allowAdminBypass: input.allowAdminBypass,
      createdByAdminId: input.createdByAdminId,
    });
    await this.bust({ tenantId: input.tenantId });
    return event;
  }

  async endNow(eventId: string): Promise<SystemModeEvent> {
    const event = await controlDb.systemModeEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('System mode event not found.');
    if (event.endedAt) return event;
    const updated = await controlDb.systemModeEvent.update({
      where: { id: eventId },
      data: { endedAt: new Date() },
    });
    await this.bust(event.scope === 'global' ? { global: true } : { tenantId: event.tenantId! });
    return updated;
  }

  async cancelScheduled(eventId: string): Promise<void> {
    const event = await controlDb.systemModeEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('System mode event not found.');
    if (event.startsAt <= new Date()) {
      throw new BadRequestException(
        "That window has already started. Use 'end now' instead of cancelling.",
      );
    }
    await controlDb.systemModeEvent.delete({ where: { id: eventId } });
    await this.bust(event.scope === 'global' ? { global: true } : { tenantId: event.tenantId! });
  }

  // ---------- listing ----------------------------------------------------

  /** Currently-active windows (anything whose [startsAt, endsAt] covers now). */
  async listActive() {
    const now = new Date();
    return controlDb.systemModeEvent.findMany({
      where: {
        endedAt: null,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: { startsAt: 'desc' },
      include: {
        tenant: { select: { id: true, slug: true, name: true } },
        createdByAdmin: { select: { email: true, fullName: true } },
      },
    });
  }

  /** Windows scheduled to start in the future. */
  async listScheduled() {
    return controlDb.systemModeEvent.findMany({
      where: { endedAt: null, startsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
      include: {
        tenant: { select: { id: true, slug: true, name: true } },
        createdByAdmin: { select: { email: true, fullName: true } },
      },
    });
  }

  /** Past events for audit. */
  async listHistory(limit = 50) {
    const capped = Math.max(1, Math.min(200, limit));
    return controlDb.systemModeEvent.findMany({
      where: {
        OR: [{ endedAt: { not: null } }, { endsAt: { lte: new Date() } }],
      },
      orderBy: { startsAt: 'desc' },
      take: capped,
      include: {
        tenant: { select: { id: true, slug: true, name: true } },
        createdByAdmin: { select: { email: true, fullName: true } },
      },
    });
  }

  // ---------- helpers ----------------------------------------------------

  private activeWhere(args: {
    scope: 'global' | 'tenant';
    tenantId?: string;
  }): Prisma.SystemModeEventWhereInput {
    const now = new Date();
    return {
      scope: args.scope,
      ...(args.scope === 'tenant' ? { tenantId: args.tenantId } : { tenantId: null }),
      endedAt: null,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    };
  }

  private eventToResolved(event: SystemModeEvent, source: 'global' | 'tenant'): ResolvedSystemMode {
    return {
      mode: event.mode,
      source,
      eventId: event.id,
      messageMarkdown: event.messageMarkdown,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allowAdminBypass: event.allowAdminBypass,
    };
  }

  private createEvent(data: Prisma.SystemModeEventUncheckedCreateInput): Promise<SystemModeEvent> {
    return controlDb.systemModeEvent.create({ data });
  }

  // ---------- cache I/O --------------------------------------------------

  /**
   * Fail-open: a Redis error is reported as a cache miss, so the caller falls
   * through to the control-plane query instead of propagating a 500 out of a
   * middleware that runs on every request (BOOT-01). Garbage in the cache is
   * still dropped, but that DEL is best-effort for the same reason.
   */
  private async readCache(key: string): Promise<ResolvedSystemMode | null> {
    let raw: string | null;
    try {
      raw = await this.redis.client.get(key);
    } catch (err) {
      this.warnDegraded('read', err);
      return this.degraded.get(key);
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw, reviveDates) as ResolvedSystemMode;
    } catch {
      await this.redis.client.del(key).catch(() => undefined);
      return null;
    }
  }

  private async writeCache(key: string, value: ResolvedSystemMode): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SEC);
    } catch (err) {
      // Redis wouldn't take it — keep it in-process for a few seconds so an
      // outage costs one control-DB read per key, not one per request.
      this.warnDegraded('write', err);
      this.degraded.set(key, value);
    }
  }

  async bust(scope: { global?: true; tenantId?: string }): Promise<void> {
    const keys: string[] = [];
    if (scope.global) keys.push(KEY_GLOBAL);
    if (scope.tenantId) keys.push(KEY_TENANT(scope.tenantId));
    if (!keys.length) return;
    // Only the DEGRADED memo is dropped, never `lastKnownGlobal` /
    // `lastKnownTenant`: those are the floor for a both-dependencies-down
    // resolve, and clearing them here would re-open the exact hole they exist
    // to plug — an operator opens a maintenance window, the DB dies moments
    // later, and the takeover page flips off because we just forgot the only
    // mode we had. The next successful resolve overwrites them anyway.
    this.degraded.delete(...keys);
    try {
      await this.redis.client.del(...keys);
    } catch (err) {
      // Never let a dead Redis reject the write that opens or ends a mode
      // window: that write is the recovery lever, and the row is already
      // committed by the time we get here. The 30 s TTL is the backstop —
      // it exists precisely so a dropped bust self-heals.
      this.warnDegraded('bust', err);
    }
  }

  private warnDegraded(op: 'read' | 'write' | 'bust', err: unknown): void {
    this.logger.warn(
      `Redis ${op} failed (${describeFailure(err)}) — serving system mode from the DB.`,
    );
  }
}

/** Prisma/ioredis errors sometimes carry an empty `message`; name the type too. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message ? `${err.name}: ${err.message}` : err.name;
}

function reviveDates(key: string, value: unknown) {
  if (typeof value === 'string' && /At$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value);
  }
  return value;
}
