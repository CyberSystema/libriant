import { createParamDecorator, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantStatus } from '@libriant/db-control';

/**
 * Everything we know about the tenant on the current request. Set by
 * TenantMiddleware on `request.tenant` (and via the augmented Express type).
 *
 * `dbUrl` and `storageUrl` are the **per-tenant** addresses — code that
 * needs to query / read files for this tenant pulls them from here so that
 * sharding a tenant later is a row update, not a code change.
 */
export type TenantContext = {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  status: TenantStatus;
  dbUrl: string;
  storageUrl: string;
  customSubdomain: string | null;
  tags: string[];
  /**
   * Which schema generation this library's database is on (2.0 phase 20f).
   *
   * `tenant_schema_state.schemaMajor`: 1 is the pre-cutover shape with the 2.0
   * tables in `lbr2`, 2 is after `tenant-upgrade-v2.ts` promoted them to
   * `public`. It rides on the context because `TenantPrismaService` has to bind
   * the 2.0 client to the right schema per tenant — a promotion happens one
   * database at a time while a deploy reaches every tenant at once, so the fleet
   * holds both populations for as long as the promotions take.
   *
   * OPTIONAL, and absent means 1. Every path that builds a context by hand — the
   * sweeps, the tests — is describing a tenant nobody has upgraded.
   */
  schemaMajor?: number;
  /** How the middleware recognized this tenant on this request. */
  resolvedFrom: 'path' | 'subdomain';
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by TenantMiddleware. Undefined on non-tenant routes. */
      tenant?: TenantContext;
    }
  }
}

/**
 * Read the resolved tenant from the request. Throws 400 if no tenant
 * context exists (most controllers under /t/:slug live behind TenantGuard
 * which guarantees it, so this is a defense-in-depth).
 */
export const TenantCtx = createParamDecorator<unknown, TenantContext>((_, ctx) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.tenant) {
    throw new BadRequestException('No tenant on this request.');
  }
  return req.tenant;
});
