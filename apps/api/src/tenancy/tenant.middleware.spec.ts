import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { TenantMiddleware } from './tenant.middleware.js';
import type { TenantResolverService } from './tenant-resolver.service.js';

/** Minimal Express request stub carrying just what the middleware reads. */
function makeReq(host: string, url = '/lbr-api/admin/auth/login'): Request {
  return { headers: { host }, originalUrl: url, url } as unknown as Request;
}

describe('TenantMiddleware — host → tenant resolution', () => {
  let resolveBySubdomain: ReturnType<typeof vi.fn>;
  let resolveBySlug: ReturnType<typeof vi.fn>;
  let mw: TenantMiddleware;

  beforeEach(() => {
    // dev mode so loadEnv() doesn't require production secrets.
    process.env.NODE_ENV = 'development';
    process.env.PUBLIC_APEX_DOMAIN = 'libriant.com';
    process.env.ADMIN_HOST = 'admin.libriant.com';
    process.env.TENANT_PATH_PREFIX = '/t/';
    resolveBySubdomain = vi.fn().mockResolvedValue(null);
    resolveBySlug = vi.fn().mockResolvedValue(null);
    mw = new TenantMiddleware({
      resolveBySubdomain,
      resolveBySlug,
    } as unknown as TenantResolverService);
  });

  async function run(host: string) {
    const next = vi.fn();
    await mw.use(makeReq(host), {} as Response, next);
    return next;
  }

  it('does NOT treat the admin host as a tenant (the "Unknown library admin" bug)', async () => {
    const next = await run('admin.libriant.com');
    expect(resolveBySubdomain).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(); // next() with no error
  });

  it('resolves a real tenant subdomain', async () => {
    await run('acme.libriant.com');
    expect(resolveBySubdomain).toHaveBeenCalledWith('acme');
  });

  it('ignores reserved platform subdomains (www, api, app)', async () => {
    for (const sub of ['www', 'api', 'app']) {
      resolveBySubdomain.mockClear();
      await run(`${sub}.libriant.com`);
      expect(resolveBySubdomain).not.toHaveBeenCalled();
    }
  });

  it('ignores the bare apex', async () => {
    const next = await run('libriant.com');
    expect(resolveBySubdomain).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
