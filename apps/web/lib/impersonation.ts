import { ApiError, api } from './api';
import { requestCookieHeader } from './session';

export type ImpersonationSnapshot = {
  adminId: string;
  tenant: { id: string; slug: string; name: string };
  admin: { email: string; fullName: string };
  startedAt: string;
  expiresAt: string;
};

/**
 * Detect whether the current request carries an active impersonation
 * cookie. Returns the session details when yes, `null` otherwise.
 *
 * Used by the tenant layout: a Libriant admin holding an impersonation
 * cookie should be allowed into `/t/<slug>/...` even without a librarian
 * session, and should see a sticky banner reminding them they're inside
 * someone else's library.
 */
export async function currentImpersonation(): Promise<ImpersonationSnapshot | null> {
  const cookie = await requestCookieHeader();
  if (!cookie) return null;
  try {
    const res = await api<{ impersonation: ImpersonationSnapshot | null }>(
      '/support/impersonation/me',
      { cookie },
    );
    return res.impersonation;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
    throw err;
  }
}
