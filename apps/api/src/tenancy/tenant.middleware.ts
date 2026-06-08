import {
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { TenantResolverService } from './tenant-resolver.service.js';
import { loadEnv } from '../config/env.js';

/**
 * Identifies the tenant for each request and attaches a `TenantContext`
 * to `req.tenant`. Two resolution strategies, tried in order:
 *
 *   1. **Path** — `/t/<slug>/...` (the default at MVP). The slug is
 *      stripped from the URL is NOT performed here (let routes match it),
 *      but the parsed value is used to resolve via the control plane.
 *   2. **Subdomain** — `<sub>.<apex>` in the Host header. Only used for
 *      tenants that have opted into a custom subdomain (Pro/Enterprise
 *      `custom_subdomain_enabled`).
 *
 * If a tenant is resolved but is suspended → 403. If archived → 410. If
 * the slug exists nowhere → no tenant context is attached and downstream
 * routes (e.g. `/healthz`, `/auth/*`) continue normally; the
 * `TenantGuard` is what rejects tenant-scoped routes that need a tenant.
 *
 * This middleware is registered for `*` (all routes) — the upper bound on
 * cost is one Redis GET per request; cache hits are O(microseconds).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly pathPrefix: string;
  private readonly apex: string;
  private readonly adminHost: string;

  /**
   * Subdomains that are NEVER a tenant — they belong to the platform, not a
   * library. `admin` is the platform console (`admin.<apex>`); the others are
   * conventional infra names we never want resolved as a library slug.
   */
  private static readonly RESERVED_SUBDOMAINS = new Set(['admin', 'www', 'api', 'app']);

  constructor(@Inject(TenantResolverService) private readonly resolver: TenantResolverService) {
    const env = loadEnv();
    this.pathPrefix = env.tenantPathPrefix;
    this.apex = env.publicApexDomain.toLowerCase();
    this.adminHost = env.adminHost.toLowerCase();
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      // When NestJS applies middleware via forRoutes('*'), Express mounts at
      // a prefix and rewrites req.path / req.url to the relative portion. The
      // full request path lives on req.originalUrl (minus query string).
      const fullPath = (req.originalUrl || req.url).split('?')[0] ?? '/';
      const pathSlug = this.extractSlugFromPath(fullPath);
      const subSlug = this.extractSlugFromHost(req.headers.host);
      const slug = pathSlug ?? subSlug;
      if (!slug) {
        return next();
      }
      const fromPath = pathSlug === slug;
      const ctx = fromPath
        ? await this.resolver.resolveBySlug(slug)
        : await this.resolver.resolveBySubdomain(slug);

      if (!ctx) {
        // Path-based not-found is a 404 per tenant routes; subdomain
        // not-found also a 404 (a wandering subdomain hitting our LB).
        throw new NotFoundException(`Unknown library "${slug}".`);
      }
      if (ctx.status === 'archived') {
        throw new GoneException('This library has been archived.');
      }
      if (ctx.status === 'suspended') {
        throw new ForbiddenException(
          'This library is paused. Please contact your Libriant administrator.',
        );
      }
      req.tenant = ctx;
      return next();
    } catch (err) {
      // Let Nest's exception filter handle HttpException; everything else
      // becomes a 500 via the default filter.
      next(err);
    }
  }

  /**
   * Extract a slug from `/t/<slug>/<rest>` or `/t/<slug>` (no trailing).
   * Returns null if the path doesn't start with the configured prefix.
   *
   * Validates the slug against the same character class the DB CHECK
   * constraint enforces; an invalid shape is treated as "no tenant in
   * this URL" rather than 404, so a poorly-formed URL gets a normal 404
   * from the router instead of leaking tenant resolution behavior.
   */
  private extractSlugFromPath(reqPath: string): string | null {
    if (!reqPath.startsWith(this.pathPrefix)) return null;
    const after = reqPath.slice(this.pathPrefix.length);
    const slug = after.split('/')[0] ?? '';
    return this.isValidSlug(slug) ? slug : null;
  }

  /**
   * Parse the Host header (`acme.libriant.com:443`). Returns the
   * subdomain when the host matches `<sub>.<apex>` for our configured
   * apex; null otherwise.
   */
  private extractSlugFromHost(host: string | undefined): string | null {
    if (!host) return null;
    const bare = host.split(':')[0]!.toLowerCase();
    if (bare === this.apex) return null;
    // The platform admin host is not a tenant — otherwise `admin.<apex>`
    // resolves to a library named "admin" and every admin request 404s with
    // `Unknown library "admin"`.
    if (bare === this.adminHost) return null;
    const suffix = `.${this.apex}`;
    if (!bare.endsWith(suffix)) return null;
    const sub = bare.slice(0, -suffix.length);
    // Reject multi-level subdomains (e.g. www.acme.libriant.com); we only
    // support `<slug>.<apex>` for tenant routing.
    if (!sub || sub.includes('.')) return null;
    // Reserved platform subdomains are never libraries.
    if (TenantMiddleware.RESERVED_SUBDOMAINS.has(sub)) return null;
    return this.isValidSlug(sub) ? sub : null;
  }

  private isValidSlug(s: string): boolean {
    // Mirror of `tenants_slug_format` / `tenants_custom_subdomain_format`.
    return /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(s);
  }
}
