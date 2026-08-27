import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    applyHashPepper: 'unit-test-pepper-0123456789abcdef0123',
    applyNotifyTo: 'info@example.test',
    adminHost: 'admin.example.test',
    emailDriver: 'console',
  }),
}));

const { applicationCount } = vi.hoisted(() => ({ applicationCount: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { application: { count: applicationCount } },
}));

import { ADMIN_ROLES_KEY } from '../admin/admin-roles.decorator.js';
import { AdminApplicationsController } from './admin-applications.controller.js';
import { ApplicationsModule } from './applications.module.js';

/**
 * Two things, and the first one is the one that keeps going wrong in this
 * repository: a controller that is not in a module's `controllers` array is a
 * set of routes Nest never maps. The admin panel's Applications page would
 * then 404 against an endpoint that reads perfectly well in the diff — and
 * launch-readiness-03 would be "fixed" with the funnel exactly as silent as
 * before.
 *
 * The second is the gate. Every row this controller returns carries an
 * applicant's name, e-mail address and phone number; authn-authz-14 is the
 * finding where the sibling CSV route handed exactly that to the support tier
 * because the decorator was missing and the guard defaulted open. The
 * decorator is read here the same way `AdminRolesGuard` reads it.
 */
describe('AdminApplicationsController is actually mounted', () => {
  it('is registered in ApplicationsModule, so Nest maps its routes', () => {
    const controllers = Reflect.getMetadata('controllers', ApplicationsModule) as unknown[];
    expect(controllers).toContain(AdminApplicationsController);
  });

  it('is owner-only, by the same lookup the guard performs', () => {
    const reflector = new Reflector();
    for (const handler of ['list', 'summary', 'setStatus'] as const) {
      const roles = reflector.getAllAndOverride<string[] | undefined>(ADMIN_ROLES_KEY, [
        AdminApplicationsController.prototype[handler],
        AdminApplicationsController,
      ]);
      expect(roles, handler).toEqual(['owner']);
    }
  });
});
