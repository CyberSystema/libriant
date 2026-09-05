import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MetadataScanner, ModulesContainer, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES, SUPPORT_DENIED_KEYS } from '@libriant/shared/permissions';
import { AppModule } from '../../src/app.module.js';
import { PermissionGuard } from '../../src/authz/permission.guard.js';
import {
  PERMISSION_KEY,
  PUBLIC_WITHIN_TENANT_KEY,
  type PermissionRequirement,
} from '../../src/authz/permission.decorator.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This file never issues a request — it reads the route table off the booted module graph.',
);

/**
 * The permission model decides exactly what the role check decided.
 *
 * Phase 3 replaced four hard-coded roles with a catalog of permission keys.
 * The whole risk of that change is in one sentence: a library opens on Monday
 * and a librarian who could check a book out on Friday cannot. Nothing about
 * the new model is worth having if it moves a single existing decision by
 * accident.
 *
 * So the old behaviour was extracted mechanically from the `@Roles` /
 * `@StaffWrite` decorators before any of them were removed, and committed as
 * `__fixtures__/authorization-baseline.json`. This enumerates the LIVE Nest
 * router — not the source, so a route registered by a means the extractor
 * could not see still appears — and asserts, for all 125 routes and all four
 * roles, that the verdict is the same.
 *
 * TWO OF THOSE 500 DECISIONS ALMOST MOVED. `GET /t/:slug/settings` and the
 * three billing reads carry no role check at all, so filing
 * `admin.settings.read` and `billing.read` under the administrator role — the
 * obvious place — would have quietly revoked them from volunteers and
 * librarians. That was caught on paper, before a controller was touched, by
 * running this same comparison against the extraction.
 *
 * SUPPORT IS THE ONE DELIBERATE CHANGE, and it is a NARROWING. `RolesGuard`
 * gave an impersonating Libriant admin the whole `admin` role. It now resolves
 * against the platform's `support` template: `admin` minus a patron's personal
 * data, patron erasure and identity configuration. Path-scoped write fences —
 * staff, billing, export, the library's own support controls — stay with
 * `impersonation-policy.ts`, which expresses them better than a key can.
 * Asserted below as exactly that difference, so neither half can drift.
 */

const BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/authorization-baseline.json', import.meta.url)),
    'utf8',
  ),
) as { roles: string[]; routes: Record<string, string[]> };

type RouteRow = {
  id: string;
  where: string;
  requirement: PermissionRequirement | undefined;
  isPublic: boolean;
  guarded: boolean;
};

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

let app: NestExpressApplication;
let routes: RouteRow[] = [];

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.init();

  const scanner = new MetadataScanner();
  const found: RouteRow[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!cls) continue;
      // The base may be empty: StorageDemoController is `@Controller()` with
      // the full `t/:slug/…` path on every handler. Filtering on the base alone
      // missed all five of its routes, one of which is a DELETE — so the test
      // is per-ROUTE, and a controller is only excluded when none of its routes
      // are tenant-scoped.
      const base = (Reflect.getMetadata('path', cls) as string | undefined) ?? '';
      const classGuards: unknown[] = Reflect.getMetadata('__guards__', cls) ?? [];
      const proto = cls.prototype as object;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name] as object;
        const sub = Reflect.getMetadata('path', handler) as string | undefined;
        // No path metadata means a helper method, not a route.
        if (sub === undefined) continue;
        const method = Reflect.getMetadata('method', handler) as number;
        const guards: unknown[] = [
          ...classGuards,
          ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
        ];
        // A leading slash matters here: with an empty base, `${base}/${sub}`
        // yields `/t/:slug/…`, which does not start with `t/:slug` and silently
        // drops every route on StorageDemoController — the exact class of miss
        // this widening exists to fix.
        const full = [base, sub && sub !== '/' ? sub : '']
          .filter(Boolean)
          .join('/')
          .replace(/\/+/g, '/')
          .replace(/^\//, '');
        if (!full.startsWith('t/:slug')) continue;
        found.push({
          id: `${VERBS[method] ?? String(method)} ${full}`,
          where: `${cls.name}.${name}`,
          requirement:
            Reflect.getMetadata(PERMISSION_KEY, handler) ??
            Reflect.getMetadata(PERMISSION_KEY, cls),
          isPublic:
            Reflect.getMetadata(PUBLIC_WITHIN_TENANT_KEY, handler) === true ||
            Reflect.getMetadata(PUBLIC_WITHIN_TENANT_KEY, cls) === true,
          guarded: guards.includes(PermissionGuard),
        });
      }
    }
  }
  routes = found;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

