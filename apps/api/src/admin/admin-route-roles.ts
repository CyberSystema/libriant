import type { AdminRole } from './admin-roles.decorator.js';

/**
 * Which admin roles may reach a `/admin/*` route that carries no
 * `@AdminRoles(...)` of its own.
 *
 * authn-authz-14: `AdminRolesGuard` used to open with `if (!required) return
 * true`, so attaching the guard and forgetting the decorator produced a route
 * that looked defended in the diff and was reachable by every admin tier. That
 * is exactly what happened to `GET /admin/applications.csv`: a support admin —
 * the lowest platform privilege, the tier we hand to whoever answers the phone
 * — could download the contact name, email, phone, city and free-text message
 * of every library that has ever used the public application form. The default
 * is now `['owner']`, so the next route that forgets the decorator is
 * restrictive rather than open.
 *
 * Flipping that default would have silently revoked the support tier's read
 * access to twenty-one existing routes, so the ones that are deliberately
 * any-admin are pinned here. They are pinned by CONTROLLER CLASS + METHOD NAME
 * rather than by URL, because a URL test is what broke the sibling MFA gate
 * (authn-authz-12) — a request path is attacker-influenced and a class name is
 * not. A pin that goes stale (handler renamed, route deleted) fails CLOSED: the
 * route falls back to owner-only, and admin-route-roles.spec.ts turns the stale
 * entry into a red build rather than a silent one.
 *
 * Every handler left in this table lives outside `src/admin/`. The ones that
 * did not — the fleet list, the plan reads, the override read — now carry
 * `@AnyAdmin()` at the route itself, which is where the rest belong too; each
 * line here can go the day its controller says so for itself. Until then this
 * table is the honest, reviewable statement of who can read what in the control
 * plane, which is more than the absent decorator ever was.
 */
const ROUTE_ROLES: ReadonlyMap<string, readonly AdminRole[]> = new Map<
  string,
  readonly AdminRole[]
>([
  // Reads the support tier needs to do its job: see the fleet, read an
  // announcement, look at a library's plan overrides while someone is on the
  // phone. None of them returns a credential or a personal-data export.
  ['AdminAnnouncementsController.get', ['owner', 'support']],
  ['AdminAnnouncementsController.list', ['owner', 'support']],
  ['AdminAnnouncementsController.stats', ['owner', 'support']],
  ['AdminExportController.list', ['owner', 'support']],
  ['AdminExportController.tenants', ['owner', 'support']],
  ['AdminLibraryRequestsController.get', ['owner', 'support']],
  ['AdminLibraryRequestsController.list', ['owner', 'support']],
  ['AdminMaintenanceController.get', ['owner', 'support']],
  ['AdminMaintenanceController.list', ['owner', 'support']],
  ['AdminMaintenanceController.tenants', ['owner', 'support']],
  ['AdminSubscriptionsController.status', ['owner', 'support']],
  ['AdminSystemModeController.current', ['owner', 'support']],
  ['AdminSystemModeController.history', ['owner', 'support']],
  ['AdminSystemModeController.scheduled', ['owner', 'support']],
  ['AdminTenantTagsController.get', ['owner', 'support']],
  ['BillingAdminController.get', ['owner', 'support']],

  // The finding itself. It is stated here rather than left to the default so
  // that a reader of this file can see the decision was made, not inherited —
  // and so admin-route-roles.spec.ts can insist every guarded route is declared
  // somewhere instead of quietly leaning on the fallback.
  ['ApplicationsController.exportCsv', ['owner']],
]);

/** Fail-closed default for a guarded route nobody declared. */
const DEFAULT_ROLES: readonly AdminRole[] = ['owner'];

/** The pinned entries, for the spec that keeps this table honest. */
export function pinnedAdminRouteIds(): string[] {
  return [...ROUTE_ROLES.keys()];
}

/**
 * Roles for a guarded route that declared none. `controller`/`handler` are
 * `ctx.getClass().name` / `ctx.getHandler().name` — stable under both `tsc`
 * (the production build) and `tsx` (dev + tests); neither minifies.
 */
export function adminRouteRoles(controller: string, handler: string): readonly AdminRole[] {
  return ROUTE_ROLES.get(`${controller}.${handler}`) ?? DEFAULT_ROLES;
}
