import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

// Repo convention for a class that reads config in its constructor. These are
// the three hosts the check is written against; naming them here rather than
// reaching for the real env keeps the cases readable as sentences.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    publicApexDomain: 'libriant.com',
    adminHost: 'admin.libriant.com',
    siteHost: 'libriant.com',
  }),
}));

import { OriginCheckMiddleware } from './origin-check.middleware.js';

/**
 * The Origin gate in front of the only unauthenticated write in the product.
 *
 * This file exists because a review went looking for it and found nothing: the
 * gate had no unit coverage anywhere in the repository, and its only exercise
 * in the whole suite was an integration test that it broke. Everything below is
 * a rule some comment in the middleware or the Caddyfile claims is enforced —
 * the point is that the claims are now executable.
 */
describe('OriginCheckMiddleware', () => {
  let mw: OriginCheckMiddleware;
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mw = new OriginCheckMiddleware();
    next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  });

  const run = (path: string, origin?: string, method = 'POST'): void => {
    const req = { method, path, headers: origin ? { origin } : {} } as unknown as Request;
    mw.use(req, {} as Response, next);
  };

  describe('the application form', () => {
    it('accepts the real form, in both languages', () => {
      run('/apply', 'https://libriant.com');
      run('/en/apply', 'https://libriant.com');
      expect(next).toHaveBeenCalledTimes(2);
    });

    it('refuses a submission with no Origin at all', () => {
      // Every browser sends Origin on a form-navigation POST, so a missing one
      // here is a script rather than a visitor. This is the rule that broke the
      // integration test, which is how it was found; the test now sends Origin
      // because a librarian's browser does.
      expect(() => run('/apply')).toThrow(ForbiddenException);
      expect(next).not.toHaveBeenCalled();
    });

    it('refuses a tenant subdomain and the admin host', () => {
      // Both pass the generic same-property test that governs the rest of the
      // API. The form posts from one host, so it accepts one host — otherwise
      // any page on any tenant could drive this endpoint, on the
      // `/lbr-api/apply` entrance that the edge matcher never sees.
      expect(() => run('/apply', 'https://demo.libriant.com')).toThrow(ForbiddenException);
      expect(() => run('/apply', 'https://admin.libriant.com')).toThrow(ForbiddenException);
    });

    it('refuses a foreign origin and an unparseable one', () => {
      expect(() => run('/apply', 'https://evil.example')).toThrow(ForbiddenException);
      expect(() => run('/apply', 'null')).toThrow(ForbiddenException);
    });

    it('is not bypassed by casing or a trailing slash', () => {
      // Express matches routes case-insensitively and ignores a trailing slash,
      // so `POST /Apply/` reaches the same handler. A comparison against a
      // literal path has to normalise or it is a bypass, not a check.
      for (const path of ['/APPLY', '/apply/', '/Apply/', '/en/Apply/']) {
        expect(() => run(path), path).toThrow(ForbiddenException);
      }
    });

    it('leaves GET alone, so the stray-navigation redirect still works', () => {
      run('/apply', undefined, 'GET');
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('everywhere else', () => {
    it('still allows a missing Origin — Stripe, the desktop shell, test clients', () => {
      run('/webhooks/stripe');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows the apex and any tenant subdomain', () => {
      run('/tenants/demo/items', 'https://libriant.com');
      run('/tenants/demo/items', 'https://demo.libriant.com');
      expect(next).toHaveBeenCalledTimes(2);
    });

    it('rejects a cross-site origin', () => {
      expect(() => run('/tenants/demo/items', 'https://evil.example')).toThrow(ForbiddenException);
    });

    it('keeps admin mutations on the admin host', () => {
      run('/admin/applications', 'https://admin.libriant.com');
      expect(next).toHaveBeenCalledTimes(1);
      expect(() => run('/admin/applications', 'https://demo.libriant.com')).toThrow(
        ForbiddenException,
      );
    });
  });
});