/** What the permission model says, for one role, on one route. */
function allows(role: keyof typeof ROLE_TEMPLATES, row: RouteRow): boolean {
  if (row.isPublic) return true;
  if (!row.requirement) return false; // PermissionGuard refuses undeclared routes.
  return ROLE_TEMPLATES[role].permissions.includes(row.requirement.permission);
}

describe('the permission model reproduces the role check', () => {
  it('sees the same routes the baseline recorded', () => {
    const live = new Set(routes.map((r) => r.id));
    const frozen = new Set(Object.keys(BASELINE.routes));
    const added = [...live].filter((r) => !frozen.has(r)).sort();
    const removed = [...frozen].filter((r) => !live.has(r)).sort();
    expect(
      { added, removed },
      'A route appeared or vanished. Add or remove its entry in ' +
        'authorization-baseline.json in the same change, and say in the commit what its ' +
        'authorization is and why.',
    ).toEqual({ added: [], removed: [] });
  });

  it('every route is behind PermissionGuard and declares a permission', () => {
    const unguarded = routes.filter((r) => !r.guarded).map((r) => `${r.id} (${r.where})`);
    expect(unguarded, 'a tenant route not behind PermissionGuard is open to all staff').toEqual([]);
    const undeclared = routes
      .filter((r) => !r.isPublic && !r.requirement)
      .map((r) => `${r.id} (${r.where})`);
    expect(undeclared).toEqual([]);
  });

  it('reaches the same verdict as RolesGuard, for every route and every role', () => {
    const moved: string[] = [];
    for (const row of routes) {
      const before = BASELINE.routes[row.id];
      if (!before) continue; // Covered by the route-set assertion above.
      for (const role of BASELINE.roles as (keyof typeof ROLE_TEMPLATES)[]) {
        const was = before.includes(role);
        const now = allows(role, row);
        if (was !== now) {
          moved.push(
            `${row.id} [${row.where}] role=${role} was=${was ? 'ALLOW' : 'DENY'} ` +
              `now=${now ? 'ALLOW' : 'DENY'} key=${row.requirement?.permission ?? '(public)'}`,
          );
        }
      }
    }
    expect(moved, moved.join('\n')).toEqual([]);
  });

  it('covers every route and role, so a silent gap cannot pass', () => {
    // A matrix that checks nothing also reports no mismatches.
    expect(routes.length).toBeGreaterThanOrEqual(120);
    expect(Object.keys(BASELINE.routes)).toHaveLength(routes.length);
    expect(BASELINE.roles).toEqual(['owner', 'admin', 'librarian', 'volunteer']);
  });
});

describe('support access is narrower than administrator', () => {
  it('is exactly admin minus the four named keys', () => {
    const admin = new Set(ROLE_TEMPLATES.admin.permissions);
    const support = new Set(ROLE_TEMPLATES.support.permissions);
    const missing = [...admin].filter((k) => !support.has(k)).sort();
    expect(missing).toEqual([...SUPPORT_DENIED_KEYS].sort());
    const extra = [...support].filter((k) => !admin.has(k));
    expect(extra, 'support must never hold a key an administrator does not').toEqual([]);
  });

  it('loses the routes those keys protect, and keeps the rest', () => {
    const denied = new Set(SUPPORT_DENIED_KEYS);
    const lost = routes
      .filter((r) => r.requirement && denied.has(r.requirement.permission))
      .map((r) => r.id)
      .sort();
    // If this list is ever empty the narrowing has become decorative.
    expect(lost.length).toBeGreaterThan(0);
    expect(lost).toContain('GET t/:slug/members/:id/data-export');
    expect(lost).toContain('POST t/:slug/members/:id/erase');
    // NOT the staff routes. `impersonation-policy.ts` fences staff WRITES by
    // path and method, with a better message and an audit id, and deliberately
    // lets support READ the staff list — "support has to be able to see who
    // works there in order to help". Denying the key here blocked the read too.
    expect(lost).not.toContain('GET t/:slug/staff');

    for (const row of routes) {
      const supportAllowed = allows('support', row);
      const adminAllowed = allows('admin', row);
      if (row.requirement && denied.has(row.requirement.permission)) {
        expect(supportAllowed, `${row.id} must be closed to support`).toBe(false);
      } else {
        expect(supportAllowed, `${row.id} must match admin for support`).toBe(adminAllowed);
      }
    }
  });
});
