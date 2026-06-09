import { cookies } from 'next/headers';
import { ApiError, api } from './api';

/**
 * Shape of the admin profile the API returns from `/admin/auth/me`.
 * Mirrors `AdminUser` minus the bits we never want client-side.
 */
export type AdminProfile = {
  id: string;
  email: string;
  fullName: string;
  role: 'owner' | 'support';
  mfaEnabled: boolean;
};

/** Forward whatever cookies the request brought us to the API. */
export async function requestCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const all = store.getAll();
  if (!all.length) return undefined;
  return all.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Resolve the current admin session from the API. Returns `null` on
 * 401/403 (anonymous or revoked), bubbles up everything else so the page
 * can render an error state.
 */
export async function currentAdminSession(): Promise<AdminProfile | null> {
  const cookie = await requestCookieHeader();
  if (!cookie) return null;
  try {
    const res = await api<{ admin: AdminProfile }>('/admin/auth/me', { cookie });
    return res.admin;
  } catch (err) {
    // 401/403 → not signed in. 404 → the cookie points at an admin that no
    // longer exists. Both mean "show the login form", not an error page.
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}
