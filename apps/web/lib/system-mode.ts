import { api } from './api';

export type SystemModeKind =
  'normal' | 'maintenance' | 'read_only' | 'out_of_order' | 'under_construction';

export type ResolvedSystemMode = {
  mode: SystemModeKind;
  source: 'global' | 'tenant' | 'default';
  eventId: string | null;
  messageMarkdown: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allowAdminBypass: boolean;
};

const OUT_OF_ORDER: ResolvedSystemMode = {
  mode: 'out_of_order',
  source: 'default',
  eventId: null,
  messageMarkdown: null,
  startsAt: null,
  endsAt: null,
  allowAdminBypass: true,
};

/**
 * Fetch the effective system mode for a given slug (or global if omitted).
 * The endpoint is anonymous + always reachable (the API's
 * SystemModeMiddleware exempts `/system-mode/*`).
 *
 * EVERY failure resolves to `out_of_order`, not just an `ApiError`. This used
 * to return `normal` for a raw fetch rejection — API process down, DNS gone,
 * connection refused, request timed out — which is the most common outage
 * shape there is and a strictly stronger signal than a 5xx: we could not reach
 * the control plane at all. Returning `normal` there sent the layout on to
 * `/auth/me`, which then threw, so the branded takeover never rendered in the
 * situation it was written for.
 */
export async function currentSystemMode(slug?: string): Promise<ResolvedSystemMode> {
  try {
    const path = slug
      ? `/system-mode/current?slug=${encodeURIComponent(slug)}`
      : '/system-mode/current';
    const res = await api<{ mode: ResolvedSystemMode }>(path);
    return res.mode;
  } catch {
    return OUT_OF_ORDER;
  }
}

export function isTakeoverMode(m: SystemModeKind): boolean {
  return m === 'maintenance' || m === 'out_of_order';
}

export function modeLabel(m: SystemModeKind): string {
  switch (m) {
    case 'maintenance':
      return 'Scheduled maintenance';
    case 'out_of_order':
      return 'Temporarily unavailable';
    case 'read_only':
      return 'Read-only mode';
    case 'under_construction':
      return 'Under construction';
    case 'normal':
      return 'Normal';
  }
}
