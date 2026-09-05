import { describe, expect, it, vi } from 'vitest';
import { ROLE_TEMPLATES, SUPPORT_DENIED_KEYS } from '@libriant/shared/permissions';
import { PermissionGuard } from '../authz/permission.guard.js';
import { PublicWithinTenant, RequirePermission } from '../authz/permission.decorator.js';
import type { PermissionsService } from '../authz/permissions.service.js';

/**
 * What a Libriant admin may do inside a consented support window.
 *
 * HISTORY. `RolesGuard` began with `if (req.impersonation) return true;` — a
 * blanket bypass satisfying every `@Roles(...)` on the tenant API
 * (authn-authz-05), reached by an admin who had already been offboarded
 * (authn-authz-04). It was replaced by pinning support to the effective role
 * `admin`, and the spec that replaced it lived here.
 *
 * WHAT CHANGED IN PHASE 3. `admin` is no longer the answer. Support now
 * resolves against the platform's `support` TEMPLATE — `admin` minus four
 * keys — for two reasons the old model could not express:
 *
 *   A library consenting to "help me fix my catalogue" did not consent to
 *   having a patron's complete borrowing history exported, or that patron
 *   erased. Path-scoped write fences — staff, billing, export — stay with
 *   impersonation-policy.ts, which says WHY in each message and records a
 *   stable id on the library's own audit row; a key cannot do either, and
 *   denying one blocked the reads the policy allows on purpose.
 *
 *   The template is PLATFORM data, never the tenant's rows. A library that
 *   customises its own `admin` role must not thereby widen what support can
 *   see — which pinning to a tenant role would have allowed.
 *
 * These are real decorators on real methods, read back through the real
 * Reflector by the real guard, because the thing under test IS the
 * relationship between an annotation and a verdict.
 */
class Routes {
  @RequirePermission('patron.write')
  createPatron(): void {}

  @RequirePermission('admin.settings.edit')
  changeSettings(): void {}

  // The four support must not reach.
  @RequirePermission('patron.pii.export')
  exportPatronData(): void {}

  @RequirePermission('patron.erase')
  erasePatron(): void {}

  @RequirePermission('admin.staff.manage')
  inviteStaff(): void {}

  @RequirePermission('cat.bib.read')
  readCatalogue(): void {}

  @RequirePermission('admin.identity.manage')
  configureSso(): void {}

  // Owner-only. No support session, and no administrator, may accept terms.
  @RequirePermission('admin.legal.accept')
  acceptTerms(): void {}

  @PublicWithinTenant()
  whoAmI(): void {}

  undecorated(): void {}
}

const permissions = {
  supportPermissions: () => ({
    keys: new Set(ROLE_TEMPLATES.support.permissions),
    limits: new Map(ROLE_TEMPLATES.support.permissions.map((k) => [k, null])),
  }),
  forUser: vi.fn(),
} as unknown as PermissionsService;

const guard = new PermissionGuard(permissions);

const impersonated = () => ({
  impersonation: { imp: true, adminId: 'a1', tenantId: 't1', sessionId: 's1', iat: 1, exp: 2 },
});

function ctxFor(handler: () => void, req: Record<string, unknown>) {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('PermissionGuard under impersonation', () => {
  it('lets support do the library-admin work the window exists for', async () => {
    // `inviteStaff` is here on purpose. Support KEEPS admin.staff.manage,
    // because impersonation-policy.ts fences staff WRITES by path and method —
    // with a message naming the four-hour window, and an audit id — while
    // letting support read the staff list. Denying the key blocked the read
    // too, and replaced that message with a generic one.
    for (const handler of [
      Routes.prototype.createPatron,
      Routes.prototype.changeSettings,
      Routes.prototype.inviteStaff,
      Routes.prototype.readCatalogue,
    ]) {
      await expect(guard.canActivate(ctxFor(handler, impersonated()))).resolves.toBe(true);
    }
    // No per-user resolution for an impersonated caller: there is no tenant
    // user to read, and reading one would let a library's own rows decide what
    // support may do.
    expect(permissions.forUser).not.toHaveBeenCalled();
  });

  it('refuses each of the four keys support does not hold', async () => {
    const cases: [keyof typeof Routes.prototype, string][] = [
      ['exportPatronData', 'patron.pii.export'],
      ['erasePatron', 'patron.erase'],
      ['configureSso', 'admin.identity.manage'],
    ];
    for (const [method, key] of cases) {
      expect(SUPPORT_DENIED_KEYS, key).toContain(key);
      await expect(
        guard.canActivate(ctxFor(Routes.prototype[method] as () => void, impersonated())),
        key,
      ).rejects.toThrow(/support access cannot/i);
    }
  });

  it('refuses an owner-only route, which the original blanket bypass allowed', async () => {
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.acceptTerms, impersonated())),
    ).rejects.toThrow(/support access cannot/i);
  });

  it('allows a route explicitly opened to every staff role', async () => {
    await expect(guard.canActivate(ctxFor(Routes.prototype.whoAmI, impersonated()))).resolves.toBe(
      true,
    );
  });

  it('REFUSES an undecorated route, where the old guard let it through', async () => {
    // The deliberate reversal. `RolesGuard` read "no @Roles" as "open to
    // everyone", so a forgotten decorator was a silently open route. Missing
    // metadata is now a refusal, and `pnpm check:permissions` fails the build
    // besides.
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.undecorated, impersonated())),
    ).rejects.toThrow(/no permission is declared/i);
  });

  it('resolves a signed-in user through the tenant, not through the template', async () => {
    const tenant = { id: 't1', dbUrl: 'postgres://x/y' };
    (permissions.forUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      keys: new Set(['patron.write']),
      limits: new Map(),
    });
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.createPatron, { session: { sub: 'u1' }, tenant })),
    ).resolves.toBe(true);
    expect(permissions.forUser).toHaveBeenCalledWith(tenant, 'u1');

    // ...and a key that user does not hold is refused, with the human label.
    await expect(
      guard.canActivate(
        ctxFor(Routes.prototype.changeSettings, { session: { sub: 'u1' }, tenant }),
      ),
    ).rejects.toThrow(/do not have permission to change library settings/i);
  });

  it('refuses when there is no session at all', async () => {
    await expect(guard.canActivate(ctxFor(Routes.prototype.createPatron, {}))).rejects.toThrow(
      /sign in/i,
    );
  });
});
