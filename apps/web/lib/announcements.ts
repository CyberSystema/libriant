import { ApiError, api } from './api';
import { requestCookieHeader } from './session';

export type ActiveAnnouncement = {
  id: string;
  title: string;
  bodyMarkdown: string;
  severity: 'info' | 'warning' | 'critical';
  dismissible: boolean;
  requiresAck: boolean;
  publishedAt: string;
  expiresAt: string | null;
  deliveryScope: 'tenant' | 'user';
  delivery: {
    id: string;
    dismissedAt: string | null;
    acknowledgedAt: string | null;
  };
};

/**
 * Fetch the active announcement set for the current user in this tenant.
 * Always returns an array — surfaces an empty list on any non-success so
 * a flaky control-plane never breaks the page render.
 */
export async function currentAnnouncements(slug: string): Promise<ActiveAnnouncement[]> {
  const cookie = await requestCookieHeader();
  if (!cookie) return [];
  try {
    const res = await api<{ announcements: ActiveAnnouncement[] }>(
      `/t/${slug}/announcements/active`,
      { cookie },
    );
    return res.announcements;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return [];
    return [];
  }
}
