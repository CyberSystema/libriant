import { cookies } from 'next/headers';
import { ApiError, api, type AuthMeResponse } from './api';

const SESSION_COOKIE_CANDIDATES = ['__Host-libriant_session', 'libriant_session'] as const;

/**
 * Returns the request's cookie header verbatim so we can forward the
 * session cookie to the API on server-side calls. We don't try to be
 * clever about scrubbing other cookies — the API only inspects its own.
 */
export async function requestCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const all = store.getAll();
  if (!all.length) return undefined;
  return all.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Quick check whether the request *appears* to be authenticated by virtue
 * of carrying a session cookie. Cheap — no API roundtrip. Use it as a
 * routing hint; the API still authoritatively rejects forged cookies.
 */
export async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return SESSION_COOKIE_CANDIDATES.some((name) => Boolean(store.get(name)?.value));
}

/**
 * Resolve the current user + tenant from the API. Returns `null` for any
 * authentication failure (no cookie, expired token, revoked user). Other
 * failures bubble up as `ApiError` so the page can render an error state
 * instead of silently logging the user out.
 */
export async function currentSession(): Promise<AuthMeResponse | null> {
  // Probe only when a session cookie is actually there. `requestCookieHeader()`
  // hands back the WHOLE cookie header, so without this guard any cookie at all
  // — a consent flag, an analytics id — made /auth/me fire, and /login therefore
  // depended on the API being up for anyone who had ever visited before.
  if (!(await hasSessionCookie())) return null;
  const cookie = await requestCookieHeader();
  if (!cookie) return null;
  try {
    return await api<AuthMeResponse>('/auth/me', { cookie });
  } catch (err) {
    // 401/403 → not authenticated. 404 → the session cookie points at a user
    // or tenant that no longer exists (e.g. the library was deleted), which is
    // also just "logged out" — not a page error. Treat all three as null so
    // the visitor sees the login form instead of an error.
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      return null;
    }
    throw err;
  }
}

/**
 * `currentSession()` for pages that are worth rendering even when the API is
 * unreachable — the sign-in and sign-up cards. Both only use the session to
 * skip a form the visitor doesn't need; neither has anything to gain from
 * failing the whole render because /auth/me timed out. Swallow everything and
 * show the form: a librarian trying to sign in during an outage should at
 * least reach the field they were heading for.
 */
export async function optionalSession(): Promise<AuthMeResponse | null> {
  try {
    return await currentSession();
  } catch {
    return null;
  }
}
