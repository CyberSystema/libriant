import type { SystemModeKind } from '@libriant/db-control';

/**
 * Severity ordering for "stricter wins" resolution. When both a global
 * event and a per-tenant event are active, the higher severity wins. Two
 * events with the same severity (e.g. global maintenance + tenant
 * maintenance) are equivalent — we pick the more specific (tenant) so
 * its `messageMarkdown` is what the user sees.
 *
 * Practical impact at the middleware:
 *   normal              0  — pass through
 *   under_construction  1  — pass through + banner in tenant UI
 *   read_only           2  — block mutations (POST/PATCH/PUT/DELETE) → 503
 *   out_of_order        3  — block everything except admin bypass routes
 *   maintenance         3  — same enforcement; different brand/message
 */
export const SEVERITY: Record<SystemModeKind, number> = {
  normal: 0,
  under_construction: 1,
  read_only: 2,
  out_of_order: 3,
  maintenance: 3,
};

export type ResolvedSystemMode = {
  mode: SystemModeKind;
  /** What's actually controlling this — useful for stats + admin display. */
  source: 'global' | 'tenant' | 'default';
  /** ID of the underlying event row when source is not 'default'. */
  eventId: string | null;
  messageMarkdown: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allowAdminBypass: boolean;
};

export const NORMAL_MODE: ResolvedSystemMode = {
  mode: 'normal',
  source: 'default',
  eventId: null,
  messageMarkdown: null,
  startsAt: null,
  endsAt: null,
  allowAdminBypass: true,
};

/** Picks the stricter mode; ties go to `tenant`. */
export function pickStricter(a: ResolvedSystemMode, b: ResolvedSystemMode): ResolvedSystemMode {
  const sa = SEVERITY[a.mode];
  const sb = SEVERITY[b.mode];
  if (sb > sa) return b;
  if (sa > sb) return a;
  // Equal severity: tenant wins (more specific). If neither is tenant,
  // either order is fine.
  if (b.source === 'tenant') return b;
  return a;
}
