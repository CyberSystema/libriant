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
  const cookie = await requestCookieHeader();
  if (!cookie) return null;
  try {
    return await api<AuthMeResponse>('/auth/me', { cookie });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}
