import { api } from './api';
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
  } catch {
    // Fail soft on EVERYTHING. An impersonation probe we couldn't complete is
    // not an impersonation, and this used to rethrow anything that wasn't a
    // 401/403 — including the 503 the maintenance middleware returns for
    // /support/impersonation/me, which is NOT on its always-pass list. That
    // rejection reached the tenant layout before it could evaluate the takeover
    // branch, so pulling the maintenance lever crashed every signed-in
    // librarian with a bare 500 instead of showing them the maintenance screen.
    return null;
  }
}
