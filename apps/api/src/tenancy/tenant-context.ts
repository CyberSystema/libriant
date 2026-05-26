import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';
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
export const TenantCtx = createParamDecorator<unknown, ExecutionContext, TenantContext>(
  (_, ctx) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenant) {
      throw new BadRequestException('No tenant on this request.');
    }
    return req.tenant;
  },
);
