import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { SystemModeService } from './system-mode.service.js';
import type { ResolvedSystemMode } from './system-mode.types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Effective system mode for this request after the global/tenant
       * resolver runs. Always set by `SystemModeMiddleware` even when
       * `normal` — downstream code can read it without a null check.
       */
      systemMode?: ResolvedSystemMode;
    }
  }
}

/**
 * Always-allow paths. These keep the platform recoverable when something
 * goes wrong: infra probes keep working, the public mode-lookup endpoint
 * stays reachable so the web app can render the takeover page itself,
 * and crucially `/admin/system-mode/*` stays open even when
 * `allowAdminBypass=false` so an operator never locks themselves out of
 * the lever they need to pull to recover.
 */
const ALWAYS_PASS = [
  /^\/healthz\/?$/,
  /^\/readyz\/?$/,
  /^\/metrics\/?$/,
  /^\/system-mode(\/|$)/,
  /^\/admin\/system-mode(\/|$)/,
  /^\/admin\/auth(\/|$)/,
  // BILL-1: inbound third-party webhooks must never be 503'd during
  // maintenance / out_of_order / read_only. Stripe gives up after ~3 days,
  // so a window that outlasts that envelope would silently lose subscription
  // events with no durable trace (the retry sweep can only rescue rows that
  // were actually written). The handler is signature-verified, idempotent,
  // and writes only control-plane rows (no tenant DB), so letting it through
  // at minimum persists the durable row that the sweep can later rescue.
  /^\/webhooks\/stripe(\/|$)/,
];

/**
 * Paths gated by `allowAdminBypass`. When the active event has that flag
 * (default true), these stay reachable even during maintenance / outage
 * so an admin can fix the underlying issue.
 */
const ADMIN_BYPASS = [/^\/admin(\/|$)/, /^\/auth\/admin(\/|$)/];

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Runs **after** Session / Admin / Impersonation middleware so it can
 * trust `req.impersonation`, and **before** TenantMiddleware so a
 * maintenance event can stop the request before any tenant DB pool
 * even gets warmed up.
 *
 * Per the plan: for tenant-scoped URLs (`/t/<slug>/...`) we resolve the
 * tenant inline through `TenantResolverService` (Redis-cached) so the
 * stricter of (global, tenant) wins. For everything else only global is
 * consulted.
 *
 * Effect by mode:
 *   normal              — attach + pass through
 *   under_construction  — attach + pass through (banner rendered client-side)
 *   read_only           — pass GET/HEAD/OPTIONS; 503 for mutations
 *   out_of_order        — 503 unless bypassed
 *   maintenance         — 503 unless bypassed
 */
@Injectable()
export class SystemModeMiddleware implements NestMiddleware {
  private readonly pathPrefix: string;

  constructor(
    @Inject(SystemModeService) private readonly modes: SystemModeService,
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {
    this.pathPrefix = loadEnv().tenantPathPrefix;
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // NestJS mounts middleware via `forRoutes('*')` which rewrites
    // Express's `req.path` to `/` relative to the wildcard mount. The
    // request's full path is preserved on `req.originalUrl`; we strip
    // the query string before matching against ALWAYS_PASS / ADMIN_BYPASS.
    const fullPath = (req.originalUrl ?? req.url ?? '/').split('?', 1)[0]!;

    if (ALWAYS_PASS.some((re) => re.test(fullPath))) {
      // Always set req.systemMode so handlers can inspect it for headers
      // / banners even on bypassed routes (`/system-mode/current` does this).
      req.systemMode = await this.modes.resolveGlobal();
      return next();
    }

    // Resolve the tenant from the URL if this is a tenant-scoped request.
    const tenantId = await this.tenantIdFromPath(fullPath);
    const effective = await this.modes.resolveEffective({ tenantId });
    req.systemMode = effective;

    // Expose the mode + (when set) the end time + source on response
    // headers. Web layouts already in flight via SSR can consume this
    // without an extra round-trip; the dedicated /system-mode/current
    // endpoint stays for cases where the response body is what's needed.
    this.applyResponseHeaders(res, effective);

    if (effective.mode === 'normal' || effective.mode === 'under_construction') {
      return next();
    }

    // Admin bypass — but only when the event allows it. `/admin/system-mode/*`
    // is in ALWAYS_PASS above so the operator can always recover even if
    // they accidentally set `allowAdminBypass=false`.
    const adminBypassEligible = ADMIN_BYPASS.some((re) => re.test(fullPath));
    if (adminBypassEligible && effective.allowAdminBypass) {
      return next();
    }

    // Active support sessions get to keep working through maintenance
    // / read-only / outage modes. The admin pulled this lever to debug,
    // so cutting them off mid-session would be hostile. Impersonation
    // is validated up-front in ImpersonationMiddleware — by the time we
    // see `req.impersonation`, the DB row is confirmed alive.
    if (req.impersonation) {
      return next();
    }

    if (effective.mode === 'read_only') {
      if (MUTATING_METHODS.has(req.method)) {
        res.status(503).json(this.maintenanceBody(effective, 'read_only'));
        return;
      }
      return next();
    }

    // maintenance or out_of_order — full block.
    res.status(503).json(this.maintenanceBody(effective, effective.mode));
  }

  private async tenantIdFromPath(path: string): Promise<string | undefined> {
    if (!path.startsWith(this.pathPrefix)) return undefined;
    const rest = path.slice(this.pathPrefix.length);
    const slug = rest.split('/', 1)[0];
    if (!slug) return undefined;
    const tenant = await this.tenantResolver.resolveBySlug(slug);
    return tenant?.id;
  }

  private applyResponseHeaders(res: Response, effective: ResolvedSystemMode): void {
    res.setHeader('x-system-mode', effective.mode);
    res.setHeader('x-system-mode-source', effective.source);
    if (effective.endsAt) {
      res.setHeader('x-system-mode-ends-at', effective.endsAt.toISOString());
    }
  }

  private maintenanceBody(
    effective: ResolvedSystemMode,
    reason: 'maintenance' | 'out_of_order' | 'read_only',
  ) {
    return {
      statusCode: 503,
      error: 'ServiceUnavailable',
      reason,
      message:
        reason === 'read_only'
          ? "Libriant is in read-only mode right now. We're not accepting changes for a few minutes."
          : reason === 'maintenance'
            ? 'Libriant is undergoing scheduled maintenance and will be back shortly.'
            : "Libriant is temporarily unavailable. We're working on it.",
      expectedEndsAt: effective.endsAt?.toISOString() ?? null,
      mode: effective.mode,
      source: effective.source,
    };
  }
}
