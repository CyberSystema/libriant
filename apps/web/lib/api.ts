/**
 * Browser + server-side fetch wrapper for the Libriant API.
 *
 * Two callers:
 *   - **Server components / route handlers** — pass an explicit cookie
 *     string (read via `next/headers` ➜ `cookies()`). The fetch runs
 *     against the API's internal address (`API_INTERNAL_URL`), which on
 *     the single-host topology is the same as the public URL but lets us
 *     hop straight to the API container in compose / Kubernetes.
 *   - **Client components** — call with no cookie; the browser ships its
 *     own session cookie automatically and the request goes through the
 *     public origin.
 *
 * Both paths produce a typed `ApiError` for non-2xx responses so callers
 * can render a single, plain-language toast / banner.
 */

export type ApiErrorBody = {
  statusCode?: number;
  error?: string;
  message?: string | string[];
  /** Some endpoints (auth, quota) tag the payload with extra context. */
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    const friendly = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    super(friendly ?? `API error (${status})`);
    this.status = status;
    this.body = body;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body. Passed through `JSON.stringify` if it's not already a string. */
  body?: unknown;
  /** Override for server-side calls. Browser code can leave this undefined. */
  cookie?: string;
  /** Per-request override of the API base URL. */
  baseUrl?: string;
  /** Add custom headers — usually not needed. */
  headers?: Record<string, string>;
  /**
   * `Cache-Control`-shaped hint forwarded to `fetch()`. Defaults to
   * `'no-store'` so authenticated pages never serve a stale tenant's data.
   */
  cache?: RequestCache;
};

function resolveBase(opts: RequestOptions): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, '');
  // Server-side: hit the API directly. In single-host dev that's also
  // localhost:3001; in production it's the container's internal name.
  if (typeof window === 'undefined') {
    return (
      process.env.API_INTERNAL_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3001'
    ).replace(/\/$/, '');
  }
  // Client-side: use the Next.js rewrite at `/lbr-api/*` so the request
  // stays same-origin with the web app and the session cookie travels
  // both directions without CORS or `SameSite` headaches.
  return '/lbr-api';
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = resolveBase(opts);
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    // Browser path needs credentials; server path uses the explicit Cookie
    // header and ignores this.
    credentials: typeof window === 'undefined' ? undefined : 'include',
    cache: opts.cache ?? 'no-store',
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  // 204 / 205 carry no body; everything else we parse.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, (parsed ?? {}) as ApiErrorBody);
  }
  return parsed as T;
}

// -- Common shapes returned by the API ---------------------------------------

export type AuthMeResponse = {
  user: {
    id: string;
    email: string | null;
    username: string | null;
    fullName: string;
    role: 'owner' | 'admin' | 'librarian' | 'volunteer';
    mustChangeCredentials: boolean;
  };
  tenant: { id: string; slug: string; name: string; defaultLocale: string };
};

export type BillingSnapshot = {
  tenantId: string;
  tenantSlug: string;
  billingMode: 'stripe' | 'manual';
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';
  plan: { id: string; slug: string; name: string };
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  paidUntil: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  driver: 'real' | 'fake';
  /** When false, plan/quota enforcement is off — all features are free. */
  billingEnabled: boolean;
  /** Whether the library has explicitly chosen a plan. When billingEnabled is
   *  true and this is false, the library is shown the forced plan chooser. */
  planSelected: boolean;
};

export type ListResponse<T> = { items: T[]; nextCursor: string | null };
