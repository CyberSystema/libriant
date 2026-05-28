import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  controlDb,
  type Prisma,
  type SystemModeEvent,
  type SystemModeKind,
} from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
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
 * CRUD + resolution for the system-mode subsystem. Resolution is
 * **read-time**: we never run a scheduler that flips the row at
 * `startsAt`. Instead, the active query is
 * `endedAt IS NULL AND startsAt <= now AND (endsAt IS NULL OR endsAt > now)`.
 * That removes the only race (worker dies → mode never flips) and lets
 * us declare windows hours/days/weeks in advance with zero infra.
 */
@Injectable()
export class SystemModeService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  // ---------- resolution -------------------------------------------------

  async resolveGlobal(): Promise<ResolvedSystemMode> {
    const cached = await this.readCache(KEY_GLOBAL);
    if (cached) return cached;
    const row = await controlDb.systemModeEvent.findFirst({
      where: this.activeWhere({ scope: 'global' }),
      orderBy: { startsAt: 'desc' },
    });
    const resolved = row ? this.eventToResolved(row, 'global') : NORMAL_MODE;
    await this.writeCache(KEY_GLOBAL, resolved);
    return resolved;
  }

  async resolveTenant(tenantId: string): Promise<ResolvedSystemMode> {
    const cached = await this.readCache(KEY_TENANT(tenantId));
    if (cached) return cached;
    const row = await controlDb.systemModeEvent.findFirst({
      where: this.activeWhere({ scope: 'tenant', tenantId }),
      orderBy: { startsAt: 'desc' },
    });
    const resolved = row ? this.eventToResolved(row, 'tenant') : NORMAL_MODE;
    await this.writeCache(KEY_TENANT(tenantId), resolved);
    return resolved;
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

  private async readCache(key: string): Promise<ResolvedSystemMode | null> {
    const raw = await this.redis.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw, reviveDates) as ResolvedSystemMode;
    } catch {
      await this.redis.client.del(key);
      return null;
    }
  }

  private async writeCache(key: string, value: ResolvedSystemMode): Promise<void> {
    await this.redis.client.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SEC);
  }

  async bust(scope: { global?: true; tenantId?: string }): Promise<void> {
    const keys: string[] = [];
    if (scope.global) keys.push(KEY_GLOBAL);
    if (scope.tenantId) keys.push(KEY_TENANT(scope.tenantId));
    if (keys.length) await this.redis.client.del(...keys);
  }
}

function reviveDates(key: string, value: unknown) {
  if (typeof value === 'string' && /At$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value);
  }
  return value;
}
