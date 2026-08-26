import 'reflect-metadata';
import { MetadataScanner, ModulesContainer, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { ADMIN_ROLES_KEY } from '../../src/admin/admin-roles.decorator.js';
import { AdminRolesGuard } from '../../src/admin/admin-roles.guard.js';
import { pinnedAdminRouteIds } from '../../src/admin/admin-route-roles.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This file never issues a request — it reads the route table off the booted module graph. ' +
    'The posture only has to be declared, not chosen; the shipped value is the honest one.',
);

/**
 * authn-authz-14, the half a runtime default cannot cover.
 *
 * `AdminRolesGuard` now denies a route that declares no roles, so the next
 * `@UseGuards(AdminAuthGuard, AdminRolesGuard)` with a forgotten `@AdminRoles`
 * is owner-only instead of open. That is the safe failure, but it is a SILENT
 * one: whoever added the route finds out when a support admin reports a 403,
 * which on a two-person platform may be months later.
 *
 * So this asserts the louder half. Every guarded route must SAY who may reach
 * it — at the route (`@AdminRoles` / `@AnyAdmin`) or, for the controllers that
 * live outside src/admin/, in admin-route-roles.ts. Nothing may reach the
 * fallback. And every pin must still point at a real route, so the table cannot
 * rot into a list of handlers that no longer exist.
 */
let app: NestExpressApplication;

type GuardedRoute = { id: string; declared: boolean };

function guardedAdminRoutes(): GuardedRoute[] {
  const scanner = new MetadataScanner();
  const found: GuardedRoute[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!cls) continue;
      const classGuards: unknown[] = Reflect.getMetadata('__guards__', cls) ?? [];
      const proto = cls.prototype as object;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name] as object;
        // No path metadata ⇒ a private helper, not a route. `purgeStorage` and
        // `invalidatePlan` sit on guarded controllers and are nobody's endpoint.
        if (Reflect.getMetadata('path', handler) === undefined) continue;
        const guards: unknown[] = [
          ...classGuards,
          ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
        ];
        if (!guards.includes(AdminRolesGuard)) continue;
        found.push({
          id: `${cls.name}.${name}`,
          declared:
            Reflect.getMetadata(ADMIN_ROLES_KEY, handler) !== undefined ||
            Reflect.getMetadata(ADMIN_ROLES_KEY, cls) !== undefined,
        });
      }
    }
  }
  return found;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  await app.init();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('every AdminRolesGuard route declares who may reach it', () => {
  it('finds the guarded routes at all — otherwise the rest of this file proves nothing', () => {
    const routes = guardedAdminRoutes();
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.map((r) => r.id)).toContain('ApplicationsController.exportCsv');
  });

  it('leaves none of them to the fail-closed default', () => {
    const pinned = new Set(pinnedAdminRouteIds());
    const undeclared = guardedAdminRoutes()
      .filter((r) => !r.declared && !pinned.has(r.id))
      .map((r) => r.id)
      .sort();
    expect(
      undeclared,
      'These routes carry AdminRolesGuard and say nothing about who may use them, so they are ' +
        'owner-only by default. Put @AdminRoles(...) or @AnyAdmin() on the handler — or, if the ' +
        'controller is outside src/admin/, add a line to admin-route-roles.ts.',
    ).toEqual([]);
  });

  it('has no pin left pointing at a route that no longer exists', () => {
    const live = new Set(guardedAdminRoutes().map((r) => r.id));
    const stale = pinnedAdminRouteIds()
      .filter((id) => !live.has(id))
      .sort();
    expect(
      stale,
      'admin-route-roles.ts pins these, but no guarded route answers to that name any more. ' +
        'A stale pin is harmless at runtime (the route falls back to owner-only) and misleading ' +
        'to read, so delete it.',
    ).toEqual([]);
  });
});
