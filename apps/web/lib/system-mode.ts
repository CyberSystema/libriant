import { ApiError, api } from './api';

export type SystemModeKind =
  | 'normal'
  | 'maintenance'
  | 'read_only'
  | 'out_of_order'
  | 'under_construction';

export type ResolvedSystemMode = {
  mode: SystemModeKind;
  source: 'global' | 'tenant' | 'default';
  eventId: string | null;
  messageMarkdown: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allowAdminBypass: boolean;
};

const NORMAL: ResolvedSystemMode = {
  mode: 'normal',
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
 * SystemModeMiddleware exempts `/system-mode/*`). Any failure resolves
 * to `normal` so a flaky control-plane never breaks the page render.
 */
export async function currentSystemMode(slug?: string): Promise<ResolvedSystemMode> {
  try {
    const path = slug
      ? `/system-mode/current?slug=${encodeURIComponent(slug)}`
      : '/system-mode/current';
    const res = await api<{ mode: ResolvedSystemMode }>(path);
    return res.mode;
  } catch (err) {
    if (err instanceof ApiError) {
      // Even when the maintenance middleware kicks in, /system-mode/* is
      // exempt — so a 5xx here means a real outage. Render the takeover.
      return {
        mode: 'out_of_order',
        source: 'default',
        eventId: null,
        messageMarkdown: null,
        startsAt: null,
        endsAt: null,
        allowAdminBypass: true,
      };
    }
    return NORMAL;
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
